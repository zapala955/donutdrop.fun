import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager } from '../lib/cash-settlement.js';
import { hmacHex, safeEqualText } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { deterministicUuid } from '../lib/battle-engine.js';
import { announceWin } from '../lib/discord-flex.js';
import { openSideBetMarket, settleSideBetMarket } from './sidebets.js';
import { AppError } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import {
  ARENA_RADIUS,
  EXTRACT_SECONDS,
  MAX_ENTRY_MINOR,
  MIN_ENTRY_MINOR,
  TICK_HZ,
  TICK_MS,
  type Arena,
  type Snake,
  createArena,
  entryIsLegal,
  expectedMarginMinor,
  gatesAt,
  isBoosting,
  normalizeAngle,
  splitExtraction,
  spawnSnake,
  stepArena,
  sweepFloor,
  EXTRACT_TICKS,
} from '../lib/slither-engine.js';
import { SlitherHub, type ArenaOrbView, type ArenaSnakeView } from '../lib/slither-hub.js';
import type { Subscriber } from '../lib/socket-hub.js';
import { parseWith } from '../lib/validation.js';
import { ARENA_SOCKET_BUDGET, createSocketBudget } from '../lib/socket-limit.js';

/**
 * The Slither arena.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MONEY, IN ORDER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. Buy in. The stake is DEBITED immediately, a `slither_sessions` row is written, and the
 *      stake is recorded as a wager on the spot. It is at risk from the first tick, so counting it
 *      at the door is the only honest moment — a player who dies never reaches an exit that could
 *      have counted it.
 *   2. Play. No money moves through the ledger at all. Value grows and shrinks inside the
 *      simulation, and it changes hands between players there; the wallet knows nothing about it.
 *      That is not laziness, it is the point: an orb changing hands is not a transaction, it is a
 *      change in a live position.
 *   3. Exit, exactly once, one of four ways:
 *        cashed_out → value less the platform's cut is credited. The only exit the house is paid.
 *        killed     → the value is already on the floor. Nobody is credited, including the house.
 *        abandoned  → identical to killed. Leaving the pit is not a way to keep the stake.
 *        voided     → this process died holding the session. The stake comes back WHOLE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE ENTRY BAND IS NOT CONFIGURABLE, AND WHY IT IS CHECKED THREE TIMES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * $1,000,000 minimum and $100,000,000 maximum are the two ends the snake's size is interpolated
 * between, so a stake outside them has no defined shape. The figures live in slither-engine.ts,
 * are re-checked by the zod schema on the way in, and are a CHECK constraint on the table. Three
 * checks of one rule is not belt and braces for its own sake: the schema gives a 400 rather than a
 * 500, the engine keeps the simulation total, and the constraint is what survives somebody adding
 * a second way to write that row.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ARENA IS ONE PROCESS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The simulation is in memory, so a second API instance is a second, separate pit — two players on
 * different instances would buy into the same board and never see each other. A horizontally
 * scaled deployment must therefore route `/v1/slither/*` to a single instance (or lift the arena
 * into its own service). This is stated in .env.example beside the feature flag, because it is the
 * kind of constraint that is discovered at 2am otherwise.
 *
 * The orphan sweeper is the other half of that: if this process dies holding live sessions, the
 * next one to take a buy-in voids them and refunds their stakes whole, so a crash can never be
 * mistaken for a loss.
 */

/**
 * The buy-in at which a session becomes worth opening a spectator market on.
 *
 * The brief's "$50M+". Below it the pit would carry a market per snake and the board would be
 * unreadable; above it there is genuinely something to watch.
 */
const SIDE_BET_SUBJECT_FLOOR_MINOR = 50_000_000n;

/** How far a player can see. Everything beyond this is culled from their frame. */
const VIEW_RADIUS = 1500;

/** Every second trail point is sent. The client draws a smooth tube through them regardless. */
const PATH_STRIDE = 2;

/** Leaderboard depth. */
const LEADERBOARD_SIZE = 5;

/** An entry ticket is good for one minute. It is single use regardless. */
const TICKET_TTL_MS = 60_000;

const joinSchema = z.object({
  /* The band is restated here rather than only being enforced downstream so that a stake outside
   * it is a 400 with a field path, not a constraint violation surfacing as a 500. */
  entryMinor: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((value) => entryIsLegal(BigInt(value)), 'outside the arena entry band'),
});

