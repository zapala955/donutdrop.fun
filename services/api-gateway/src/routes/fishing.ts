import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager, type WagerOutcome } from '../lib/cash-settlement.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { announceWin } from '../lib/discord-flex.js';
import { AppError, conflict } from '../lib/errors.js';
import {
  FISHING_CATCHES,
  FISHING_GROWTH,
  FISHING_HOOK_MS,
  FISHING_HOUSE_EDGE_BPS,
  FISHING_LADDER,
  FISHING_MAX_X100,
  FISHING_MIN_LAND_X100,
  FISHING_SINKERS,
  catchAt,
  judge,
  maxStakeFor,
  multiplierAt,
  payoutAt,
  snapPoint,
  type FishingSinker,
} from '../lib/fishing.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { publishLiveSoon } from '../lib/live-events.js';
import { flexName } from '../lib/media-test.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Fishing, one cast across several requests, the way Chicken runs: the cast stakes and draws the
 * line's breaking point from the player's committed fairness seed; from the moment the lure goes
 * under the multiplier climbs on the server's clock; the player reels up, or the line is cut.
 *
 * Nothing waits on a timer. A cast is judged whenever it is asked about -- polled, landed, or found
 * open when the player casts again -- against the multiplier its line has reached by then: past its
 * auto-land target it has landed there, past its breaking point it has snapped. The breaking point
 * stays in the row until the cast settles; the seed is revealed with it.
 *
 * Money moves twice: the stake when the cast is made, the catch's pay when it lands. The wager is
 * recorded once, at settlement.
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

