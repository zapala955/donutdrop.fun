import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { recordWager, creditWallet } from '../lib/cash-settlement.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import {
  rouletteColor,
  roulettePayout,
  roulettePayoutBps,
  rouletteResult,
  type RouletteSelection,
} from '../lib/roulette.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

const selectionSchema = z.union([
  z.string().regex(/^straight:([0-9]|[12][0-9]|3[0-6])$/),
  z.enum(['red', 'black', 'odd', 'even', 'low', 'high', 'dozen:1', 'dozen:2', 'dozen:3']),
]);

const betSchema = z
  .object({
    roundId: z.uuid(),
    selection: selectionSchema,
    stakeMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  })
  .strict();

interface RoundRow {
  id: string;
  status: 'open' | 'settled';
  server_seed_hash: string;
  server_seed_ciphertext: string;
  server_seed_reveal: string | null;
  rng_digest: string | null;
  result: number | null;
  opens_at: Date;
  closes_at: Date;
  settled_at: Date | null;
  total_staked_minor: string;
  total_payout_minor: string;
  bet_count: number;
}

interface BetRow {
  id: string;
  round_id: string;
  user_id: string;
  selection: RouletteSelection;
  stake_minor: string;
  payout_bps: number;
  payout_minor: string | null;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  settled_at: Date | null;
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      // The wheel and its commitment are public; only the viewer's own chips require a session.
    }
  };
}

function roundView(row: RoundRow) {
  return {
    id: row.id,
    status: row.status,
    opensAt: row.opens_at.toISOString(),
    closesAt: row.closes_at.toISOString(),
    settledAt: row.settled_at?.toISOString() ?? null,
    serverSeedHash: row.server_seed_hash,
    serverSeed: row.server_seed_reveal,
    rngDigest: row.rng_digest,
    result: row.result,
    color: row.result === null ? null : rouletteColor(row.result),
    totalStakedMinor: row.total_staked_minor,
    totalPayoutMinor: row.total_payout_minor,
    betCount: row.bet_count,
  };
}

function betView(row: BetRow) {
  return {
    id: row.id,
    roundId: row.round_id,
    selection: row.selection,
    stakeMinor: row.stake_minor,
    payoutBps: row.payout_bps,
    payoutMinor: row.payout_minor,
    createdAt: row.created_at.toISOString(),
    settledAt: row.settled_at?.toISOString() ?? null,
  };
}

async function createRound(client: DbClient, config: AppConfig): Promise<RoundRow> {
  const id = randomUUID();
  const seed = generateServerSeed();
  const inserted = await client.query<RoundRow>(
    `INSERT INTO roulette_rounds
       (id, server_seed_hash, server_seed_ciphertext, closes_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     RETURNING *`,
    [
      id,
      hashServerSeed(seed),
      encryptSecret(seed, config.dataEncryptionKey, `roulette:${id}`),
      config.rouletteRoundSeconds,
    ],
  );
  const round = inserted.rows[0];
  if (!round) throw new Error('Roulette round insert returned no row');
  return round;
}

/** Settle every due shared round and return the one betting window currently open. */
async function currentRound(client: DbClient, config: AppConfig): Promise<RoundRow> {
  /* The common path is read-only. Hundreds of viewers can read the same active round without
   * queueing behind an exclusive row/advisory lock; only the request that notices a missing or
   * expired round enters the rollover path below. */
  const visible = await client.query<RoundRow>(
    `SELECT * FROM roulette_rounds WHERE status = 'open' ORDER BY opens_at LIMIT 1`,
  );
  const visibleRound = visible.rows[0];
  if (visibleRound && visibleRound.closes_at.getTime() > Date.now()) return visibleRound;

  // The partial unique index is the final invariant; this lock makes the very first request clean
  // too. Without it, two fresh API processes can both observe no row and one receives a uniqueness
  // error even though the other successfully created the shared table.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('roulette:shared-round', 8831))",
  );
  const selected = await client.query<RoundRow>(
    `SELECT * FROM roulette_rounds WHERE status = 'open'
     ORDER BY opens_at LIMIT 1 FOR UPDATE`,
  );
  const round = selected.rows[0];
  if (!round) return createRound(client, config);
  if (round.closes_at.getTime() > Date.now()) return round;

  const seed = decryptSecret(
    round.server_seed_ciphertext,
    config.dataEncryptionKey,
    `roulette:${round.id}`,
  );
  if (hashServerSeed(seed) !== round.server_seed_hash) {
    throw new Error(`Roulette seed commitment mismatch for ${round.id}`);
  }
  const outcome = rouletteResult(seed, round.id);
  const bets = await client.query<BetRow>(
    'SELECT * FROM roulette_bets WHERE round_id = $1 ORDER BY created_at, id FOR UPDATE',
    [round.id],
  );

  let totalStaked = 0n;
  let totalPayout = 0n;
  for (const bet of bets.rows) {
    const stake = BigInt(bet.stake_minor);
    const payout = roulettePayout(stake, bet.selection, outcome.result, bet.payout_bps);
    totalStaked += stake;
    totalPayout += payout;
    await client.query(
      `UPDATE roulette_bets SET payout_minor = $2, settled_at = now()
        WHERE id = $1 AND settled_at IS NULL`,
      [bet.id, payout.toString()],
    );
    if (payout > 0n) {
      await creditWallet(client, bet.user_id, payout, 'roulette_win', bet.id);
    }
  }

  await client.query(
    `UPDATE roulette_rounds
        SET status = 'settled', server_seed_reveal = $2, rng_digest = $3, result = $4,
            settled_at = now(), total_staked_minor = $5, total_payout_minor = $6,
            bet_count = $7
      WHERE id = $1 AND status = 'open'`,
    [
      round.id,
      seed,
      outcome.digest,
      outcome.result,
      totalStaked.toString(),
      totalPayout.toString(),
      bets.rows.length,
    ],
  );
  return createRound(client, config);
}