const inputSchema = z.object({
  /** Where the player wants to point, in radians. Not where they are — they never say that. */
  heading: z.number().finite(),
  boost: z.boolean(),
  extract: z.boolean(),
});

/**
 * What an exit did.
 *
 * `claimed` is false when this call lost the race to close the row, and it is the difference
 * between an audit trail and a pile of duplicates: a kill is only evidence of anything if exactly
 * one of the paths that could have settled the death is the one that wrote it down.
 */
interface SessionOutcome {
  readonly claimed: boolean;
  readonly creditedMinor: bigint;
}

interface PendingEntry {
  readonly sessionId: string;
  readonly userId: string;
  readonly name: string;
  readonly entryMinor: bigint;
  readonly feeBps: number;
  readonly expiresAt: number;
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* the arena board is readable logged out */
    }
  };
}

export async function registerSlitherRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);
  const hub = new SlitherHub();

  const arena: Arena = createArena();
  /** sessionId -> the socket steering that snake. */
  const sockets = new Map<string, Subscriber>();
  /**
   * Sockets watching without a snake.
   *
   * They exist so the entry screen's background can be the REAL pit rather than a canned animation
   * of one, and so a side-bet market has somebody to be a market for. A spectator is sent the same
   * culled snapshot a player is, centred on whoever is carrying the most, with `you` null — so
   * there is nothing in the frame that could be mistaken for a snake they control.
   */
  const spectators = new Set<Subscriber>();
  /** Issued tickets that have not been redeemed. Cleared on redemption or expiry. */
  const pending = new Map<string, PendingEntry>();
  let loop: NodeJS.Timeout | null = null;
  let sweptOrphans = false;

  app.addHook('onClose', async () => {
    stopLoop();
    hub.close();
  });

  function assertEnabled(): void {
    if (!config.slitherArenaEnabled) {
      throw new AppError(404, 'ARENA_DISABLED', 'The arena is not switched on');
    }
  }

  /* ─────────────────────────── identity ───────────────────────────
   *
   * The public id is a keyed digest of the session id, not the session id itself. Snapshots name
   * every snake on the board, so whatever goes in them is known to every other player; the token
   * that authorises steering a snake must not be that value. */
  const publicIds = new Map<string, string>();
  function publicIdFor(sessionId: string): string {
    /* Memoised. This is called for every snake in every viewer's frame, twenty times a second —
     * forty players is sixteen hundred keyed digests a tick for an answer that cannot change. */
    const cached = publicIds.get(sessionId);
    if (cached) return cached;
    const id = hmacHex(config.dataEncryptionKey, `slither-public:${sessionId}`).slice(0, 12);
    publicIds.set(sessionId, id);
    return id;
  }

  function ticketFor(entry: PendingEntry): string {
    const signature = hmacHex(
      config.dataEncryptionKey,
      `slither-ticket:${entry.sessionId}:${entry.userId}:${entry.expiresAt}`,
    );
    return `${entry.sessionId}.${entry.expiresAt}.${signature}`;
  }

  /* ─────────────────────────── settlement ─────────────────────────── */

  /**
   * Ends a session exactly once and pays whoever is owed.
   *
   * Guarded by `status = 'alive'` inside the UPDATE, because an exit can be reached from a kill, a
   * cashout, a disconnect and the orphan sweeper, and those can race. The WHERE clause is what
   * makes a double payment impossible — not the callers remembering to check first.
   */
  async function endSession(
    sessionId: string,
    status: 'cashed_out' | 'killed' | 'abandoned',
    grossMinor: bigint,
    feeBps: number,
    kills: number,
    peakMinor: bigint,
  ): Promise<SessionOutcome> {
    const paysOut = status === 'cashed_out';
    const split = paysOut
      ? splitExtraction(grossMinor, feeBps)
      : { grossMinor, feeMinor: 0n, creditedMinor: 0n };
    /* A death records the value that hit the floor as `final_value_minor` and credits nothing:
     * the money is not gone, it is on the floor in somebody else's hands, and the row says so. */
    const finalMinor = paysOut ? split.grossMinor : grossMinor;

    return db.transaction(async (client) => {
      const claimed = await client.query(
        `UPDATE slither_sessions
            SET status = $2, ended_at = now(), final_value_minor = $3,
                fee_minor = $4, credited_minor = $5, kills = $6,
                peak_value_minor = GREATEST(peak_value_minor, $7)
          WHERE id = $1 AND status = 'alive'`,
        [
          sessionId,
          status,
          finalMinor.toString(),
          split.feeMinor.toString(),
          split.creditedMinor.toString(),
          kills,
          peakMinor.toString(),
        ],
      );
      // Somebody else ended it first — the expiry timer, the sweeper, or a racing exit path.
      if (claimed.rowCount === 0) return { claimed: false, creditedMinor: 0n };
      if (split.creditedMinor > 0n) {
        await creditWallet(
          client,
          await userIdFor(client, sessionId),
          split.creditedMinor,
          'slither_cashout',
          deterministicUuid('slither_cashout', sessionId),
        );
      }
      return { claimed: true, creditedMinor: split.creditedMinor };
    });
  }

  async function userIdFor(client: DbClient, sessionId: string): Promise<string> {
    const result = await client.query<{ user_id: string }>(
      'SELECT user_id FROM slither_sessions WHERE id = $1',
      [sessionId],
    );
    const userId = result.rows[0]?.user_id;
    if (!userId) throw new Error('Arena session vanished mid-settlement');
    return userId;
  }

  /**
   * Hands a buy-in back whole.
   *
   * The one exit the player did not choose, so the one exit that cannot cost them anything: no cut
   * is taken and no value is spilled. Used when a paid-for snake never reached the board, and by
   * the orphan sweeper when a previous process died holding live sessions.
   */
  async function voidSession(sessionId: string, entryMinor: bigint): Promise<void> {
    await db.transaction(async (client) => {
      const claimed = await client.query(
        `UPDATE slither_sessions
            SET status = 'voided', ended_at = now(), final_value_minor = entry_minor,
                fee_minor = 0, credited_minor = entry_minor
          WHERE id = $1 AND status = 'alive'`,
        [sessionId],
      );
      if (claimed.rowCount === 0) return;
      await creditWallet(
        client,
        await userIdFor(client, sessionId),
        entryMinor,
        'slither_refund',
        deterministicUuid('slither_refund', sessionId),
      );
    });
  }

  async function recordKill(
    victimSessionId: string,
    killerSessionId: string | null,
    droppedMinor: bigint,
  ): Promise<void> {
    await db.query(
      `INSERT INTO slither_kills (id, victim_session_id, killer_session_id, dropped_minor)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), victimSessionId, killerSessionId, droppedMinor.toString()],
    );
  }

  /**
   * Refunds every session this process found already 'alive' — that is, every session a previous
   * process was holding when it died.
   *
   * Run lazily, before the first buy-in, rather than at boot: a route that queries the database on
   * registration turns every unrelated test and every cold start into a database dependency. The
   * first buy-in is already a database call, so there is nothing to save by being earlier and a
   * great deal to lose.
   */
  async function sweepOrphanedSessions(): Promise<void> {
    if (sweptOrphans) return;
    sweptOrphans = true;
    try {
      await db.transaction(async (client) => {
        const orphans = await client.query<{ id: string; user_id: string; entry_minor: string }>(
          `UPDATE slither_sessions
              SET status = 'voided', ended_at = now(), final_value_minor = entry_minor,
                  fee_minor = 0, credited_minor = entry_minor
            WHERE status = 'alive'
          RETURNING id, user_id, entry_minor`,
        );
        for (const orphan of orphans.rows) {
          await creditWallet(
            client,
            orphan.user_id,
            BigInt(orphan.entry_minor),
            'slither_refund',
            deterministicUuid('slither_refund', orphan.id),
          );
        }
        if (orphans.rowCount) {
          app.log.warn({ voided: orphans.rowCount }, 'refunded orphaned arena sessions');
        }
      });
    } catch (error) {
      // A failed sweep must not stop players buying in. It is retried on the next process start.
      sweptOrphans = false;
      app.log.error({ error }, 'arena orphan sweep failed');
    }
  }

  /* ─────────────────────────── the loop ─────────────────────────── */

  function startLoop(): void {
    if (loop) return;
    loop = setInterval(() => {
      try {
        tick();
      } catch (error) {
        app.log.error({ error }, 'arena tick failed');
      }
    }, TICK_MS);
    loop.unref?.();
  }

  function stopLoop(): void {
    if (!loop) return;
    clearInterval(loop);
    loop = null;
  }

  function tick(): void {
    for (const snake of arena.snakes.values()) snake.silentTicks += 1;

    const events = stepArena(arena);

    for (const kill of events.kills) {
      const victim = arena.snakes.get(kill.victimSessionId);
      hub.broadcastLobby({
        type: 'arena:hit',
        victim: publicIdFor(kill.victimSessionId),
        killer: kill.killerSessionId ? publicIdFor(kill.killerSessionId) : null,
        droppedMinor: kill.droppedMinor.toString(),
      });
      const socket = sockets.get(kill.victimSessionId);
      if (socket) {
        hub.send(socket, {
          type: 'arena:over',
          reason:
            kill.cause === 'wall' ? 'wall' : kill.cause === 'abandoned' ? 'abandoned' : 'killed',
          creditedMinor: '0',
        });
      }
      /* The killer's tally is NOT written here. Their session row is still open, and the count
       * rides out with their own exit — a live position is not a thing to be updated from the
       * side. The kill itself is recorded immediately, because that is evidence. */
      const status = kill.cause === 'abandoned' ? 'abandoned' : 'killed';
      void endSession(
        kill.victimSessionId,
        status,
        kill.droppedMinor,
        victim?.feeBps ?? 0,
        victim?.kills ?? 0,
        victim?.peakMinor ?? kill.droppedMinor,
      )
        .then(async (outcome) => {
          if (!outcome.claimed) return;
          await recordKill(kill.victimSessionId, kill.killerSessionId, kill.droppedMinor);
          /* The market on this snake resolves the moment the snake does, and to the same fact the
           * session row records. There is no endpoint that can settle one to anything else. */
          await settleSideBetMarket(db, 'slither', kill.victimSessionId, 'WIPEOUT');
        })
        .catch((error: unknown) => app.log.error({ error }, 'arena death settlement failed'));
      release(kill.victimSessionId);
    }

    for (const cashout of events.cashouts) {
      const snake = arena.snakes.get(cashout.sessionId);
      if (!snake) continue;
      const socket = sockets.get(cashout.sessionId);
      void endSession(
        cashout.sessionId,
        'cashed_out',
        cashout.grossMinor,
        snake.feeBps,
        snake.kills,
        snake.peakMinor,
      )
        .then((outcome) => {
          if (!outcome.claimed) return;
          const credited = outcome.creditedMinor.toString();
          hub.broadcastLobby({
            type: 'arena:cashout',
            id: publicIdFor(cashout.sessionId),
            name: snake.name,
            creditedMinor: credited,
          });
          if (socket) {
            hub.send(socket, { type: 'arena:over', reason: 'cashed_out', creditedMinor: credited });
          }
          /* Post-settlement and deliberately not awaited: the player has their money, and a slow
           * third party must not hold the tick loop. `announceWin` throws nothing. */
          void settleSideBetMarket(db, 'slither', cashout.sessionId, 'EXTRACT').catch(
            (error: unknown) => app.log.error({ error }, 'side bet settlement failed'),
          );
          void announceWin(
            config,
            {
              username: snake.name,
              amountMinor: outcome.creditedMinor,
              mode: 'Slither Arena',
              multiplier:
                snake.entryMinor > 0n
                  ? Number(outcome.creditedMinor) / Number(snake.entryMinor)
                  : 1,
              path: '#/slither',
            },
            app.log,
          );
        })
        .catch((error: unknown) => app.log.error({ error }, 'arena cashout settlement failed'));
      release(cashout.sessionId);
    }

    if (events.leakedMinor !== 0n) {
      /* The floor merges rather than expires, so this is structurally unreachable. It is logged
       * rather than ignored because "structurally unreachable" is a claim, and a claim about money
       * that nothing checks is a claim that stops being true quietly. */
      app.log.error({ leakedMinor: events.leakedMinor.toString() }, 'arena leaked value');
    }

    broadcastState();

    /* Spectators hold the loop open. Stopping it with an empty pit would freeze the entry screen's
     * background on whatever frame the last player died in. */
    if (arena.snakes.size === 0 && spectators.size === 0) {
      /* Nobody is left, so nothing on the floor can ever be reached. Sweeping it is what keeps the
       * arithmetic closed: the value is recorded as platform revenue rather than quietly ceasing
       * to exist in a mode whose whole claim is that value is conserved. */
      const swept = sweepFloor(arena);
      if (swept > 0n) app.log.info({ sweptMinor: swept.toString() }, 'arena floor swept');
      stopLoop();
    }
  }

  /** Takes a snake off the board and forgets its socket binding. */
  function release(sessionId: string): void {
    arena.snakes.delete(sessionId);
    sockets.delete(sessionId);
    // The memo is per session and a session ends exactly once, so this is the only place it can be
    // dropped without the map growing for the life of the process.
    publicIds.delete(sessionId);
  }

  /* ─────────────────────────── frames ─────────────────────────── */

  function leaderboard(viewerSessionId: string | null) {
    return [...arena.snakes.values()]
      .filter((snake) => snake.alive)
      .sort((left, right) => {
        if (left.valueMinor === right.valueMinor) return 0;
        return right.valueMinor > left.valueMinor ? 1 : -1;
      })
      .slice(0, LEADERBOARD_SIZE)
      .map((snake) => ({
        name: snake.name,
        valueMinor: snake.valueMinor.toString(),
        /* Carrying at least what they paid to get in. It reads as "this one can walk away up",
         * which in a pit is simultaneously the most useful thing to know about a rival and the
         * most dangerous thing to have said about you. */
        extractable: snake.valueMinor >= snake.entryMinor,
        isYou: snake.sessionId === viewerSessionId,
      }));
  }

  /**
   * One snake, culled to a viewer's circle and split at every gap.
   *
   * Returns null when nothing of the snake is visible, so an invisible player costs a nearby
   * comparison and nothing else.
   */
  function snakeView(snake: Snake, viewer: Snake | null): ArenaSnakeView | null {
    const runs: number[][] = [];
    let run: number[] = [];
    const limit = VIEW_RADIUS + snake.shape.radius + 80;
    for (let index = 0; index < snake.trail.length; index += PATH_STRIDE) {
      const x = snake.trail.x(index);
      const y = snake.trail.y(index);
      const visible = !viewer || Math.hypot(x - viewer.x, y - viewer.y) <= limit;
      if (visible) {
        run.push(Math.round(x), Math.round(y));
      } else if (run.length >= 4) {
        runs.push(run);
        run = [];
      } else {
        run = [];
      }
    }
    if (run.length >= 4) runs.push(run);
    if (runs.length === 0) return null;

    return {
      id: publicIdFor(snake.sessionId),
      name: snake.name,
      paths: runs,
      radius: Math.round(snake.shape.radius * 10) / 10,
      aura: Math.round(snake.shape.aura * 100) / 100,
      valueMinor: snake.valueMinor.toString(),
      boosting: isBoosting(snake),
      extracting: Math.min(1, snake.extractTicks / EXTRACT_TICKS),
      isYou: viewer === snake,
    };
  }

  function orbViews(viewer: Snake): ArenaOrbView[] {
    const views: ArenaOrbView[] = [];
    for (const orb of arena.orbs.values()) {
      if (Math.hypot(orb.x - viewer.x, orb.y - viewer.y) > VIEW_RADIUS + 60) continue;
      views.push({
        id: orb.id,
        x: Math.round(orb.x),
        y: Math.round(orb.y),
        valueMinor: orb.valueMinor.toString(),
        kind: orb.kind,
      });
    }
    return views;
  }

  /** Whoever is carrying the most. The spectator camera follows them, because they are the story. */
  function leadSnake(): Snake | null {
    let best: Snake | null = null;
    for (const snake of arena.snakes.values()) {
      if (!snake.alive) continue;
      if (!best || snake.valueMinor > best.valueMinor) best = snake;
    }
    return best;
  }

  function broadcastState(): void {
    if (sockets.size === 0 && spectators.size === 0) return;
    const gates = gatesAt(arena.tick).map((gate) => Math.round(gate.angle * 1000) / 1000);

    for (const [sessionId, subscriber] of sockets) {
      const viewer = arena.snakes.get(sessionId);
      if (!viewer) continue;
      const others: ArenaSnakeView[] = [];
      for (const snake of arena.snakes.values()) {
        if (snake === viewer || !snake.alive) continue;
        const view = snakeView(snake, viewer);
        if (view) others.push(view);
      }
      hub.send(subscriber, {
        type: 'arena:state',
        tick: arena.tick,
        you: snakeView(viewer, viewer),
        snakes: others,
        orbs: orbViews(viewer),
        gates,
        leaders: leaderboard(sessionId),
        players: arena.snakes.size,
      });
    }

    if (spectators.size === 0) return;
    /* One frame, built once and sent to every spectator. They all watch the same thing, so building
     * it per socket would be the same work repeated for no difference in the result. */
    const lead = leadSnake();
    const snakes: ArenaSnakeView[] = [];
    if (lead) {
      for (const snake of arena.snakes.values()) {
        if (!snake.alive) continue;
        const view = snakeView(snake, lead);
        if (view) snakes.push({ ...view, isYou: false });
      }
    }
    const frame = {
      type: 'arena:state' as const,
      tick: arena.tick,
      /* Null, always. A spectator has no snake and must not be handed anything shaped like one. */
      you: null,
      snakes,
      orbs: lead ? orbViews(lead) : [],
      gates,
      leaders: leaderboard(null),
      players: arena.snakes.size,
      /* Where to point the camera when there is nobody to follow. */
      focus: lead ? [Math.round(lead.x), Math.round(lead.y)] : [0, 0],
    };
    for (const subscriber of spectators) hub.send(subscriber, frame);
  }

  /* ─────────────────────────── reads ─────────────────────────── */

  /**
   * The lobby payload.
   *
   * Note what is NOT in it: there is no fee, no rate, and no split. The platform's cut is applied
   * on the server at the moment of extraction and the client is handed cash figures — an entry
   * band, a live board, and what people are carrying. A percentage on a lobby screen is a number
   * nobody can act on and everybody re-reads.
   */
  app.get('/v1/slither', { preHandler: softAuth }, async (request) => {
    assertEnabled();
    const viewerId = request.authUser?.id ?? null;
    const live = viewerId
      ? await db.query<{ id: string }>(
          `SELECT id FROM slither_sessions WHERE user_id = $1 AND status = 'alive'`,
          [viewerId],
        )
      : { rows: [] as { id: string }[] };

    return {
      minEntryMinor: MIN_ENTRY_MINOR.toString(),
      maxEntryMinor: MAX_ENTRY_MINOR.toString(),
      /* The five buttons on the entry modal, bounded by the band at both ends. */
      presets: ['1000000', '10000000', '25000000', '50000000', '100000000'],
      arenaRadius: ARENA_RADIUS,
      tickHz: TICK_HZ,
      extractSeconds: EXTRACT_SECONDS,
      maxPlayers: config.slitherMaxPlayers,
      players: arena.snakes.size,
      leaders: leaderboard(null),
      /** Set when this player is already on the board — a reload drops them back into it. */
      liveSessionId: live.rows[0]?.id ?? null,
    };
  });

  /* ─────────────────────────── buy in ─────────────────────────── */

  app.post(
    '/v1/slither/join',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
      if (arena.snakes.size >= config.slitherMaxPlayers) {
        throw new AppError(409, 'ARENA_FULL', 'The arena is full');
      }
      await sweepOrphanedSessions();

      const { entryMinor } = parseWith(joinSchema, request.body);
      const entry = BigInt(entryMinor);
      /* Restated against the engine rather than trusted from the schema. The schema is a request
       * contract and can be edited by anyone adding a field; this is the rule. */
      if (!entryIsLegal(entry)) {
        throw new AppError(400, 'ENTRY_OUT_OF_BAND', 'That buy-in is outside the arena limits');
      }
      const feeBps = config.slitherCashoutFeeBps;
      const sessionId = randomUUID();

      const name = await db.transaction(async (client) => {
        await assertGameEligible(client, config, userId);

        /* The debit and the balance check are ONE statement with the guard in the WHERE clause.
         * A read-then-write here is the classic way to let a player stake money they do not have,
         * and two tabs buying in at once is not a hypothetical on a page with a big gold button. */
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 AND balance_minor >= $2
            RETURNING balance_minor`,
          [userId, entry.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) {
          throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Not enough balance for that buy-in');
        }
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'slither_stake', $5)`,
          [
            randomUUID(),
            userId,
            (-entry).toString(),
            balanceAfter,
            deterministicUuid('slither_stake', sessionId),
          ],
        );

        /* `slither_one_live_session_idx` is what makes a second live snake per account impossible
         * rather than merely unlikely. Two buy-ins racing each other both debit, and exactly one
         * gets a row; the loser's transaction rolls back and the debit goes with it. */
        try {
          await client.query(
            `INSERT INTO slither_sessions
               (id, user_id, entry_minor, fee_bps, status, peak_value_minor)
             VALUES ($1, $2, $3, $4, 'alive', $3)`,
            [sessionId, userId, entry.toString(), feeBps],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new AppError(409, 'ALREADY_IN_ARENA', 'You already have a snake in the pit');
          }
          throw error;
        }

        /* The buy-in is a wager the moment it is taken — see the header. `marginMinor` is passed
         * explicitly because this mode charges no edge on play at all; deriving it from
         * HOUSE_EDGE_BPS would hand rakeback and the referral share a margin the house never
         * collected, on every session. */
        await recordWager(
          client,
          config,
          userId,
          entry,
          'slither_arena',
          deterministicUuid('slither_wager', sessionId),
          ['wagered_minor'],
          expectedMarginMinor(entry, feeBps),
        );

        const named = await client.query<{ minecraft_username: string | null }>(
          'SELECT minecraft_username FROM users WHERE id = $1',
          [userId],
        );
        return named.rows[0]?.minecraft_username ?? 'Player';
      });

      const ticketEntry: PendingEntry = {
        sessionId,
        userId,
        name,
        entryMinor: entry,
        feeBps,
        expiresAt: Date.now() + TICKET_TTL_MS,
      };
      pending.set(sessionId, ticketEntry);
      /* A ticket that is never redeemed is a paid-for snake that never appeared, so it is voided
       * and refunded on the same timer that expires it. */
      setTimeout(() => {
        if (!pending.delete(sessionId)) return;
        /* Voided, not abandoned. They paid and never got a snake — there was no position to lose
         * and nothing hit the floor, so the stake comes back whole. Settling this as a death would
         * charge a player for a socket that never opened. */
        void voidSession(sessionId, entry).catch((error: unknown) =>
          app.log.error({ error }, 'unredeemed arena ticket cleanup failed'),
        );
      }, TICKET_TTL_MS).unref?.();

      return {
        sessionId,
        ticket: ticketFor(ticketEntry),
        entryMinor: entry.toString(),
        arenaRadius: ARENA_RADIUS,
        tickHz: TICK_HZ,
        extractSeconds: EXTRACT_SECONDS,
      };
    },
  );

  /* ─────────────────────────── the socket ───────────────────────────
   *
   * WHY ENTRY IS A TICKET AND NOT THE SESSION COOKIE.
   *
   * A WebSocket handshake is not subject to the same-origin policy and carries cookies anyway, so
   * a socket authenticated by cookie alone is one any page on the internet can open on a logged-in
   * player's behalf — cross-site WebSocket hijacking, and in this mode it would let that page
   * steer somebody's money into a wall. The buy-in is a CSRF-guarded POST that returns a
   * short-lived keyed ticket, and the socket is authenticated by presenting it. A cross-origin page
   * cannot obtain one, because it cannot read the response to the POST that mints it.
   */
  app.get('/v1/slither/live', { websocket: true }, (socket) => {
    const subscriber = hub.add(socket, null);
    let bound: string | null = null;
    /* One token bucket per connection. `spectate` needs no ticket and no account, so this socket
     * can be opened by anyone on the internet — which makes an unmetered frame handler a JSON
     * parser an anonymous caller can drive as fast as their uplink allows. The HTTP rate limiter
     * counts the handshake once and never sees a frame. */
    const budget = createSocketBudget(ARENA_SOCKET_BUDGET);

    socket.on('message', (raw: Buffer) => {
      if (!config.slitherArenaEnabled) return;
      /* Dropped in silence. Answering a flood with an error frame doubles the traffic and turns
       * the server into an amplifier aimed at itself. */
      if (!budget.take()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        hub.send(subscriber, { type: 'error', message: 'Malformed frame' });
        return;
      }
      if (typeof frame !== 'object' || frame === null) return;
      const message = frame as { type?: unknown; ticket?: unknown };

      if (message.type === 'ping') {
        hub.send(subscriber, { type: 'pong', now: Date.now() });
        return;
      }

      /* Watching needs no ticket and no account: the pit is public, and what a spectator is sent is
       * the same culled snapshot everybody else gets. It carries no session id and no `you`, so
       * there is nothing in it to steer and nothing to settle. */
      if (message.type === 'spectate') {
        if (bound) return;
        spectators.add(subscriber);
        /* The loop is normally started by somebody entering. A spectator arriving at an empty pit
         * still needs frames, or the entry screen behind the wager card is a black rectangle. */
        startLoop();
        return;
      }
      if (message.type === 'unspectate') {
        spectators.delete(subscriber);
        return;
      }

      if (message.type === 'enter') {
        if (bound) return;
        if (typeof message.ticket !== 'string' || message.ticket.length > 256) {
          hub.send(subscriber, { type: 'error', message: 'Bad ticket' });
          return;
        }
        const entered = redeem(message.ticket, subscriber);
        if (!entered) {
          hub.send(subscriber, { type: 'error', message: 'That entry ticket is not valid' });
          return;
        }
        bound = entered.sessionId;
        hub.send(subscriber, {
          type: 'arena:entered',
          sessionId: entered.sessionId,
          publicId: publicIdFor(entered.sessionId),
          entryMinor: entered.entryMinor.toString(),
          arenaRadius: ARENA_RADIUS,
          tickHz: TICK_HZ,
          extractSeconds: EXTRACT_SECONDS,
        });
        return;
      }

      if (message.type === 'input' && bound) {
        const snake = arena.snakes.get(bound);
        if (!snake) return;
        const parsed = inputSchema.safeParse(frame);
        if (!parsed.success) return;
        snake.wantHeading = normalizeAngle(parsed.data.heading);
        snake.wantBoost = parsed.data.boost;
        snake.wantExtract = parsed.data.extract;
        /* The only thing an input frame proves is that the player is still there. It never moves
         * anything: the tick does that, from the heading, at the server's own rate. */
        snake.silentTicks = 0;
      }
    });

    socket.on('close', () => {
      /* A flood leaves a trace even though each refusal is silent, so an operator can tell the
       * difference between a quiet socket and one that was being held at the limit. */
      if (budget.refused > 0) {
        app.log.warn({ refused: budget.refused, bound }, 'arena socket exceeded its frame budget');
      }
      hub.remove(subscriber);
      spectators.delete(subscriber);
      if (!bound) return;
      sockets.delete(bound);
      /* The snake stays on the board. A disconnect is not an exit — if closing the tab took the
       * snake off the floor with its value intact, every losing position on the platform would end
       * in a pulled network cable. It goes silent, and the grace period in the engine turns it
       * into an ordinary death with an ordinary spill. */
    });
  });

  function redeem(ticket: string, subscriber: Subscriber): PendingEntry | null {
    const parts = ticket.split('.');
    if (parts.length !== 3) return null;
    const [sessionId, expiresAt] = parts as [string, string, string];
    const entry = pending.get(sessionId);
    if (!entry) return null;
    /* Constant time, and over the WHOLE ticket rather than the signature alone: comparing the
     * reconstruction to what arrived is what makes a tampered expiry as fatal as a forged MAC. */
    if (!safeEqualText(ticketFor(entry), ticket)) return null;
    if (Number(expiresAt) < Date.now()) {
      pending.delete(sessionId);
      return null;
    }
    // Single use: a redeemed ticket cannot spawn a second snake on the same paid-for session.
    pending.delete(sessionId);

    if (arena.snakes.size >= config.slitherMaxPlayers) return null;
    spawnSnake(arena, {
      sessionId: entry.sessionId,
      userId: entry.userId,
      name: entry.name,
      entryMinor: entry.entryMinor,
      feeBps: entry.feeBps,
    });
    sockets.set(sessionId, subscriber);
    startLoop();
    /* A market on whether this snake gets out with the money. Only above the configured floor —
     * every buy-in producing a market would bury the interesting ones, and a $1M snake is not a
     * spectacle anybody is going to bet on. Fire-and-forget: a market failing to open must not
     * stop a player who has already paid from entering the pit. */
    if (entry.entryMinor >= SIDE_BET_SUBJECT_FLOOR_MINOR) {
      void openSideBetMarket(db, config, {
        kind: 'slither',
        subjectRef: entry.sessionId,
        outcomeA: 'EXTRACT',
        outcomeB: 'WIPEOUT',
      }).catch((error: unknown) => app.log.error({ error }, 'side bet market open failed'));
    }
    return entry;
  }
}