const castSchema = z
  .object({
    stakeMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    sinker: z.enum(FISHING_SINKERS),
    autoLandX100: z.number().int().min(FISHING_MIN_LAND_X100).max(FISHING_MAX_X100 - 1).nullable().default(null),
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const idSchema = z.object({ id: z.uuid() }).strict();
const historySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

/* Retried on a serialization conflict, spaced out: every settlement runs the wager hooks that every
 * other player's bet touches too. */
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

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

interface CastRow {
  id: string;
  user_id: string;
  request_hash: string;
  stake_minor: string;
  sinker: FishingSinker;
  auto_land_x100: number | null;
  snap_x100: number;
  hooked_at: Date;
  status: 'open' | 'landed' | 'snapped';
  landed_x100: number | null;
  catch: string | null;
  payout_minor: string;
  fairness_seed_id: string;
  server_seed_hash: string;
  server_seed_reveal: string | null;
  client_seed: string;
  nonce: number;
  created_at: Date;
  settled_at: Date | null;
  /* The database's clock when the row was read: every judgement is against it. */
  db_now: Date;
}

/**
 * What the player may see. While the cast is open the breaking point is absent -- it is in the
 * database and never leaves it until the cast is over.
 */
function castView(row: CastRow) {
  const settled = row.status !== 'open';
  const caught = row.catch ? FISHING_CATCHES[row.catch] : null;
  return {
    id: row.id,
    status: row.status,
    stakeMinor: row.stake_minor,
    sinker: row.sinker,
    growth: FISHING_GROWTH[row.sinker],
    autoLandX100: row.auto_land_x100,
    hookedAt: row.hooked_at.toISOString(),
    landedX100: row.landed_x100,
    catch: row.catch ? { id: row.catch, name: caught?.name ?? row.catch, kind: caught?.kind ?? 'fish' } : null,
    payoutMinor: row.payout_minor,
    // Only once the cast is over: where the line would have snapped.
    snapX100: settled ? row.snap_x100 : null,
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

/** The multiplier the cast's line has reached by the row's own clock. */
function reachedOf(row: CastRow): number {
  return multiplierAt(row.sinker, (row.db_now.getTime() - row.hooked_at.getTime()) / 1000);
}

interface Settlement {
  row: CastRow;
  wager: WagerOutcome;
}

export async function registerFishingRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/fishing/config', async () => ({
    enabled: config.fishingEnabled,
    minStakeMinor: config.fishingMinStakeMinor.toString(),
    maxStakeMinor: config.fishingMaxStakeMinor.toString(),
    maxPayoutMinor: config.fishingMaxPayoutMinor.toString(),
    houseEdgeBps: FISHING_HOUSE_EDGE_BPS,
    growth: FISHING_GROWTH,
    hookMs: FISHING_HOOK_MS,
    minLandX100: FISHING_MIN_LAND_X100,
    maxX100: FISHING_MAX_X100,
    catches: FISHING_CATCHES,
    // The catch ladder: from each multiplier up, what comes out of the water.
    ladder: FISHING_LADDER.map(([fromX100, id]) => ({ fromX100, id })),
    algorithm: 'HMAC-SHA256-v1:52bit-crash',
  }));

  app.get('/v1/fishing/casts', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const result = await db.query<CastRow>(
      `SELECT *, clock_timestamp() AS db_now FROM fishing_casts
        WHERE user_id = $1 AND status <> 'open' ORDER BY created_at DESC LIMIT $2`,
      [userId, query.limit],
    );
    return { casts: result.rows.map(castView) };
  });

  /* The cast in play, if any, judged as of now: a page opened mid-climb picks it up here. */
  app.get(
    '/v1/fishing/casts/active',
    { preHandler: guards.authenticate, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const result = await serializable(db, async (client) => {
        const locked = await client.query<CastRow>(
          `SELECT *, clock_timestamp() AS db_now FROM fishing_casts
            WHERE user_id = $1 AND status = 'open' FOR UPDATE`,
          [userId],
        );
        const row = locked.rows[0];
        return row ? advance(client, config, row) : null;
      });
      settled(config, flexName(request.authUser), result?.settled ?? null, app.log);
      return {
        cast: result ? castView(result.row) : null,
        serverNow: (result?.row.db_now ?? new Date()).toISOString(),
        balanceMinor: await balanceOf(db, userId),
      };
    },
  );

  /* Asked several times a second while the line climbs: its own limit, well past the API's default. */
  app.get(
    '/v1/fishing/casts/:id',
    { preHandler: guards.authenticate, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const params = parseWith(idSchema, request.params);
      const result = await serializable(db, async (client) => advance(client, config, await lockCast(client, params.id, userId)));
      settled(config, flexName(request.authUser), result.settled, app.log);
      return {
        cast: castView(result.row),
        serverNow: result.row.db_now.toISOString(),
        balanceMinor: result.row.status === 'open' ? null : await balanceOf(db, userId),
      };
    },
  );

  app.post(
    '/v1/fishing/casts',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);
      const body = parseWith(castSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      const stake = BigInt(body.stakeMinor);

      const result = await serializable(db, async (client) => {
        const existing = await client.query<CastRow>(
          'SELECT *, clock_timestamp() AS db_now FROM fishing_casts WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          // A retried request gets its original answer, and stakes nothing a second time.
          return { row: existing.rows[0], previous: null as Settlement | null };
        }

        /* Closing the game stops new casts. It never strands one in play: polling and landing work
         * whatever this says, because the stake is already down. */
        if (!config.fishingEnabled) throw new AppError(503, 'FISHING_CLOSED', 'Fishing is closed right now');
        if (stake < config.fishingMinStakeMinor || stake > config.fishingMaxStakeMinor) {
          throw new AppError(
            400,
            'STAKE_OUT_OF_RANGE',
            `A cast stakes between ${config.fishingMinStakeMinor.toString()} and ${config.fishingMaxStakeMinor.toString()}`,
          );
        }
        /* Refused, not capped: a capped landing would pay less than the multiplier on the line. */
        const ceiling = maxStakeFor(config.fishingMaxPayoutMinor);
        if (stake > ceiling) {
          throw new AppError(400, 'STAKE_OVER_PAYOUT_LIMIT', `The largest cast is ${ceiling.toString()}`);
        }

        await assertGameEligible(client, userId);

        /* A cast left open -- a closed tab, a lost connection -- is judged first: landed by its
         * target, snapped, or still climbing, in which case this one waits. */
        let previous: Settlement | null = null;
        const open = await client.query<CastRow>(
          `SELECT *, clock_timestamp() AS db_now FROM fishing_casts
            WHERE user_id = $1 AND status = 'open' FOR UPDATE`,
          [userId],
        );
        if (open.rows[0]) {
          const judged = await advance(client, config, open.rows[0]);
          if (judged.row.status === 'open') conflict('CAST_IN_PLAY', 'Land the cast you are on first');
          previous = judged.settled;
        }

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
            'Fetch the current server-seed commitment before casting',
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

        const castId = randomUUID();
        await debit(client, userId, stake, castId);

        /* The seed is spent now, not at settlement: it has fixed this line, and the next cast must
         * not be able to draw from it. It is revealed when the cast ends. */
        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [fairness.id]);
        await insertFairnessSeed(client, config, userId);

        const { snapX100 } = snapPoint(serverSeed, body.clientSeed, fairness.nonce);
        const inserted = await client.query<CastRow>(
          `INSERT INTO fishing_casts
             (id, user_id, idempotency_key, request_hash, stake_minor, sinker, auto_land_x100, snap_x100,
              hooked_at, fairness_seed_id, server_seed_hash, client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp() + make_interval(secs => $9),
                   $10, $11, $12, $13)
           RETURNING *, clock_timestamp() AS db_now`,
          [
            castId,
            userId,
            idempotencyKey,
            requestHash,
            stake.toString(),
            body.sinker,
            body.autoLandX100,
            snapX100,
            FISHING_HOOK_MS / 1000,
            fairness.id,
            fairness.server_seed_hash,
            body.clientSeed,
            fairness.nonce,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Fishing cast insert returned no row');
        return { row, previous };
      });

      settled(config, flexName(request.authUser), result.previous, app.log);
      publishLiveSoon('balance', [userId]);
      const [balance, next] = await Promise.all([balanceOf(db, userId), currentCommitment(db, userId)]);
      return reply.code(201).send({
        cast: castView(result.row),
        serverNow: result.row.db_now.toISOString(),
        balanceMinor: balance,
        nextServerSeedHash: next,
      });
    },
  );

  app.post(
    '/v1/fishing/casts/:id/land',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const params = parseWith(idSchema, request.params);
      parseWith(z.object({}).strict(), request.body ?? {});

      const result = await serializable(db, async (client) => {
        const row = await lockCast(client, params.id, userId);
        // A second press lands here after the first settled it: that result, and nothing paid again.
        if (row.status !== 'open') return { row, settled: null as Settlement | null };
        if (reachedOf(row) < FISHING_MIN_LAND_X100) {
          const outcome = judge(row.snap_x100, reachedOf(row), row.auto_land_x100);
          // Snapped on the bite: there was never anything to land.
          if (outcome.outcome === 'snapped') return advance(client, config, row);
          conflict('NOTHING_TO_LAND', 'Nothing is on the line yet');
        }
        return advance(client, config, row, true);
      });

      settled(config, flexName(request.authUser), result.settled, app.log);
      return {
        cast: castView(result.row),
        serverNow: result.row.db_now.toISOString(),
        balanceMinor: await balanceOf(db, userId),
      };
    },
  );
}

