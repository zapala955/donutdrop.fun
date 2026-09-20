import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager } from '../lib/cash-settlement.js';
import { decryptSecret, encryptSecret, hmacHex, safeEqualText } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { battleCodeFrom, deterministicUuid } from '../lib/battle-engine.js';
import {
  VARIANT_RULES,
  duelMarginPerPlayer,
  judge,
  resolveDuel,
  scheduleFor,
  splitPot,
  type DuelVariant,
  type RoundResult,
} from '../lib/duel-engine.js';
import { DuelHub } from '../lib/duel-hub.js';
import { AppError } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith } from '../lib/validation.js';
import { LOBBY_SOCKET_BUDGET, createSocketBudget } from '../lib/socket-limit.js';

/**
 * 1v1 Skill Duels.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MONEY, IN ORDER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. Host creates a lobby. Their stake is DEBITED immediately and the lobby holds it. A lobby
 *      that promises a stake it has not taken is a lobby that can be joined against an empty
 *      wallet, and the opponent finds out after they have staked.
 *   2. Opponent joins. Their stake is debited the same way. The duel starts.
 *   3. Rounds run. No money moves. Nothing here can pay out, so a disconnect mid-duel cannot
 *      cost anyone anything that has not already been staked.
 *   4. Settlement. The pot is split exactly once:
 *        decided  → winner is credited pot - rake, house keeps rake.
 *        draw     → both stakes returned whole, house keeps NOTHING.
 *        forfeit  → the player who stayed is credited pot - rake.
 *        expired  → both stakes returned whole, house keeps NOTHING.
 *
 * The house is paid for producing a winner. When it does not produce one it is not paid, which is
 * why 'draw' and 'expired' refund at face value rather than refunding net of a fee.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE STAKE IS NOT A WAGER UNTIL THE DUEL STARTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `recordWager` — which drives quests, the faction war, referral revenue share, rakeback and VIP
 * progress — is called when the duel STARTS, not when the lobby is created. A lobby that expires
 * unjoined never happened: counting it would let a player farm wagered volume, rakeback and
 * referral milestones by opening and abandoning lobbies against themselves at zero risk.
 */

/** A lobby nobody joins must not hold its host's money forever. */
const MAX_OPEN_LOBBIES_PER_USER = 3;

/**
 * How long after a round's shared start the server stops accepting its input.
 *
 * The round window plus the transport slack the engine already allows. An input that arrives
 * later than this is not late-but-honest, it is a client that held onto a result — which is the
 * shape of someone waiting to see whether they needed to send a better one.
 */
const INPUT_GRACE_MS = 3_000;

/** Both clients open a round at the same wall-clock instant. This is how far ahead that is set. */
const ROUND_LEAD_MS = 1_500;

const createSchema = z.object({
  variant: z.enum(['reflex', 'precision', 'sequence']),
  stakeMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  visibility: z.enum(['public', 'private']).default('public'),
  /* Only read for a private lobby. Length-bounded because it is hashed, and an unbounded input to
   * a hash is a cheap way to make the server do work. */
  joinSecret: z.string().min(4).max(64).optional(),
});

const joinSchema = z.object({
  joinSecret: z.string().min(4).max(64).optional(),
});

const inputSchema = z.object({
  roundIndex: z.number().int().min(0).max(8),
  /** What the client says the player did, in ms from the round's shared start. */
  reportedMs: z.number().int().min(0).max(60_000),
  /** For 'sequence' only. */
  symbols: z.array(z.number().int().min(0).max(5)).max(8).optional(),
});

interface DuelRow {
  id: string;
  code: string;
  host_user_id: string;
  opponent_user_id: string | null;
  variant: string;
  visibility: string;
  join_secret_hash: string | null;
  stake_minor: string;
  rake_bps: number;
  status: string;
  server_seed_hash: string;
  server_seed_ciphertext: string;
  server_seed_reveal: string | null;
  rounds_total: number;
  winner_user_id: string | null;
  pot_minor: string | null;
  rake_minor: string | null;
  payout_minor: string | null;
  outcome: string | null;
  started_at: Date | null;
  settled_at: Date | null;
  expires_at: Date;
  host_name: string | null;
  opponent_name: string | null;
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* the lobby list is readable logged out */
    }
  };
}

