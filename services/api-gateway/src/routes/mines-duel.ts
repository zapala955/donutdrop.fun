import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { battleCodeFrom, deterministicUuid } from '../lib/battle-engine.js';
import { creditWallet, recordWager } from '../lib/cash-settlement.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { duelMarginPerPlayer, splitPot } from '../lib/duel-engine.js';
import { AppError } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { publishLiveSoon } from '../lib/live-events.js';
import { maskedName } from '../lib/masked-name.js';
import {
  DUEL_MAX_MINES,
  DUEL_MIN_MINES,
  DUEL_MINE_OPTIONS,
  DUEL_TILES,
  decide,
  duelMinePositions,
  isMine,
  maskOf,
  minesOfMask,
  safeCount,
  safeTiles,
  scoreOf,
  type DuelOutcome,
  type PlayerState,
} from '../lib/mines-duel.js';
import { parseWith } from '../lib/validation.js';

/**
 * Mines Duel — two players, one hidden field, one pot.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MONEY, IN ORDER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. The host opens a game. Their stake is DEBITED immediately and the game holds it, for the
 *      same reason a coinflip does: a game that promises a stake it has not taken can be joined
 *      against an empty wallet.
 *   2. An opponent takes it. In ONE transaction their stake is debited, the field is dealt from
 *      the seeds, and the clock starts. Nothing is paid yet: both players are now turning tiles.
 *   3. The game settles in ONE transaction, from whichever of these comes first: both players have
 *      finished, or the clock runs out (anybody still turning tiles is locked in where they
 *      stand). The winner is credited the pot less the rake, or on equal scores both stakes are
 *      refunded whole and nothing is charged or counted.
 *   4. A game nobody takes is refunded whole -- by the host's cancel or by the sweeper after the
 *      TTL.
 *
 * EVERY exit from "open" and from "playing" is a guarded UPDATE (`WHERE status = ...`) paired with
 * a ledger credit whose reference is derived from the game id, so a cancel and a sweep, or a
 * player's last tile and the sweeper, racing each other cannot both pay. The sweeper runs whether
 * or not the game is switched on: a game already in play must finish and pay either way.
 *
 * Both stakes become wagers (quests, VIP, rakeback, referrals, the faction war) only when a game
 * is DECIDED, at half the rake each, exactly as a coinflip's are. A draw is a refund of money that
 * never moved, so it counts for nothing: otherwise two accounts could draw on purpose all day and
 * farm wagered volume at no cost at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A PLAYER CAN LEARN, AND WHEN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The field exists only server-side until the game settles. While it is running each player is
 * told the result of their OWN tiles and nothing about the other's beyond "has finished" -- never
 * how they finished, which would let the slower player simply beat a score they could see, or lock
 * in at one tile against an opponent they knew had hit TNT. Both fields, both runs and the seeds
 * are published together, once, when the game is over.
 */

/** A player may only be in so many games at once, open or running. */
const MAX_ACTIVE_GAMES_PER_USER = 3;

/** How many finished duels the strip under the board shows. */
const RECENT_DUELS = 12;

const codeParams = z.object({ code: z.string().regex(/^[A-Z0-9]{6,12}$/) });
const clientSeedSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const createSchema = z.object({
  stakeMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  mines: z.number().int().min(DUEL_MIN_MINES).max(DUEL_MAX_MINES).default(DUEL_MINE_OPTIONS[1]!),
  clientSeed: clientSeedSchema.optional(),
});

const joinSchema = z.object({ clientSeed: clientSeedSchema.optional() });
const pickSchema = z.object({
  tile: z
    .number()
    .int()
    .min(0)
    .max(DUEL_TILES - 1),
});

type Role = 'host' | 'opponent';

/** One tile a player turned, and what it was. Only ever sent to the player who turned it. */
interface TurnedTile {
  tile: number;
  mine: boolean;
}

interface RunView {
  state: PlayerState;
  score: number | null;
  picks: TurnedTile[];
}