async function lockCast(client: DbClient, id: string, userId: string): Promise<CastRow> {
  const locked = await client.query<CastRow>(
    'SELECT *, clock_timestamp() AS db_now FROM fishing_casts WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [id, userId],
  );
  const row = locked.rows[0];
  if (!row) throw new AppError(404, 'CAST_NOT_FOUND', 'No such cast');
  return row;
}

/** Judges an open cast as of its row's clock, and settles it if it is over. */
async function advance(
  client: DbClient,
  config: AppConfig,
  row: CastRow,
  landNow = false,
): Promise<{ row: CastRow; settled: Settlement | null }> {
  if (row.status !== 'open') return { row, settled: null };
  const outcome = judge(row.snap_x100, reachedOf(row), row.auto_land_x100, landNow);
  if (outcome.outcome === 'open') return { row, settled: null };
  const done = await settle(client, config, row, outcome.outcome === 'landed' ? outcome.landedX100 : null);
  return { row: done.row, settled: done };
}

/** Pays the landing, reveals the breaking point and the seed, and records the wager. */
async function settle(client: DbClient, config: AppConfig, row: CastRow, landedX100: number | null): Promise<Settlement> {
  const seed = await client.query<{ server_seed_ciphertext: string }>(
    'SELECT server_seed_ciphertext FROM fairness_seeds WHERE id = $1',
    [row.fairness_seed_id],
  );
  const ciphertext = seed.rows[0]?.server_seed_ciphertext;
  if (!ciphertext) throw new Error('Fishing cast lost its fairness seed');
  const serverSeed = decryptSecret(ciphertext, config.dataEncryptionKey, `fairness:${row.user_id}:${row.fairness_seed_id}`);
  if (hashServerSeed(serverSeed) !== row.server_seed_hash) {
    throw new Error('Stored fairness seed does not match its commitment');
  }

  const stake = BigInt(row.stake_minor);
  const payout = landedX100 === null ? 0n : payoutAt(stake, landedX100);
  if (payout > 0n) await creditWallet(client, row.user_id, payout, 'fishing_payout', row.id);
  const updated = await client.query<CastRow>(
    `UPDATE fishing_casts
        SET status = $2, landed_x100 = $3, catch = $4, payout_minor = $5,
            server_seed_reveal = $6, settled_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING *, clock_timestamp() AS db_now`,
    [
      row.id,
      landedX100 === null ? 'snapped' : 'landed',
      landedX100,
      landedX100 === null ? null : catchAt(landedX100),
      payout.toString(),
      serverSeed,
    ],
  );
  const saved = updated.rows[0];
  if (!saved) throw new Error('Fishing cast was settled twice');
  /* The margin is Fishing's own edge on the stake, so rakeback and referral shares follow what this
   * game actually keeps. */
  const wager = await recordWager(
    client,
    config,
    row.user_id,
    stake,
    'fishing',
    row.id,
    ['wagered_minor'],
    (stake * BigInt(FISHING_HOUSE_EDGE_BPS)) / 10_000n,
  );
  return { row: saved, wager };
}