/**
 * Hashes a private lobby's join secret.
 *
 * Keyed on the platform's data encryption key and salted with the duel code, so two lobbies that
 * happen to share a password do not share a hash and a stolen hash is not replayable elsewhere.
 *
 * This is deliberately NOT the password KDF used for account credentials. A room password is a
 * low-value, single-purpose token on a row that expires in minutes and guards a match rather than
 * an identity; an Argon2 verification on every join attempt would be a much better denial-of-
 * service target than it is a security gain here.
 */
function hashJoinSecret(config: AppConfig, code: string, secret: string): string {
  return hmacHex(config.dataEncryptionKey, `duel-join:${code}:${secret}`);
}

export async function registerDuelRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);
  const hub = new DuelHub();
  app.addHook('onClose', async () => hub.close());

  function assertEnabled(): void {
    if (!config.skillDuelEnabled) {
      throw new AppError(404, 'DUELS_DISABLED', 'Skill duels are not switched on');
    }
  }

  /* ─────────────────────────── shared readers ─────────────────────────── */

  /**
   * The public shape of a duel.
   *
   * `joinSecret` never appears, and neither does the server seed before settlement — the whole
   * point of committing the cue schedule is that nobody can read it while it still matters.
   */
  function publicDuel(row: DuelRow, viewerId: string | null) {
    const stake = BigInt(row.stake_minor);
    const money = splitPot(stake, row.rake_bps);
    return {
      code: row.code,
      variant: row.variant,
      visibility: row.visibility,
      status: row.status,
      stakeMinor: row.stake_minor,
      rakeBps: row.rake_bps,
      /* Quoted on the lobby row so a player sees the fee before staking, not after winning. */
      potMinor: money.potMinor.toString(),
      rakeMinor: money.rakeMinor.toString(),
      payoutMinor: money.payoutMinor.toString(),
      roundsTotal: row.rounds_total,
      roundMs: VARIANT_RULES[row.variant as DuelVariant].roundMs,
      host: { name: row.host_name, isYou: viewerId !== null && viewerId === row.host_user_id },
      opponent: row.opponent_user_id
        ? { name: row.opponent_name, isYou: viewerId !== null && viewerId === row.opponent_user_id }
        : null,
      outcome: row.outcome,
      winner: row.winner_user_id
        ? (row.winner_user_id === row.host_user_id ? 'host' : 'opponent')
        : null,
      youWon: row.winner_user_id !== null && viewerId !== null && row.winner_user_id === viewerId,
      serverSeedHash: row.server_seed_hash,
      /* Revealed only once the duel is over and the schedule can no longer be exploited. */
      serverSeed: row.server_seed_reveal,
      watchers: hub.watchers(row.code),
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /* Both players are named to any spectator who opens the arena, so both are masked in the query.
   * The same leak as the battle lobby, in the same shape. See lib/masked-name.ts. */
  const SELECT_DUEL = `
    SELECT d.*,
           ${maskedName('h.minecraft_username')} AS host_name,
           ${maskedName('o.minecraft_username')} AS opponent_name
      FROM duel_lobbies d
      JOIN users h ON h.id = d.host_user_id
      LEFT JOIN users o ON o.id = d.opponent_user_id`;

  async function readDuel(client: DbClient, code: string): Promise<DuelRow | null> {
    const result = await client.query<DuelRow>(`${SELECT_DUEL} WHERE d.code = $1`, [code]);
    return result.rows[0] ?? null;
  }

  /**
   * Debits a player's stake and writes the ledger row.
   *
   * The balance check and the debit are ONE statement with a guard in the WHERE clause, so two
   * concurrent joins cannot both read a sufficient balance and both succeed. A read-then-write
   * here is the classic way to let a player stake money they do not have.
   */
  async function debitStake(
    client: DbClient,
    userId: string,
    stake: bigint,
    duelId: string,
    role: 'host' | 'opponent',
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
       VALUES ($1, $2, $3, $4, 'duel_stake', $5)`,
      [
        randomUUID(), userId, (-stake).toString(), balanceAfter,
        deterministicUuid('duel_stake', duelId, role),
      ],
    );
  }

  /**
   * Settles a duel exactly once and pays whoever is owed.
   *
   * Guarded by `status <> 'settled'` inside the transaction: settlement can be reached from the
   * last round's input, from a forfeit, and from the expiry sweeper, and all three can race. The
   * UPDATE ... WHERE status is the thing that makes double payment impossible, not the callers
   * remembering to check first.
   */
  async function settleDuel(
    client: DbClient,
    row: DuelRow,
    outcome: 'decided' | 'draw' | 'forfeit' | 'expired',
    winnerUserId: string | null,
  ): Promise<DuelRow | null> {
    const stake = BigInt(row.stake_minor);
    const money = splitPot(stake, row.rake_bps);
    const paysRake = outcome === 'decided' || outcome === 'forfeit';

    /* A duel that produced no winner returns both stakes at face value and the house takes
     * nothing. Recording a zero rake rather than skipping the columns keeps the row's settlement
     * block complete, which is what `duel_settled_is_complete` requires. */
    const rakeMinor = paysRake ? money.rakeMinor : 0n;
    const payoutMinor = paysRake ? money.payoutMinor : money.potMinor;

    const claimed = await client.query(
      `UPDATE duel_lobbies
          SET status = 'settled', settled_at = now(), outcome = $2, winner_user_id = $3,
              pot_minor = $4, rake_minor = $5, payout_minor = $6, server_seed_reveal = $7
        WHERE id = $1 AND status <> 'settled' AND status <> 'cancelled'`,
      [
        row.id, outcome, winnerUserId,
        money.potMinor.toString(), rakeMinor.toString(), payoutMinor.toString(),
        decryptSecret(row.server_seed_ciphertext, config.dataEncryptionKey, `duel:${row.id}`),
      ],
    );
    if (claimed.rowCount === 0) return null;   // somebody else settled it first

    if (paysRake && winnerUserId) {
      await creditWallet(
        client, winnerUserId, payoutMinor, 'duel_win',
        deterministicUuid('duel_win', row.id, winnerUserId),
      );
    } else {
      /* Refund both sides their own stake. Two rows rather than one, because a refund belongs in
       * each player's own history at the amount they actually put in. */
      for (const [userId, role] of [
        [row.host_user_id, 'host'] as const,
        [row.opponent_user_id, 'opponent'] as const,
      ]) {
        if (!userId) continue;
        await creditWallet(
          client, userId, stake, 'duel_refund',
          deterministicUuid('duel_refund', row.id, role),
        );
      }
    }
    return readDuel(client, row.code);
  }

  /* ─────────────────────────── reads ─────────────────────────── */

  app.get('/v1/duels', { preHandler: softAuth }, async (request) => {
    assertEnabled();
    const viewerId = request.authUser?.id ?? null;
    /* Public open lobbies, biggest stake first — the order the table renders in — plus any duel
     * the viewer is personally in, so a private room they created does not vanish from their own
     * screen the moment they navigate away. */
    const result = await db.query<DuelRow>(
      `${SELECT_DUEL}
        WHERE (d.status = 'lobby' AND d.visibility = 'public' AND d.expires_at > now())
           OR ($1::uuid IS NOT NULL
               AND (d.host_user_id = $1 OR d.opponent_user_id = $1)
               AND d.status IN ('lobby', 'running'))
        ORDER BY d.stake_minor DESC, d.created_at DESC
        LIMIT 100`,
      [viewerId],
    );
    return {
      rakeBps: config.skillDuelRakeBps,
      minStakeMinor: config.skillDuelMinStakeMinor.toString(),
      maxStakeMinor: config.skillDuelMaxStakeMinor.toString(),
      variants: Object.entries(VARIANT_RULES).map(([name, rules]) => ({
        variant: name, rounds: rules.rounds, roundMs: rules.roundMs,
      })),
      duels: result.rows.map((row) => publicDuel(row, viewerId)),
    };
  });

  app.get('/v1/duels/:code', { preHandler: softAuth }, async (request) => {
    assertEnabled();
    const { code } = parseWith(z.object({ code: z.string().regex(/^[A-Z0-9]{6,12}$/) }), request.params);
    const row = await readDuel(db, code);
    if (!row) throw new AppError(404, 'DUEL_NOT_FOUND', 'No such duel');
    return publicDuel(row, request.authUser?.id ?? null);
  });

  /* ─────────────────────────── create ─────────────────────────── */

  app.post(
    '/v1/duels',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      assertEnabled();
      const body = parseWith(createSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to host a duel');

      if (body.visibility === 'private' && !body.joinSecret) {
        throw new AppError(400, 'SECRET_REQUIRED', 'A private duel needs a room password');
      }
      const stake = BigInt(body.stakeMinor);
      if (stake < config.skillDuelMinStakeMinor || stake > config.skillDuelMaxStakeMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_RANGE', 'That stake is outside the allowed range');
      }

      const created = await db.transaction(async (client) => {
        await assertGameEligible(client, userId);

        const open = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM duel_lobbies
            WHERE host_user_id = $1 AND status = 'lobby' AND expires_at > now()`,
          [userId],
        );
        if (Number(open.rows[0]?.count ?? 0) >= MAX_OPEN_LOBBIES_PER_USER) {
          throw new AppError(
            429, 'TOO_MANY_LOBBIES',
            `You already have ${MAX_OPEN_LOBBIES_PER_USER} open duels`,
          );
        }

        const duelId = randomUUID();
        const code = battleCodeFrom(randomBytes(8));
        const serverSeed = generateServerSeed();
        const variant = body.variant;

        await client.query(
          `INSERT INTO duel_lobbies
             (id, code, host_user_id, variant, visibility, join_secret_hash, stake_minor,
              rake_bps, status, server_seed_hash, server_seed_ciphertext, rounds_total, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'lobby', $9, $10, $11,
                   now() + ($12 || ' minutes')::interval)`,
          [
            duelId, code, userId, variant, body.visibility,
            body.visibility === 'private' && body.joinSecret
              ? hashJoinSecret(config, code, body.joinSecret)
              : null,
            stake.toString(),
            /* Snapshot, not a lookup at settlement. An operator changing the fee must not change
             * it under a duel that is already on the board. */
            config.skillDuelRakeBps,
            hashServerSeed(serverSeed),
            encryptSecret(serverSeed, config.dataEncryptionKey, `duel:${duelId}`),
            VARIANT_RULES[variant].rounds,
            String(config.skillDuelLobbyTtlMinutes),
          ],
        );

        await debitStake(client, userId, stake, duelId, 'host');
        return readDuel(client, code);
      });

      if (!created) throw new AppError(500, 'DUEL_CREATE_FAILED', 'The duel could not be created');
      const shaped = publicDuel(created, userId);
      if (created.visibility === 'public') hub.broadcastLobby({ type: 'duel:created', duel: shaped });
      return reply.code(201).send(shaped);
    },
  );

  /* ─────────────────────────── join ─────────────────────────── */

  app.post(
    '/v1/duels/:code/join',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const { code } = parseWith(z.object({ code: z.string().regex(/^[A-Z0-9]{6,12}$/) }), request.params);
      const body = parseWith(joinSchema, request.body ?? {});
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to join a duel');

      const joined = await db.transaction(async (client) => {
        await assertGameEligible(client, userId);

        /* FOR UPDATE: two players hitting Join on the same lobby at the same instant must not both
         * become the opponent. The lock serializes them and the status check below rejects the
         * loser with a clean conflict rather than a corrupted duel. */
        const locked = await client.query<DuelRow>(
          `${SELECT_DUEL} WHERE d.code = $1 FOR UPDATE OF d`,
          [code],
        );
        const row = locked.rows[0];
        if (!row) throw new AppError(404, 'DUEL_NOT_FOUND', 'No such duel');
        if (row.status !== 'lobby') throw new AppError(409, 'DUEL_NOT_OPEN', 'That duel is no longer open');
        if (row.expires_at.getTime() <= Date.now()) {
          throw new AppError(409, 'DUEL_EXPIRED', 'That duel has expired');
        }
        if (row.host_user_id === userId) {
          throw new AppError(409, 'CANNOT_DUEL_SELF', 'You cannot join your own duel');
        }
        if (row.join_secret_hash) {
          const supplied = body.joinSecret
            ? hashJoinSecret(config, row.code, body.joinSecret)
            : '';
          if (!safeEqualText(supplied, row.join_secret_hash)) {
            throw new AppError(403, 'BAD_ROOM_PASSWORD', 'Wrong room password');
          }
        }

        const stake = BigInt(row.stake_minor);
        await debitStake(client, userId, stake, row.id, 'opponent');

        await client.query(
          `UPDATE duel_lobbies
              SET opponent_user_id = $2, status = 'running', started_at = now()
            WHERE id = $1`,
          [row.id, userId],
        );

        /* NOW the stakes are wagers: the duel is real and both sides are committed. Each player's
         * margin is half the rake, because they contributed the pot equally — see
         * duelMarginPerPlayer for why this is passed explicitly rather than derived from the
         * house edge this mode does not charge. */
        const margin = duelMarginPerPlayer(splitPot(stake, row.rake_bps));
        for (const player of [row.host_user_id, userId]) {
          await recordWager(
            client, config, player, stake, 'skill_duel',
            deterministicUuid('duel_wager', row.id, player),
            ['wagered_minor'],
            margin,
          );
        }
        return readDuel(client, code);
      });

      if (!joined) throw new AppError(500, 'DUEL_JOIN_FAILED', 'The duel could not be joined');
      const shaped = publicDuel(joined, null);
      hub.broadcast(code, { type: 'duel:joined', code, duel: shaped });
      hub.broadcastLobby({ type: 'duel:removed', code });
      void startRound(joined, 0);
      return publicDuel(joined, userId);
    },
  );

  /**
   * Opens a round for both players.
   *
   * `startsAt` is a wall-clock instant a beat in the future, and it is the entire latency story:
   * both clients open the round at that instant rather than on arrival, so the player on the worse
   * connection is not answering a cue that fired late for them. See duel-hub.ts.
   *
   * The cue offset is NOT sent. A client that knew when the cue fires before it fired would not be
   * playing a reflex game. It goes out separately, on a timer, at the moment it is due.
   */
  async function startRound(row: DuelRow, roundIndex: number): Promise<void> {
    const variant = row.variant as DuelVariant;
    const rules = VARIANT_RULES[variant];
    const startsAt = Date.now() + ROUND_LEAD_MS;
    const serverSeed = decryptSecret(
      row.server_seed_ciphertext, config.dataEncryptionKey, `duel:${row.id}`,
    );
    const schedule = scheduleFor(serverSeed, variant, roundIndex);

    hub.broadcast(row.code, {
      type: 'duel:round',
      code: row.code,
      roundIndex,
      startsAt,
      roundMs: rules.roundMs,
      /* The sequence to memorise is the challenge itself, so it ships with the round. The timing
       * variants send nothing here — their challenge is WHEN, and that stays secret until it
       * happens. */
      symbols: variant === 'sequence' ? schedule.symbols : [],
    });

    if (variant !== 'sequence') {
      const cueDelay = ROUND_LEAD_MS + schedule.cueOffsetMs;
      const timer = setTimeout(() => {
        hub.broadcast(row.code, {
          type: 'duel:cue',
          code: row.code,
          roundIndex,
          at: startsAt + schedule.cueOffsetMs,
        });
      }, cueDelay);
      timer.unref?.();
    }

    /* The round closes on a timer whether or not anyone answered. A duel whose progress depends on
     * a player sending something is a duel that hangs when they close the tab. */
    const closer = setTimeout(() => {
      void closeRound(row.code, roundIndex);
    }, ROUND_LEAD_MS + rules.roundMs + INPUT_GRACE_MS);
    closer.unref?.();
  }

  /* ─────────────────────────── input ─────────────────────────── */

  app.post(
    '/v1/duels/:code/input',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const { code } = parseWith(z.object({ code: z.string().regex(/^[A-Z0-9]{6,12}$/) }), request.params);
      const body = parseWith(inputSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to play');
      const arrivedAt = Date.now();

      await db.transaction(async (client) => {
        const row = await readDuel(client, code);
        if (!row) throw new AppError(404, 'DUEL_NOT_FOUND', 'No such duel');
        if (row.status !== 'running') throw new AppError(409, 'DUEL_NOT_RUNNING', 'That duel is not running');
        if (userId !== row.host_user_id && userId !== row.opponent_user_id) {
          throw new AppError(403, 'NOT_A_PLAYER', 'You are not in that duel');
        }
        if (body.roundIndex >= row.rounds_total) {
          throw new AppError(400, 'BAD_ROUND', 'That round is not part of this duel');
        }

        const variant = row.variant as DuelVariant;
        const serverSeed = decryptSecret(
          row.server_seed_ciphertext, config.dataEncryptionKey, `duel:${row.id}`,
        );
        const schedule = scheduleFor(serverSeed, variant, body.roundIndex);

        /* The round's shared start, reconstructed from the duel's own start rather than from
         * anything the client sent. A client that could name its own round start could name a
         * reaction time to go with it. */
        const startedAt = row.started_at?.getTime() ?? arrivedAt;
        const roundStart = startedAt + body.roundIndex * (
          ROUND_LEAD_MS + VARIANT_RULES[variant].roundMs + INPUT_GRACE_MS
        ) + ROUND_LEAD_MS;

        const verdictResult = judge(variant, schedule, {
          reportedMs: body.reportedMs,
          arrivedMs: Math.max(0, arrivedAt - roundStart),
          symbols: body.symbols,
        });

        /* ON CONFLICT DO NOTHING: one input per player per round, first one counts. Without it a
         * client could send five and keep its best, which is the cheapest cheat there is. */
        await client.query(
          `INSERT INTO duel_rounds
             (duel_id, round_index, user_id, cue_offset_ms, target_offset_ms,
              reported_ms, arrived_ms, verdict, score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (duel_id, round_index, user_id) DO NOTHING`,
          [
            row.id, body.roundIndex, userId,
            schedule.cueOffsetMs, schedule.targetOffsetMs,
            body.reportedMs, Math.max(0, arrivedAt - roundStart),
            verdictResult.verdict, verdictResult.score,
          ],
        );
      });

      /* Both in? Score the round now rather than waiting out the clock — a duel where both players
       * have already answered should not sit there running down a timer. */
      const both = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM duel_rounds r
           JOIN duel_lobbies d ON d.id = r.duel_id
          WHERE d.code = $1 AND r.round_index = $2`,
        [code, body.roundIndex],
      );
      if (Number(both.rows[0]?.count ?? 0) >= 2) void closeRound(code, body.roundIndex);
      return { ok: true };
    },
  );

  /**
   * Scores one round, tells both clients, and either starts the next or settles.
   *
   * Reachable from the input handler (both answered) and from the round timer (the window shut),
   * so it must be idempotent. The `scored` guard below is what makes it so.
   */
  const scored = new Set<string>();
  async function closeRound(code: string, roundIndex: number): Promise<void> {
    const key = `${code}:${roundIndex}`;
    if (scored.has(key)) return;
    scored.add(key);

    try {
      const row = await readDuel(db, code);
      if (!row || row.status !== 'running' || !row.opponent_user_id) return;

      const rounds = await db.query<{
        round_index: number; user_id: string; verdict: string; score: number | null;
      }>(
        `SELECT round_index, user_id, verdict, score FROM duel_rounds
          WHERE duel_id = $1 ORDER BY round_index`,
        [row.id],
      );

      const scoreFor = (index: number, userId: string) =>
        rounds.rows.find((r) => r.round_index === index && r.user_id === userId) ?? null;

      const thisHost = scoreFor(roundIndex, row.host_user_id);
      const thisOpponent = scoreFor(roundIndex, row.opponent_user_id);

      const tally: RoundResult[] = [];
      for (let index = 0; index <= roundIndex; index += 1) {
        tally.push({
          roundIndex: index,
          hostScore: scoreFor(index, row.host_user_id)?.score ?? null,
          opponentScore: scoreFor(index, row.opponent_user_id)?.score ?? null,
        });
      }
      const running = resolveDuel(tally);

      hub.broadcast(code, {
        type: 'duel:scored',
        code,
        roundIndex,
        hostScore: thisHost?.score ?? null,
        opponentScore: thisOpponent?.score ?? null,
        hostVerdict: thisHost?.verdict ?? 'too_late',
        opponentVerdict: thisOpponent?.verdict ?? 'too_late',
        hostRounds: running.hostRounds,
        opponentRounds: running.opponentRounds,
      });

      if (roundIndex + 1 < row.rounds_total) {
        void startRound(row, roundIndex + 1);
        return;
      }

      const final = resolveDuel(tally);
      const winnerUserId = final.winner === 'host'
        ? row.host_user_id
        : final.winner === 'opponent' ? row.opponent_user_id : null;

      const settled = await db.transaction((client) =>
        settleDuel(client, row, final.outcome === 'draw' ? 'draw' : 'decided', winnerUserId),
      );
      if (settled) {
        hub.broadcast(code, { type: 'duel:settled', code, duel: publicDuel(settled, null) });
      }
    } catch (error) {
      app.log.error({ error, code, roundIndex }, 'duel round close failed');
    }
  }

  /* ─────────────────────────── cancel ─────────────────────────── */

  app.post(
    '/v1/duels/:code/cancel',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const { code } = parseWith(z.object({ code: z.string().regex(/^[A-Z0-9]{6,12}$/) }), request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const result = await db.transaction(async (client) => {
        const locked = await client.query<DuelRow>(
          `${SELECT_DUEL} WHERE d.code = $1 FOR UPDATE OF d`, [code],
        );
        const row = locked.rows[0];
        if (!row) throw new AppError(404, 'DUEL_NOT_FOUND', 'No such duel');
        if (row.host_user_id !== userId) {
          throw new AppError(403, 'NOT_THE_HOST', 'Only the host can cancel');
        }
        /* Only an unjoined lobby. Once an opponent has staked, the host walking away is a forfeit
         * and not a cancellation — otherwise "cancel" is a free undo for whoever is losing. */
        if (row.status !== 'lobby') {
          throw new AppError(409, 'DUEL_IN_PROGRESS', 'That duel has already started');
        }
        await client.query(
          `UPDATE duel_lobbies SET status = 'cancelled' WHERE id = $1 AND status = 'lobby'`,
          [row.id],
        );
        await creditWallet(
          client, userId, BigInt(row.stake_minor), 'duel_refund',
          deterministicUuid('duel_refund', row.id, 'host'),
        );
        return row;
      });

      hub.broadcastLobby({ type: 'duel:removed', code });
      hub.broadcast(code, { type: 'duel:cancelled', code, reason: 'The host cancelled' });
      return { ok: true, refundedMinor: result.stake_minor };
    },
  );

  /* ─────────────────────────── the socket ─────────────────────────── */

  app.get('/v1/duels/live', { websocket: true }, (socket) => {
    /* Null, deliberately — this route runs no authentication preHandler, so the previous
     * `request.authUser?.id` was always undefined. See the matching note in battles.ts. */
    const subscriber = hub.add(socket, null);
    const budget = createSocketBudget(LOBBY_SOCKET_BUDGET);

    socket.on('message', (raw: Buffer) => {
      if (!budget.take()) return;
      /* An explicit size check as well as the server-wide `maxPayload`: this handler should not
       * depend on a plugin option registered in another file to keep a 4KB ceiling. */
      if (raw.length > 4096) return;
      let frame: { type?: string; code?: string };
      try {
        frame = JSON.parse(raw.toString('utf8')) as { type?: string; code?: string };
      } catch {
        hub.send(subscriber, { type: 'error', message: 'Malformed frame' });
        return;
      }
      if (frame.type === 'ping') {
        hub.send(subscriber, { type: 'pong', now: Date.now() });
        return;
      }
      /* Room codes are validated to their real shape before they are used as a key, matching the
       * battles socket. An unvalidated string went straight into the subscriber's room set, so a
       * client could pin arbitrary multi-kilobyte keys in memory instead of six-character codes. */
      if (typeof frame.code !== 'string' || !/^[A-Z0-9]{6,12}$/.test(frame.code)) return;
      if (frame.type === 'watch') hub.join(subscriber, frame.code);
      else if (frame.type === 'unwatch') hub.leave(subscriber, frame.code);
    });

    socket.on('close', () => {
      if (budget.refused > 0) {
        app.log.warn({ refused: budget.refused }, 'duel socket exceeded its frame budget');
      }
      hub.remove(subscriber);
    });
  });
}
