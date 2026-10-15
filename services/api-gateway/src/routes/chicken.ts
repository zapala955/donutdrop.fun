import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager, type WagerOutcome } from '../lib/cash-settlement.js';
import {
  CHICKEN_HOUSE_EDGE_BPS,
  CHICKEN_LANES,
  CHICKEN_MODES,
  CHICKEN_MODE_NAMES,
  type ChickenMode,
  cartLane,
  multiplierBps,
  payoutFor,
  safeChanceBps,
} from '../lib/chicken.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { announceWin } from '../lib/discord-flex.js';
import { flexName } from '../lib/media-test.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { publishLiveSoon } from '../lib/live-events.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Chicken, one run across several requests: start, then step across the rails a lane at a time
 * until the player cashes out, a minecart comes down the lane stepped into, or all twenty are
 * crossed.
 *
 * The lane with the minecart is fixed at the start from the player's committed fairness seed, which
 * is spent then (and a fresh one committed for next time), so the whole road is decided before the
 * first step. It stays in the row and never reaches a browser until the run is over; the seed is
 * revealed with it.
 *
 * Money moves twice: the stake when the run starts, the payout when it ends. There is no refund
 * path. The wager is recorded once, at settlement. The shape is Tower's (routes/tower.ts), lane for
 * floor.
 */

const clientSeedSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 128, 'Must not exceed 128 UTF-8 bytes')
  .refine(
    (value) => ![...value].some((c) => (c.codePointAt(0) ?? 0) <= 31 || c.codePointAt(0) === 127),
    'Must not contain control characters',
  );

const startSchema = z
  .object({
    stakeMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    mode: z.enum(CHICKEN_MODE_NAMES as [ChickenMode, ...ChickenMode[]]),
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/* The lane the player was looking at when they pressed Go (0-based: the lanes crossed so far). A
 * second press arriving for a lane the run has already left is refused, instead of taking a step
 * nobody asked for. */
const stepSchema = z.object({ lane: z.number().int().min(0).max(CHICKEN_LANES - 1) }).strict();
const cashoutSchema = z.object({ crossed: z.number().int().min(1).max(CHICKEN_LANES) }).strict();

const idSchema = z.object({ id: z.uuid() }).strict();
const historySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

/* Retries for a serialization conflict, spaced out; see routes/mines.ts, whose numbers these are. */
const RETRIES = 12;

async function serializable<T>(db: Database, work: (client: DbClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(work, 0);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < RETRIES) {
        const ceiling = Math.min(400, 8 * 2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, ceiling * (0.5 + Math.random())));
        continue;
      }
      throw error;
    }
  }
}

interface GameRow {
  id: string;
  user_id: string;
  request_hash: string;
  stake_minor: string;
  mode: ChickenMode;
  cart_lane: number | null;
  crossed: number;
  max_payout_minor: string;
  status: 'active' | 'settled';
  outcome: 'cashout' | 'hit' | null;
  payout_minor: string | null;
  fairness_seed_id: string;
  server_seed_hash: string;
  server_seed_reveal: string | null;
  client_seed: string;
  nonce: number;
  created_at: Date;
  settled_at: Date | null;
}

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

function cappedPayout(row: GameRow, crossed: number): bigint {
  if (crossed === 0) return 0n;
  const payout = payoutFor(BigInt(row.stake_minor), row.mode, crossed);
  const cap = BigInt(row.max_payout_minor);
  return payout > cap ? cap : payout;
}

/**
 * What the player may see. While the run is in play the minecart's lane is absent -- it is in the
 * database, and it never leaves it until the run is over. Every lane's multiplier is public: it is
 * a function of the mode alone.
 */