/** Takes the stake off the wallet, refusing an overdraft, and writes the ledger line for it. */
async function debit(client: DbClient, userId: string, amount: bigint, castId: string): Promise<void> {
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
     VALUES ($1, $2, $3, $4, 'fishing_stake', $5)`,
    [randomUUID(), userId, (-amount).toString(), balanceAfter, castId],
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

/** The commitment the player's next cast must be sent against. */
async function currentCommitment(db: Database, userId: string): Promise<string | null> {
  const result = await db.query<{ server_seed_hash: string }>(
    'SELECT server_seed_hash FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return result.rows[0]?.server_seed_hash ?? null;
}

/* After the commit, never inside it, and never awaited: a slow webhook is not a slow payout. */
function settled(
  config: AppConfig,
  username: string | undefined,
  settlement: Settlement | null,
  logger: { error: (context: unknown, message: string) => void },
): void {
  if (!settlement) return;
  publishLiveSoon('balance', [settlement.row.user_id]);
  if (!username) return;
  const { row, wager } = settlement;
  const stake = BigInt(row.stake_minor);
  const payout = BigInt(row.payout_minor);
  if (payout > stake && row.landed_x100 !== null) {
    void announceWin(
      config,
      { username, amountMinor: payout, mode: 'Fishing', multiplier: row.landed_x100 / 100, path: '/fishing' },
      logger,
    );
  }
  // The jackpot draws on every wager, a snapped line included.
  const jackpotWin = wager.jackpot.win;
  if (jackpotWin) {
    void announceWin(
      config,
      { username, amountMinor: jackpotWin.amountMinor, mode: 'Vault Jackpot', path: '/fishing' },
      logger,
    );
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