/** What one reader is allowed to know about a game. See gameView for who gets which fields. */
interface GameView {
  code: string;
  status: GameRow['status'];
  stakeMinor: string;
  rakeBps: number;
  potMinor: string;
  rakeMinor: string;
  payoutMinor: string;
  mines: number;
  tiles: number;
  playSeconds: number;
  host: { name: string | null; isYou: boolean };
  opponent: { name: string | null; isYou: boolean } | null;
  serverSeedHash: string;
  createdAt: string;
  expiresAt: string;
  startedAt: string | null;
  deadlineAt: string | null;
  serverNow: string;
  /** The reader's own run, once the game is under way and they are in it. */
  you: (Omit<RunView, 'score'> & { role: Role; safe: number }) | null;
  /** Whether the OTHER player's run is over -- and nothing about how it ended. */
  opponentFinished: boolean | null;
  outcome: DuelOutcome | null;
  winner: 'host' | 'opponent' | null;
  youWon: boolean;
  settledAt: string | null;
  /** Both runs, the field and the seeds: present only once the game has settled. */
  result: {
    mines: number[];
    host: RunView;
    opponent: RunView;
    serverSeed: string | null;
    hostClientSeed: string;
    opponentClientSeed: string | null;
  } | null;
}

interface GameRow {
  id: string;
  code: string;
  host_user_id: string;
  opponent_user_id: string | null;
  stake_minor: string;
  rake_bps: number;
  play_seconds: number;
  mine_count: number;
  status: 'open' | 'playing' | 'settled' | 'cancelled';
  server_seed_hash: string;
  server_seed_ciphertext: string;
  server_seed_reveal: string | null;
  host_client_seed: string;
  opponent_client_seed: string | null;
  mine_mask: number | null;
  host_picks: number[] | null;
  opponent_picks: number[] | null;
  host_state: PlayerState;
  opponent_state: PlayerState;
  host_score: number | null;
  opponent_score: number | null;
  outcome: DuelOutcome | null;
  winner_user_id: string | null;
  pot_minor: string | null;
  rake_minor: string | null;
  payout_minor: string | null;
  created_at: Date;
  expires_at: Date;
  started_at: Date | null;
  deadline_at: Date | null;
  settled_at: Date | null;
  host_name: string | null;
  opponent_name: string | null;
  /** The database's clock at the moment the row was read, so no decision rests on the browser's. */
  db_now: Date;
}

/* The columns each side owns. Fixed strings, never request input: they are spliced into SQL. */
const COLUMNS = {
  host: {
    picks: 'host_picks',
    state: 'host_state',
    score: 'host_score',
    finished: 'host_finished_at',
  },
  opponent: {
    picks: 'opponent_picks',
    state: 'opponent_state',
    score: 'opponent_score',
    finished: 'opponent_finished_at',
  },
} as const;

const picksOf = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((tile) => Number(tile)) : [];

function sideOf(row: GameRow, role: Role): { picks: number[]; state: PlayerState } {
  return role === 'host'
    ? { picks: picksOf(row.host_picks), state: row.host_state }
    : { picks: picksOf(row.opponent_picks), state: row.opponent_state };
}

function roleOf(row: GameRow, userId: string | null): Role | null {
  if (!userId) return null;
  if (row.host_user_id === userId) return 'host';
  if (row.opponent_user_id === userId) return 'opponent';
  return null;
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* the board is readable logged out */
    }
  };
}