function gameView(row: GameRow) {
  const settled = row.status === 'settled';
  const crossed = row.crossed;
  const more = !settled && crossed < CHICKEN_LANES;
  return {
    id: row.id,
    status: row.status,
    stakeMinor: row.stake_minor,
    mode: row.mode,
    lanes: CHICKEN_LANES,
    crossed,
    multiplierBps: crossed > 0 ? multiplierBps(row.mode, crossed) : null,
    cashoutMinor: cappedPayout(row, crossed).toString(),
    nextMultiplierBps: more ? multiplierBps(row.mode, crossed + 1) : null,
    nextPayoutMinor: more ? cappedPayout(row, crossed + 1).toString() : null,
    safeChanceBps: safeChanceBps(row.mode),
    maxPayoutMinor: row.max_payout_minor,
    outcome: row.outcome,
    payoutMinor: row.payout_minor,
    // Only once the run is over: the lane the minecart came down, or null for a clear road.
    cartLane: settled ? row.cart_lane : undefined,
    fairness: {
      serverSeedHash: row.server_seed_hash,
      clientSeed: row.client_seed,
      nonce: row.nonce,
      serverSeed: settled ? row.server_seed_reveal : null,
    },
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

interface Settlement {
  row: GameRow;
  payout: bigint;
  wager: WagerOutcome;
}

export async function registerChickenRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/chicken/config', async () => ({
    enabled: config.chickenEnabled,
    minStakeMinor: config.chickenMinStakeMinor.toString(),
    maxStakeMinor: config.chickenMaxStakeMinor.toString(),
    maxPayoutMinor: config.chickenMaxPayoutMinor.toString(),
    houseEdgeBps: CHICKEN_HOUSE_EDGE_BPS,
    lanes: CHICKEN_LANES,
    modes: CHICKEN_MODE_NAMES.map((mode) => ({
      mode,
      hit: CHICKEN_MODES[mode].hit,
      of: CHICKEN_MODES[mode].of,
      safeChanceBps: safeChanceBps(mode),
      // The multiplier for cashing out after each lane, first lane first.
      multipliersBps: Array.from({ length: CHICKEN_LANES }, (_, lane) => multiplierBps(mode, lane + 1)),
    })),
    algorithm: 'HMAC-SHA256-v1:lane-draw',
  }));

  app.get('/v1/chicken/games/active', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const result = await db.query<GameRow>(
      "SELECT * FROM chicken_games WHERE user_id = $1 AND status = 'active'",
      [userId],
    );
    const row = result.rows[0];
    return { game: row ? gameView(row) : null };
  });

  app.get('/v1/chicken/games', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const result = await db.query<GameRow>(
      `SELECT * FROM chicken_games WHERE user_id = $1 AND status = 'settled'
        ORDER BY created_at DESC LIMIT $2`,
      [userId, query.limit],
    );
    return { games: result.rows.map(gameView) };
  });

  app.post(
    '/v1/chicken/games',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);
      const body = parseWith(startSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      const stake = BigInt(body.stakeMinor);

      const row = await serializable(db, async (client) => {
        const existing = await client.query<GameRow>(
          'SELECT * FROM chicken_games WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return existing.rows[0];
        }

        /* Closing the game stops new runs. It never strands one in play: stepping and cashing out
         * work whatever this says, because the stake is already down. */
        if (!config.chickenEnabled) {
          throw new AppError(503, 'CHICKEN_CLOSED', 'Chicken is closed right now');
        }
        if (stake < config.chickenMinStakeMinor || stake > config.chickenMaxStakeMinor) {
          throw new AppError(
            400,
            'STAKE_OUT_OF_RANGE',
            `A run stakes between ${config.chickenMinStakeMinor.toString()} and ${config.chickenMaxStakeMinor.toString()}`,
          );
        }

        await assertGameEligible(client, userId);
        const active = await client.query(
          "SELECT 1 FROM chicken_games WHERE user_id = $1 AND status = 'active'",
          [userId],
        );
        if (active.rowCount) conflict('GAME_IN_PLAY', 'Finish the run you are on first');

        const fairnessResult = await client.query<FairnessRow>(
          `SELECT id, server_seed_ciphertext, server_seed_hash, nonce
             FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
          [userId],
        );
        const fairness = fairnessResult.rows[0];
        if (!fairness) {
          throw new AppError(
            409,
            'FAIRNESS_COMMITMENT_REQUIRED',
            'Fetch the current server-seed commitment before starting',
          );
        }
        if (fairness.server_seed_hash !== body.serverSeedHash) {
          conflict('FAIRNESS_COMMITMENT_CHANGED', 'The supplied server-seed commitment is no longer active');
        }
        const serverSeed = decryptSecret(
          fairness.server_seed_ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${fairness.id}`,
        );
        if (hashServerSeed(serverSeed) !== fairness.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }

        const gameId = randomUUID();
        await debit(client, userId, stake, gameId);

        /* The seed is spent now, not at settlement: it has fixed this road, and the next run the
         * player starts must not be able to draw from it. It is revealed when the run ends. */
        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [fairness.id]);
        await insertFairnessSeed(client, config, userId);

        const inserted = await client.query<GameRow>(
          `INSERT INTO chicken_games
             (id, user_id, idempotency_key, request_hash, stake_minor, mode, cart_lane,
              max_payout_minor, fairness_seed_id, server_seed_hash, client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            gameId,
            userId,
            idempotencyKey,
            requestHash,
            stake.toString(),
            body.mode,
            cartLane(serverSeed, body.clientSeed, fairness.nonce, body.mode),
            config.chickenMaxPayoutMinor.toString(),
            fairness.id,
            fairness.server_seed_hash,
            body.clientSeed,
            fairness.nonce,
          ],
        );
        const game = inserted.rows[0];
        if (!game) throw new Error('Chicken run insert returned no row');
        return game;
      });

      publishLiveSoon('balance', [userId]);
      const balance = await balanceOf(db, userId);
      return reply.code(201).send({ game: gameView(row), balanceMinor: balance });
    },
  );

  app.post(
    '/v1/chicken/games/:id/step',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const params = parseWith(idSchema, request.params);
      const body = parseWith(stepSchema, request.body);

      const result = await serializable(db, async (client) => {
        const row = await lockGame(client, params.id, userId);
        // Asked again after the run ended: the answer is the finished run, not an error.
        if (row.status !== 'active') return { row, settled: null as Settlement | null };
        if (row.crossed !== body.lane) {
          conflict('STALE_ACTION', 'The run moved on before that arrived');
        }

        if (row.cart_lane === row.crossed) {
          const settled = await settle(client, config, row, 'hit');
          return { row: settled.row, settled };
        }

        const updated = await client.query<GameRow>(
          `UPDATE chicken_games SET crossed = crossed + 1
            WHERE id = $1 AND status = 'active'
            RETURNING *`,
          [row.id],
        );
        const next = updated.rows[0];
        if (!next) throw new Error('Chicken step returned no row');

        /* Nothing left worth risking: the last lane is crossed, or the payout has reached the
         * ceiling and a further lane could only lose. Either way it cashes out on its own. */
        const end = next.crossed === CHICKEN_LANES;
        const capped =
          payoutFor(BigInt(next.stake_minor), next.mode, next.crossed) >= BigInt(next.max_payout_minor);
        if (end || capped) {
          const settled = await settle(client, config, next, 'cashout');
          return { row: settled.row, settled };
        }
        return { row: next, settled: null as Settlement | null };
      });

      announce(config, flexName(request.authUser), result.settled, app.log);
      return { game: gameView(result.row), balanceMinor: await balanceOf(db, userId) };
    },
  );

  app.post(
    '/v1/chicken/games/:id/cashout',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const params = parseWith(idSchema, request.params);
      const body = parseWith(cashoutSchema, request.body);

      const result = await serializable(db, async (client) => {
        const row = await lockGame(client, params.id, userId);
        // A second click lands here after the first settled it: return that result, pay nothing.
        if (row.status !== 'active') return { row, settled: null as Settlement | null };
        if (row.crossed !== body.crossed) {
          conflict('STALE_ACTION', 'The run moved on before that arrived');
        }
        const settled = await settle(client, config, row, 'cashout');
        return { row: settled.row, settled };
      });

      announce(config, flexName(request.authUser), result.settled, app.log);
      return { game: gameView(result.row), balanceMinor: await balanceOf(db, userId) };
    },
  );
}

async function lockGame(client: DbClient, id: string, userId: string): Promise<GameRow> {
  const locked = await client.query<GameRow>(
    'SELECT * FROM chicken_games WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [id, userId],
  );
  const row = locked.rows[0];
  if (!row) throw new AppError(404, 'GAME_NOT_FOUND', 'No such run');
  return row;
}

/** Pays out, reveals the road and the seed, and records the wager -- everything a finished run owes. */
async function settle(
  client: DbClient,
  config: AppConfig,
  row: GameRow,
  outcome: 'cashout' | 'hit',
): Promise<Settlement> {
  if (outcome === 'cashout' && row.crossed === 0) {
    conflict('NOTHING_TO_CASH', 'Cross at least one lane before cashing out');
  }
  const seed = await client.query<{ server_seed_ciphertext: string }>(
    'SELECT server_seed_ciphertext FROM fairness_seeds WHERE id = $1',
    [row.fairness_seed_id],
  );
  const ciphertext = seed.rows[0]?.server_seed_ciphertext;
  if (!ciphertext) throw new Error('Chicken run lost its fairness seed');
  const serverSeed = decryptSecret(
    ciphertext,
    config.dataEncryptionKey,
    `fairness:${row.user_id}:${row.fairness_seed_id}`,
  );
  if (hashServerSeed(serverSeed) !== row.server_seed_hash) {
    throw new Error('Stored fairness seed does not match its commitment');
  }

  const payout = outcome === 'cashout' ? cappedPayout(row, row.crossed) : 0n;
  if (payout > 0n) await creditWallet(client, row.user_id, payout, 'chicken_payout', row.id);
  const settled = await client.query<GameRow>(
    `UPDATE chicken_games
        SET status = 'settled', outcome = $2, payout_minor = $3,
            server_seed_reveal = $4, settled_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [row.id, outcome, payout.toString(), serverSeed],
  );
  const saved = settled.rows[0];
  if (!saved) throw new Error('Chicken run was settled twice');
  const wager = await recordWager(client, config, row.user_id, BigInt(row.stake_minor), 'chicken', row.id, [
    'wagered_minor',
  ]);
  return { row: saved, payout, wager };
}

/** Takes the stake off the wallet, refusing an overdraft, and writes the ledger line for it. */
async function debit(client: DbClient, userId: string, amount: bigint, gameId: string): Promise<void> {
  await client.query(
    `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const debited = await client.query<{ balance_minor: string }>(
    `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
      WHERE user_id = $1 AND balance_minor >= $2
      RETURNING balance_minor`,
    [userId, amount.toString()],
  );
  const balanceAfter = debited.rows[0]?.balance_minor;
  if (balanceAfter === undefined) {
    throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for that stake');
  }
  await client.query(
    `INSERT INTO wallet_transactions (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
     VALUES ($1, $2, $3, $4, 'chicken_stake', $5)`,
    [randomUUID(), userId, (-amount).toString(), balanceAfter, gameId],
  );
}

async function insertFairnessSeed(client: DbClient, config: AppConfig, userId: string) {
  const id = randomUUID();
  const seed = generateServerSeed();
  await client.query(
    `INSERT INTO fairness_seeds(id, user_id, server_seed_ciphertext, server_seed_hash, nonce)
     VALUES ($1, $2, $3, $4, 0)`,
    [
      id,
      userId,
      encryptSecret(seed, config.dataEncryptionKey, `fairness:${userId}:${id}`),
      hashServerSeed(seed),
    ],
  );
}

async function balanceOf(db: Database, userId: string): Promise<string> {
  const result = await db.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM user_wallets WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.balance_minor ?? '0';
}

/* After the commit, never inside it, and never awaited: a slow webhook is not a slow payout. */
function announce(
  config: AppConfig,
  username: string | undefined,
  settled: Settlement | null,
  logger: { error: (context: unknown, message: string) => void },
): void {
  if (!settled) return;
  // A finished run is a new row in the live feed.
  publishLiveSoon('activity');
  if (!username) return;
  const stake = BigInt(settled.row.stake_minor);
  if (settled.payout > stake) {
    void announceWin(
      config,
      {
        username,
        amountMinor: settled.payout,
        mode: 'Chicken',
        multiplier: Number(settled.payout) / Number(stake),
        path: '/chicken',
      },
      logger,
    );
  }
  // The jackpot draws on every wager, a lost run included.
  const jackpotWin = settled.wager.jackpot.win;
  if (jackpotWin) {
    void announceWin(
      config,
      { username, amountMinor: jackpotWin.amountMinor, mode: 'Vault Jackpot', path: '/chicken' },
      logger,
    );
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