export async function registerRouletteRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  function assertEnabled(): void {
    if (!config.rouletteEnabled) {
      throw new AppError(404, 'ROULETTE_DISABLED', 'Roulette is not switched on');
    }
  }

  app.get('/v1/roulette', { preHandler: softAuth }, async (request) => {
    assertEnabled();
    const viewerId = request.authUser?.id ?? null;
    return db.transaction(async (client) => {
      const round = await currentRound(client, config);
      const [history, pools, mine, previousMine] = await Promise.all([
        client.query<RoundRow>(
          `SELECT * FROM roulette_rounds WHERE status = 'settled'
           ORDER BY closes_at DESC LIMIT 12`,
        ),
        client.query<{ selection: RouletteSelection; amount_minor: string }>(
          `SELECT selection, sum(stake_minor)::text AS amount_minor
             FROM roulette_bets WHERE round_id = $1 GROUP BY selection`,
          [round.id],
        ),
        viewerId
          ? client.query<BetRow>(
              `SELECT * FROM roulette_bets WHERE round_id = $1 AND user_id = $2
               ORDER BY created_at, id`,
              [round.id, viewerId],
            )
          : Promise.resolve({ rows: [] as BetRow[] }),
        viewerId
          ? client.query<BetRow>(
              `SELECT * FROM roulette_bets
                WHERE user_id = $1 AND round_id = (
                  SELECT id FROM roulette_rounds WHERE status = 'settled'
                  ORDER BY closes_at DESC LIMIT 1
                )
                ORDER BY created_at, id`,
              [viewerId],
            )
          : Promise.resolve({ rows: [] as BetRow[] }),
      ]);

      const sample = {
        straight: 'straight:0' as const,
        dozen: 'dozen:1' as const,
        evenMoney: 'red' as const,
      };
      return {
        serverTime: new Date().toISOString(),
        round: roundView(round),
        history: history.rows.map(roundView),
        pools: Object.fromEntries(pools.rows.map((row) => [row.selection, row.amount_minor])),
        yourBets: mine.rows.map(betView),
        yourPreviousBets: previousMine.rows.map(betView),
        config: {
          minStakeMinor: config.rouletteMinStakeMinor.toString(),
          maxStakeMinor: config.rouletteMaxStakeMinor.toString(),
          roundSeconds: config.rouletteRoundSeconds,
          houseEdgeBps: config.houseEdgeBps,
          payoutBps: {
            straight: roulettePayoutBps(sample.straight, config.houseEdgeBps),
            dozen: roulettePayoutBps(sample.dozen, config.houseEdgeBps),
            evenMoney: roulettePayoutBps(sample.evenMoney, config.houseEdgeBps),
          },
        },
      };
    });
  });

  app.post(
    '/v1/roulette/bets',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      assertEnabled();
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
      const body = parseWith(betSchema, request.body);
      const selection = body.selection as RouletteSelection;
      const stake = BigInt(body.stakeMinor);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));

      if (stake < config.rouletteMinStakeMinor || stake > config.rouletteMaxStakeMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_BAND', 'That chip is outside the roulette limits');
      }

      const placed = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8831))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const replayed = await client.query<BetRow>(
          'SELECT * FROM roulette_bets WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (replayed.rows[0]) {
          if (replayed.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different bet');
          }
          return { bet: replayed.rows[0], balanceAfterMinor: null, replay: true };
        }

        await assertGameEligible(client, userId);
        const visibleRound = await currentRound(client, config);
        /* A share lock lets many players place chips concurrently, but makes settlement wait until
         * every accepted debit and bet row has committed. If rollover won the race, this query
         * returns nothing and the stale request cannot land on the next spin by accident. */
        const active = await client.query<RoundRow>(
          `SELECT * FROM roulette_rounds
            WHERE id = $1 AND status = 'open' FOR SHARE`,
          [visibleRound.id],
        );
        const round = active.rows[0];
        if (!round) conflict('ROUND_CHANGED', 'That roulette round has closed');
        // The locked round is re-checked on the write path. A stale browser cannot squeeze a chip
        // into the previous result after its timer reaches zero.
        if (round.id !== body.roundId) {
          conflict('ROUND_CHANGED', 'That roulette round has closed');
        }
        if (round.closes_at.getTime() <= Date.now()) {
          conflict('ROUND_CLOSED', 'That roulette round has closed');
        }

        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 AND balance_minor >= $2 RETURNING balance_minor`,
          [userId, stake.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) {
          throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for that chip');
        }

        const id = randomUUID();
        const payoutBps = roulettePayoutBps(selection, config.houseEdgeBps);
        const inserted = await client.query<BetRow>(
          `INSERT INTO roulette_bets
             (id, round_id, user_id, selection, stake_minor, payout_bps,
              idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            id,
            round.id,
            userId,
            selection,
            stake.toString(),
            payoutBps,
            idempotencyKey,
            requestHash,
          ],
        );
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'roulette_stake', $5)`,
          [randomUUID(), userId, (-stake).toString(), balanceAfter, id],
        );
        await recordWager(client, config, userId, stake, 'roulette', id, ['wagered_minor']);
        const bet = inserted.rows[0];
        if (!bet) throw new Error('Roulette bet insert returned no row');
        return { bet, balanceAfterMinor: balanceAfter, replay: false };
      });

      return reply.code(placed.replay ? 200 : 201).send({
        bet: betView(placed.bet),
        balanceAfterMinor: placed.balanceAfterMinor,
        replay: placed.replay,
      });
    },
  );
}