export async function registerMinesDuelRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  /* Opening and taking games is what the switch closes. A game already in play is never cut off by
   * it: its players can finish and it settles and pays like any other. */
  function assertEnabled(): void {
    if (!config.minesDuelEnabled) {
      throw new AppError(404, 'MINES_DUEL_DISABLED', 'Mines Duel is not switched on');
    }
  }

  /* ─────────────────────────── shared readers ─────────────────────────── */

  /* Both players are named to anyone who opens the board, so both are masked in the query -- the
   * same treatment as the duel, battle and coinflip lobbies. See lib/masked-name.ts. */
  const SELECT_GAME = `
    SELECT g.*,
           ${maskedName('h.minecraft_username')} AS host_name,
           ${maskedName('o.minecraft_username')} AS opponent_name,
           clock_timestamp() AS db_now
      FROM mines_duel_games g
      JOIN users h ON h.id = g.host_user_id
      LEFT JOIN users o ON o.id = g.opponent_user_id`;

  async function readGame(client: DbClient, code: string): Promise<GameRow | null> {
    const result = await client.query<GameRow>(`${SELECT_GAME} WHERE g.code = $1`, [code]);
    return result.rows[0] ?? null;
  }

  async function lockGame(client: DbClient, code: string): Promise<GameRow | null> {
    const result = await client.query<GameRow>(`${SELECT_GAME} WHERE g.code = $1 FOR UPDATE OF g`, [
      code,
    ]);
    return result.rows[0] ?? null;
  }

  const pickViews = (picks: number[], mask: number): TurnedTile[] =>
    picks.map((tile) => ({ tile, mine: isMine(mask, tile) }));

  /**
   * The shape of a game for one reader.
   *
   * Which fields exist depends on who is asking and how far the game has got, and that is the
   * whole of the secrecy: a player in a running game gets their own tiles and a "finished" flag for
   * the other side; the field, both runs, the scores and the seeds appear only once it has settled.
   */
  function gameView(row: GameRow, viewerId: string | null): GameView {
    const money = splitPot(BigInt(row.stake_minor), row.rake_bps);
    const role = roleOf(row, viewerId);
    const mask = row.mine_mask;
    const view: GameView = {
      code: row.code,
      status: row.status,
      stakeMinor: row.stake_minor,
      rakeBps: row.rake_bps,
      potMinor: money.potMinor.toString(),
      rakeMinor: money.rakeMinor.toString(),
      // What a winner would be paid; the figure quoted before anybody stakes.
      payoutMinor: money.payoutMinor.toString(),
      mines: row.mine_count,
      tiles: DUEL_TILES,
      playSeconds: row.play_seconds,
      host: { name: row.host_name, isYou: role === 'host' },
      opponent: row.opponent_user_id
        ? { name: row.opponent_name, isYou: role === 'opponent' }
        : null,
      serverSeedHash: row.server_seed_hash,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      deadlineAt: row.deadline_at?.toISOString() ?? null,
      serverNow: row.db_now.toISOString(),
      you: null,
      opponentFinished: null,
      outcome: null,
      winner: null,
      youWon: false,
      settledAt: null,
      result: null,
    };

    if (role && mask !== null && (row.status === 'playing' || row.status === 'settled')) {
      const own = sideOf(row, role);
      const other = sideOf(row, role === 'host' ? 'opponent' : 'host');
      view.you = {
        role,
        state: own.state,
        picks: pickViews(own.picks, mask),
        safe: safeCount(own.picks, mask),
      };
      if (row.status === 'playing') view.opponentFinished = other.state !== 'playing';
    }

    if (row.status === 'settled' && mask !== null && row.outcome) {
      view.outcome = row.outcome;
      view.winner = row.outcome === 'draw' ? null : row.outcome;
      view.youWon =
        row.winner_user_id !== null && viewerId !== null && row.winner_user_id === viewerId;
      view.settledAt = row.settled_at?.toISOString() ?? null;
      view.payoutMinor = row.payout_minor ?? view.payoutMinor;
      view.rakeMinor = row.rake_minor ?? view.rakeMinor;
      view.potMinor = row.pot_minor ?? view.potMinor;
      view.result = {
        mines: minesOfMask(mask),
        host: {
          state: row.host_state,
          score: row.host_score,
          picks: pickViews(picksOf(row.host_picks), mask),
        },
        opponent: {
          state: row.opponent_state,
          score: row.opponent_score,
          picks: pickViews(picksOf(row.opponent_picks), mask),
        },
        serverSeed: row.server_seed_reveal,
        hostClientSeed: row.host_client_seed,
        opponentClientSeed: row.opponent_client_seed,
      };
    }
    return view;
  }

  /** A finished duel in a list: who, how much, and the two scores (public once it is over). */
  function compactView(row: GameRow, viewerId: string | null) {
    const role = roleOf(row, viewerId);
    return {
      code: row.code,
      outcome: row.outcome,
      stakeMinor: row.stake_minor,
      payoutMinor: row.payout_minor,
      mines: row.mine_count,
      host: { name: row.host_name, isYou: role === 'host', score: row.host_score },
      opponent: { name: row.opponent_name, isYou: role === 'opponent', score: row.opponent_score },
      youWon: row.winner_user_id !== null && viewerId !== null && row.winner_user_id === viewerId,
      settledAt: row.settled_at?.toISOString() ?? null,
    };
  }

  /**
   * Debits a stake and writes the ledger row, as one guarded statement -- two concurrent requests
   * cannot both read a sufficient balance and both succeed. Same shape as a coinflip's stake.
   */
  async function debitStake(
    client: DbClient,
    userId: string,
    stake: bigint,
    gameId: string,
    role: Role,
  ): Promise<void> {
    const debited = await client.query<{ balance_minor: string }>(
      `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
        WHERE user_id = $1 AND balance_minor >= $2
        RETURNING balance_minor`,
      [userId, stake.toString()],
    );
    const balanceAfter = debited.rows[0]?.balance_minor;
    if (balanceAfter === undefined) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Not enough balance for that stake');
    }
    await client.query(
      `INSERT INTO wallet_transactions
         (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
       VALUES ($1, $2, $3, $4, 'mines_duel_stake', $5)`,
      [
        randomUUID(),
        userId,
        (-stake).toString(),
        balanceAfter,
        deterministicUuid('mines_duel_stake', gameId, role),
      ],
    );
  }

  async function assertRoomForAnotherGame(client: DbClient, userId: string): Promise<void> {
    const active = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM mines_duel_games
        WHERE (host_user_id = $1 OR opponent_user_id = $1) AND status IN ('open', 'playing')`,
      [userId],
    );
    if (Number(active.rows[0]?.count ?? 0) >= MAX_ACTIVE_GAMES_PER_USER) {
      throw new AppError(
        429,
        'TOO_MANY_GAMES',
        `You already have ${MAX_ACTIVE_GAMES_PER_USER} duels open or running`,
      );
    }
  }

  /** Closes an open game and hands the host their stake back. False if it was no longer open. */
  async function refundOpenGame(client: DbClient, row: GameRow): Promise<boolean> {
    const closed = await client.query(
      `UPDATE mines_duel_games SET status = 'cancelled' WHERE id = $1 AND status = 'open'`,
      [row.id],
    );
    if (closed.rowCount === 0) return false;
    await creditWallet(
      client,
      row.host_user_id,
      BigInt(row.stake_minor),
      'mines_duel_refund',
      deterministicUuid('mines_duel_refund', row.id, 'host'),
    );
    return true;
  }

  /**
   * Ends a game in play: locks in anybody still turning tiles where they stand, decides it, and
   * moves the money. The caller holds the row's lock and has checked it is in play; the UPDATE
   * re-checks, so even a caller that was wrong cannot settle a game twice.
   */
  async function settleLocked(client: DbClient, row: GameRow): Promise<boolean> {
    if (row.status !== 'playing' || row.mine_mask === null || !row.opponent_user_id) return false;
    const mask = row.mine_mask;
    const hostScore = scoreOf(row.host_state, picksOf(row.host_picks), mask);
    const opponentScore = scoreOf(row.opponent_state, picksOf(row.opponent_picks), mask);
    const outcome = decide(hostScore, opponentScore);
    const decided = outcome !== 'draw';
    const stake = BigInt(row.stake_minor);
    const winnerUserId =
      outcome === 'host' ? row.host_user_id : outcome === 'opponent' ? row.opponent_user_id : null;
    const money = decided
      ? splitPot(stake, row.rake_bps)
      : { potMinor: 0n, rakeMinor: 0n, payoutMinor: 0n };
    const serverSeed = decryptSecret(
      row.server_seed_ciphertext,
      config.dataEncryptionKey,
      `minesduel:${row.id}`,
    );

    const settled = await client.query(
      `UPDATE mines_duel_games
          SET status = 'settled',
              host_state = CASE WHEN host_state = 'playing' THEN 'locked' ELSE host_state END,
              opponent_state = CASE WHEN opponent_state = 'playing' THEN 'locked' ELSE opponent_state END,
              host_score = $2, opponent_score = $3,
              host_finished_at = COALESCE(host_finished_at, LEAST(now(), deadline_at)),
              opponent_finished_at = COALESCE(opponent_finished_at, LEAST(now(), deadline_at)),
              outcome = $4, winner_user_id = $5,
              pot_minor = $6, rake_minor = $7, payout_minor = $8,
              server_seed_reveal = $9, settled_at = now()
        WHERE id = $1 AND status = 'playing'`,
      [
        row.id,
        hostScore,
        opponentScore,
        outcome,
        winnerUserId,
        money.potMinor.toString(),
        money.rakeMinor.toString(),
        money.payoutMinor.toString(),
        serverSeed,
      ],
    );
    if (settled.rowCount === 0) return false; // somebody settled it first

    if (decided && winnerUserId) {
      await creditWallet(
        client,
        winnerUserId,
        money.payoutMinor,
        'mines_duel_win',
        deterministicUuid('mines_duel_win', row.id, winnerUserId),
      );
      /* NOW both stakes are wagers. Each player's margin is half the rake, because they put in
       * half the pot each -- the derivation a duel and a coinflip use, for the same reason: this
       * mode charges no house edge on the result, so an edge-derived margin would be money never
       * collected. */
      const margin = duelMarginPerPlayer(money);
      for (const player of [row.host_user_id, row.opponent_user_id]) {
        await recordWager(
          client,
          config,
          player,
          stake,
          'mines_duel',
          deterministicUuid('mines_duel_wager', row.id, player),
          ['wagered_minor'],
          margin,
        );
      }
    } else {
      /* A draw: both stakes back whole. Nothing is charged and nothing is counted as wagered. */
      await creditWallet(
        client,
        row.host_user_id,
        stake,
        'mines_duel_refund',
        deterministicUuid('mines_duel_refund', row.id, 'host'),
      );
      await creditWallet(
        client,
        row.opponent_user_id,
        stake,
        'mines_duel_refund',
        deterministicUuid('mines_duel_refund', row.id, 'opponent'),
      );
    }
    return true;
  }

  const clockHasRunOut = (row: GameRow): boolean =>
    row.status === 'playing' &&
    row.deadline_at !== null &&
    row.deadline_at.getTime() <= row.db_now.getTime();

  /**
   * Tells the players' pages their balance moved. After the commit, never inside it, so the page
   * that refetches reads the new figure; and aimed at the two players, because a player who is not
   * looking at this page when a game ends still needs their wallet pill to be right.
   */
  function announceMoney(...userIds: Array<string | null>): void {
    const who = userIds.filter((id): id is string => id !== null);
    if (who.length > 0) publishLiveSoon('balance', who);
  }

  /**
   * Settles a game whose clock has run out, if it has. Used by the sweeper and by reads. Returns
   * the row that was settled (so the caller can say whose balance moved), or null if nothing was.
   */
  async function settleIfDue(code: string): Promise<GameRow | null> {
    return db.transaction(async (client) => {
      const row = await lockGame(client, code);
      if (row && clockHasRunOut(row) && (await settleLocked(client, row))) return row;
      return null;
    });
  }

  /* ─────────────────────────── reads ─────────────────────────── */

  app.get('/v1/mines-duel', { preHandler: softAuth }, async (request) => {
    const viewerId = request.authUser?.id ?? null;
    const open = await db.query<GameRow>(
      `${SELECT_GAME}
        WHERE g.status = 'open' AND g.expires_at > now()
        ORDER BY g.stake_minor DESC, g.created_at DESC
        LIMIT 100`,
    );
    const recent = await db.query<GameRow>(
      `${SELECT_GAME}
        WHERE g.status = 'settled' AND g.outcome <> 'draw'
        ORDER BY g.settled_at DESC
        LIMIT ${RECENT_DUELS}`,
    );
    let mine: GameRow[] = [];
    let history: GameRow[] = [];
    if (viewerId) {
      mine = (
        await db.query<GameRow>(
          `${SELECT_GAME}
            WHERE (g.host_user_id = $1 OR g.opponent_user_id = $1)
              AND g.status IN ('open', 'playing')
            ORDER BY g.created_at DESC
            LIMIT 10`,
          [viewerId],
        )
      ).rows;
      history = (
        await db.query<GameRow>(
          `${SELECT_GAME}
            WHERE (g.host_user_id = $1 OR g.opponent_user_id = $1) AND g.status = 'settled'
            ORDER BY g.settled_at DESC
            LIMIT 8`,
          [viewerId],
        )
      ).rows;
    }
    return {
      enabled: config.minesDuelEnabled,
      rakeBps: config.minesDuelRakeBps,
      minStakeMinor: config.minesDuelMinStakeMinor.toString(),
      maxStakeMinor: config.minesDuelMaxStakeMinor.toString(),
      playSeconds: config.minesDuelPlaySeconds,
      mineOptions: DUEL_MINE_OPTIONS,
      games: open.rows.map((row) => gameView(row, viewerId)),
      mine: mine.map((row) => gameView(row, viewerId)),
      history: history.map((row) => compactView(row, viewerId)),
      recent: recent.rows.map((row) => compactView(row, viewerId)),
    };
  });

  app.get('/v1/mines-duel/:code', { preHandler: softAuth }, async (request) => {
    const { code } = parseWith(codeParams, request.params);
    /* A clock that has run out is settled by whoever looks first, so a player returning to a
     * finished game sees the result now rather than after the next sweep. */
    const settled = await settleIfDue(code);
    if (settled) {
      publishLiveSoon('minesduel');
      announceMoney(settled.host_user_id, settled.opponent_user_id);
    }
    const row = await readGame(db, code);
    if (!row) throw new AppError(404, 'MINES_DUEL_NOT_FOUND', 'No such game');
    return gameView(row, request.authUser?.id ?? null);
  });

  /* ─────────────────────────── open a game ─────────────────────────── */

  app.post(
    '/v1/mines-duel',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      assertEnabled();
      const body = parseWith(createSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to open a duel');

      const stake = BigInt(body.stakeMinor);
      if (stake < config.minesDuelMinStakeMinor || stake > config.minesDuelMaxStakeMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_RANGE', 'That stake is outside the allowed range');
      }

      const created = await db.transaction(async (client) => {
        await assertGameEligible(client, userId);
        await assertRoomForAnotherGame(client, userId);

        const gameId = randomUUID();
        const code = battleCodeFrom(randomBytes(8));
        const serverSeed = generateServerSeed();
        await client.query(
          `INSERT INTO mines_duel_games
             (id, code, host_user_id, stake_minor, rake_bps, play_seconds, mine_count, status,
              server_seed_hash, server_seed_ciphertext, host_client_seed, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10,
                   now() + ($11 || ' minutes')::interval)`,
          [
            gameId,
            code,
            userId,
            stake.toString(),
            /* Snapshots, not lookups at settlement: a fee or clock change must not reprice a game
             * already on the board. */
            config.minesDuelRakeBps,
            config.minesDuelPlaySeconds,
            body.mines,
            hashServerSeed(serverSeed),
            encryptSecret(serverSeed, config.dataEncryptionKey, `minesduel:${gameId}`),
            body.clientSeed ?? randomBytes(16).toString('hex'),
            String(config.minesDuelLobbyTtlMinutes),
          ],
        );
        await debitStake(client, userId, stake, gameId, 'host');
        return readGame(client, code);
      });

      if (!created)
        throw new AppError(500, 'MINES_DUEL_CREATE_FAILED', 'The game could not be opened');
      publishLiveSoon('minesduel');
      return reply.code(201).send(gameView(created, userId));
    },
  );

  /* ─────────────────────────── take a game ─────────────────────────── */

  app.post(
    '/v1/mines-duel/:code/join',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const { code } = parseWith(codeParams, request.params);
      const body = parseWith(joinSchema, request.body ?? {});
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to join a duel');

      const started = await db.transaction(async (client) => {
        await assertGameEligible(client, userId);
        await assertRoomForAnotherGame(client, userId);

        /* FOR UPDATE: two players taking the same game at the same instant must not both become
         * the opponent. The lock serializes them; the status check rejects the second cleanly. */
        const row = await lockGame(client, code);
        if (!row) throw new AppError(404, 'MINES_DUEL_NOT_FOUND', 'No such game');
        if (row.status !== 'open') {
          throw new AppError(409, 'MINES_DUEL_NOT_OPEN', 'That game has already been taken');
        }
        if (row.expires_at.getTime() <= row.db_now.getTime()) {
          throw new AppError(409, 'MINES_DUEL_EXPIRED', 'That game has expired');
        }
        if (row.host_user_id === userId) {
          throw new AppError(409, 'CANNOT_DUEL_SELF', 'You cannot take your own game');
        }

        const stake = BigInt(row.stake_minor);
        await debitStake(client, userId, stake, row.id, 'opponent');

        /* The field is dealt now, with the opponent's seed, and stored: it is the secret the game
         * is played against, and it leaves the server only in the settled reveal. */
        const serverSeed = decryptSecret(
          row.server_seed_ciphertext,
          config.dataEncryptionKey,
          `minesduel:${row.id}`,
        );
        const opponentClientSeed = body.clientSeed ?? randomBytes(16).toString('hex');
        const mask = maskOf(
          duelMinePositions(serverSeed, row.host_client_seed, opponentClientSeed, row.mine_count),
        );

        const claimed = await client.query(
          `UPDATE mines_duel_games
              SET opponent_user_id = $2, opponent_client_seed = $3, mine_mask = $4,
                  status = 'playing', started_at = now(),
                  deadline_at = now() + play_seconds * interval '1 second'
            WHERE id = $1 AND status = 'open'`,
          [row.id, userId, opponentClientSeed, mask],
        );
        if (claimed.rowCount === 0) {
          throw new AppError(409, 'MINES_DUEL_NOT_OPEN', 'That game has already been taken');
        }
        return readGame(client, code);
      });

      if (!started)
        throw new AppError(500, 'MINES_DUEL_JOIN_FAILED', 'The game could not be joined');
      publishLiveSoon('minesduel');
      return gameView(started, userId);
    },
  );

  /* ─────────────────────────── cancel ─────────────────────────── */

  app.post(
    '/v1/mines-duel/:code/cancel',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const { code } = parseWith(codeParams, request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const row = await db.transaction(async (client) => {
        const game = await lockGame(client, code);
        if (!game) throw new AppError(404, 'MINES_DUEL_NOT_FOUND', 'No such game');
        if (game.host_user_id !== userId) {
          throw new AppError(403, 'NOT_THE_HOST', 'Only the host can cancel');
        }
        if (!(await refundOpenGame(client, game))) {
          throw new AppError(409, 'MINES_DUEL_NOT_OPEN', 'That game has already been taken');
        }
        return game;
      });

      publishLiveSoon('minesduel');
      announceMoney(userId);
      return { ok: true, refundedMinor: row.stake_minor };
    },
  );

  /* ─────────────────────────── playing ─────────────────────────── */

  /**
   * Finishes a player's run, in the same transaction that decided it, and settles the game if that
   * was the last run. Returns the settled-or-running row.
   */
  async function finishRun(
    client: DbClient,
    row: GameRow,
    role: Role,
    state: 'locked' | 'busted',
    score: number,
    extraPick: number | null,
  ): Promise<GameRow> {
    const columns = COLUMNS[role];
    await client.query(
      `UPDATE mines_duel_games
          SET ${columns.picks} = ${extraPick === null ? columns.picks : `array_append(${columns.picks}, $4)`},
              ${columns.state} = $2, ${columns.score} = $3, ${columns.finished} = now()
        WHERE id = $1 AND status = 'playing' AND ${columns.state} = 'playing'`,
      extraPick === null ? [row.id, state, score] : [row.id, state, score, extraPick],
    );
    const fresh = await lockGame(client, row.code);
    if (!fresh) throw new AppError(404, 'MINES_DUEL_NOT_FOUND', 'No such game');
    if (fresh.host_state !== 'playing' && fresh.opponent_state !== 'playing') {
      await settleLocked(client, fresh);
      return (await readGame(client, row.code)) ?? fresh;
    }
    return fresh;
  }

  app.post(
    '/v1/mines-duel/:code/pick',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request) => {
      const { code } = parseWith(codeParams, request.params);
      const { tile } = parseWith(pickSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const outcome = await db.transaction(async (client) => {
        const row = await lockGame(client, code);
        if (!row) throw new AppError(404, 'MINES_DUEL_NOT_FOUND', 'No such game');
        const role = roleOf(row, userId);
        if (!role) throw new AppError(403, 'NOT_A_PLAYER', 'You are not in this game');

        /* A clock that has run out settles the game, whoever's request noticed -- and this tile is
         * not counted. The answer is the settled game, not an error: the page was only behind. */
        if (clockHasRunOut(row)) {
          await settleLocked(client, row);
          return { accepted: false, row: (await readGame(client, code)) ?? row, hit: false };
        }
        if (row.status !== 'playing' || row.mine_mask === null) {
          throw new AppError(409, 'MINES_DUEL_NOT_PLAYING', 'This game is not being played');
        }
        const own = sideOf(row, role);
        if (own.state !== 'playing') {
          throw new AppError(409, 'RUN_FINISHED', 'You have already finished this game');
        }
        if (own.picks.includes(tile)) {
          throw new AppError(409, 'TILE_TURNED', 'You already turned that tile');
        }

        const mask = row.mine_mask;
        const hit = isMine(mask, tile);
        const safeAfter = hit ? 0 : safeCount(own.picks, mask) + 1;
        if (hit) {
          return {
            accepted: true,
            hit,
            row: await finishRun(client, row, role, 'busted', 0, tile),
          };
        }
        /* Every safe tile turned: there is nothing left to turn, so the run is over and locked in
         * at the best score the field can give. */
        if (safeAfter >= safeTiles(row.mine_count)) {
          return {
            accepted: true,
            hit,
            row: await finishRun(client, row, role, 'locked', safeAfter, tile),
          };
        }
        const columns = COLUMNS[role];
        await client.query(
          `UPDATE mines_duel_games SET ${columns.picks} = array_append(${columns.picks}, $2)
            WHERE id = $1 AND status = 'playing'`,
          [row.id, tile],
        );
        return { accepted: true, hit, row: (await readGame(client, code)) ?? row };
      });

      /* Only a finished run is news to the other player's page; a safe tile is not. */
      if (!outcome.accepted || outcome.hit || outcome.row.status === 'settled') {
        publishLiveSoon('minesduel');
      }
      if (outcome.row.status === 'settled') {
        announceMoney(outcome.row.host_user_id, outcome.row.opponent_user_id);
      }
      return {
        accepted: outcome.accepted,
        tile,
        mine: outcome.hit,
        game: gameView(outcome.row, userId),
      };
    },
  );

  app.post(
    '/v1/mines-duel/:code/lock',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const { code } = parseWith(codeParams, request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const outcome = await db.transaction(async (client) => {
        const row = await lockGame(client, code);
        if (!row) throw new AppError(404, 'MINES_DUEL_NOT_FOUND', 'No such game');
        const role = roleOf(row, userId);
        if (!role) throw new AppError(403, 'NOT_A_PLAYER', 'You are not in this game');
        if (clockHasRunOut(row)) {
          await settleLocked(client, row);
          return { accepted: false, row: (await readGame(client, code)) ?? row };
        }
        if (row.status !== 'playing' || row.mine_mask === null) {
          throw new AppError(409, 'MINES_DUEL_NOT_PLAYING', 'This game is not being played');
        }
        const own = sideOf(row, role);
        if (own.state !== 'playing') {
          throw new AppError(409, 'RUN_FINISHED', 'You have already finished this game');
        }
        const score = safeCount(own.picks, row.mine_mask);
        if (score < 1) {
          throw new AppError(400, 'NOTHING_TO_LOCK', 'Turn at least one safe tile first');
        }
        return { accepted: true, row: await finishRun(client, row, role, 'locked', score, null) };
      });

      publishLiveSoon('minesduel');
      if (outcome.row.status === 'settled') {
        announceMoney(outcome.row.host_user_id, outcome.row.opponent_user_id);
      }
      return { accepted: outcome.accepted, game: gameView(outcome.row, userId) };
    },
  );

  /* ─────────────────────────── the sweeper ─────────────────────────── */

  /**
   * Two jobs, both money, both safe to run twice. Games whose clock has run out are settled with
   * anybody still turning tiles locked in where they stand; open games nobody took before their TTL
   * are refunded. Each is re-read under lock and closed by the same guarded UPDATE the player-
   * facing paths use, with the same deterministic ledger references, so a sweep racing a player's
   * last tile or a host's cancel cannot pay twice.
   *
   * It runs whether or not the game is switched on: a game in play when somebody closes the board
   * still has to finish and pay.
   */
  async function sweep(): Promise<void> {
    let changed = false;
    const due = await db.query<{ code: string }>(
      `SELECT code FROM mines_duel_games
        WHERE status = 'playing' AND deadline_at <= now() LIMIT 25`,
    );
    for (const { code } of due.rows) {
      const settled = await settleIfDue(code);
      if (!settled) continue;
      changed = true;
      announceMoney(settled.host_user_id, settled.opponent_user_id);
    }
    const lapsed = await db.query<{ code: string }>(
      `SELECT code FROM mines_duel_games WHERE status = 'open' AND expires_at <= now() LIMIT 25`,
    );
    for (const { code } of lapsed.rows) {
      const refunded = await db.transaction(async (client) => {
        const row = await lockGame(client, code);
        return row && (await refundOpenGame(client, row)) ? row : null;
      });
      if (!refunded) continue;
      changed = true;
      announceMoney(refunded.host_user_id);
    }
    if (changed) publishLiveSoon('minesduel');
  }

  let sweeping = false;
  const sweeper = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweep()
      .catch((error: unknown) => app.log.error({ error }, 'mines duel sweep failed'))
      .finally(() => {
        sweeping = false;
      });
  }, 3_000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));
}
