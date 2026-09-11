import { randomUUID } from 'node:crypto';
import {
  calculateWinChancePpm,
  createFairRoll,
  generateServerSeed,
  hashServerSeed,
} from '@donut/provably-fair';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

const fixedItemValuePattern = /^[1-9]\d{0,18}$/;
const fixedItemValueSchema = z
  .string()
  .regex(fixedItemValuePattern)
  .refine(
    (value) => fixedItemValuePattern.test(value) && BigInt(value) <= POSTGRES_BIGINT_MAX,
    'Value exceeds database range',
  );
const clientSeedSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 128, 'Must not exceed 128 UTF-8 bytes')
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Must not contain control characters',
  );
const inventorySelectionSchema = z
  .object({
    inventoryLotId: z.uuid(),
    quantity: z.number().int().min(1).max(2304),
    expectedUnitValueMinor: fixedItemValueSchema,
  })
  .strict();
const upgradeSchema = z
  .object({
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetCatalogItemId: z.uuid(),
    targetQuantity: z.number().int().min(1).max(2304).default(1),
    expectedTargetUnitValueMinor: fixedItemValueSchema,
    stakes: z.array(inventorySelectionSchema).min(1).max(20),
  })
  .strict();
const historyQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const verifySchema = z
  .object({
    serverSeed: z.string().regex(/^[a-f0-9]{64}$/),
    clientSeed: clientSeedSchema,
    nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

interface StakeRow {
  id: string;
  catalog_item_id: string;
  bot_id: string;
  quantity: number;
  unit_value_minor: string;
}

/**
 * upgrader_rounds rows are handed to the client whole, so only the column this route reads is
 * named. The rest stay `unknown` rather than `any`, which keeps an unchecked value from
 * silently flowing into application logic.
 */
interface UpgraderRoundRow {
  request_hash: string;
  [column: string]: unknown;
}

interface TargetStockRow {
  id: string;
  bot_id: string;
  quantity: number;
}

export async function registerUpgradeRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];

  app.get('/v1/upgrades/config', { preHandler: guards.authenticate }, async () => ({
    algorithm: 'HMAC-SHA256-v1',
    houseEdgeBps: config.houseEdgeBps,
    minMultiplierBps: config.minMultiplierBps,
    maxMultiplierBps: config.maxMultiplierBps,
    maxWinChancePpm: config.maxWinChancePpm,
    currency: null,
    itemValuesAreFixed: true,
  }));

  app.get('/v1/fairness/current', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const seed = await ensureFairnessSeed(db, config, userId);
    return {
      serverSeedHash: seed.server_seed_hash,
      nonce: seed.nonce,
      algorithm: 'HMAC-SHA256-v1',
    };
  });

  app.post('/v1/fairness/verify', async (request) => {
    const body = parseWith(verifySchema, request.body);
    const roll = createFairRoll(body.serverSeed, body.clientSeed, body.nonce);
    return { serverSeedHash: hashServerSeed(body.serverSeed), ...roll };
  });

  app.post(
    '/v1/upgrades',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = parseWith(upgradeSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const userId = requireUserId(request.authUser?.id);
      const stakeIds = body.stakes.map((stake) => stake.inventoryLotId);
      if (new Set(stakeIds).size !== stakeIds.length) {
        throw new AppError(400, 'DUPLICATE_STAKE', 'Each inventory lot may only appear once');
      }
      const requestHash = sha256Hex(canonicalJson(body));

      const round = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8831))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const existing = await client.query<UpgraderRoundRow>(
          'SELECT * FROM upgrader_rounds WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return existing.rows[0];
        }

        const dailyWagerRemaining = await assertEligible(client, config, userId);

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
            'Fetch the current server-seed commitment before upgrading',
          );
        }
        if (fairness.server_seed_hash !== body.serverSeedHash) {
          conflict(
            'FAIRNESS_COMMITMENT_CHANGED',
            'The supplied server-seed commitment is no longer active',
          );
        }

        const stakesResult = await client.query<StakeRow>(
          `SELECT i.id, i.catalog_item_id, i.bot_id, i.quantity, c.unit_value_minor
             FROM inventory_lots i
             JOIN catalog_items c ON c.id = i.catalog_item_id
             JOIN bot_accounts b ON b.id = i.bot_id
            WHERE i.owner_user_id = $1 AND i.id = ANY($2::uuid[]) AND i.state = 'available'
              AND c.enabled AND b.status = 'online' AND b.reconciliation_status = 'matched'
              AND b.id = ANY($3::uuid[])
              AND b.last_heartbeat_at > now() - interval '45 seconds'
              AND b.last_snapshot_at > now() - interval '45 seconds'
              AND b.transfer_capable
            ORDER BY i.id FOR UPDATE OF i, c FOR SHARE OF b`,
          [userId, stakeIds, provisionedBotIds],
        );
        if (stakesResult.rows.length !== stakeIds.length) {
          conflict('STAKE_UNAVAILABLE', 'One or more stake items are unavailable or unreconciled');
        }
        const stakeById = new Map(stakesResult.rows.map((row) => [row.id, row]));
        let stakeValue = 0n;
        for (const selected of body.stakes) {
          const row = stakeById.get(selected.inventoryLotId);
          if (!row || selected.quantity > row.quantity)
            conflict('STAKE_QUANTITY_INVALID', 'Stake quantity exceeds inventory');
          assertExpectedPrice(row.unit_value_minor, selected.expectedUnitValueMinor, 'stake');
          stakeValue = checkedItemValue(
            stakeValue,
            BigInt(row.unit_value_minor),
            selected.quantity,
          );
        }
        if (stakeValue > dailyWagerRemaining) {
          throw new AppError(
            403,
            'DAILY_LIMIT_EXCEEDED',
            'This upgrade would exceed the daily wager limit',
          );
        }

        const catalog = await client.query<{ id: string; unit_value_minor: string }>(
          'SELECT id, unit_value_minor FROM catalog_items WHERE id = $1 AND enabled FOR SHARE',
          [body.targetCatalogItemId],
        );
        const target = catalog.rows[0];
        if (!target) throw new AppError(404, 'TARGET_NOT_FOUND', 'Target item is unavailable');
        assertExpectedPrice(target.unit_value_minor, body.expectedTargetUnitValueMinor, 'target');
        const targetValue = checkedItemValue(
          0n,
          BigInt(target.unit_value_minor),
          body.targetQuantity,
        );
        if (targetValue * 10_000n < stakeValue * BigInt(config.minMultiplierBps)) {
          throw new AppError(400, 'MULTIPLIER_TOO_LOW', 'Target value is too close to stake value');
        }
        if (targetValue * 10_000n > stakeValue * BigInt(config.maxMultiplierBps)) {
          throw new AppError(
            400,
            'MULTIPLIER_TOO_HIGH',
            'Target value exceeds the maximum multiplier',
          );
        }

        const stock = await client.query<TargetStockRow>(
          `SELECT i.id, i.bot_id, i.quantity
             FROM inventory_lots i JOIN bot_accounts b ON b.id = i.bot_id
             WHERE i.owner_user_id IS NULL AND i.catalog_item_id = $1 AND i.state = 'available'
               AND b.status = 'online' AND b.reconciliation_status = 'matched'
               AND b.id = ANY($2::uuid[])
               AND b.last_heartbeat_at > now() - interval '45 seconds'
               AND b.last_snapshot_at > now() - interval '45 seconds'
               AND b.transfer_capable
             ORDER BY i.bot_id, i.created_at, i.id FOR UPDATE OF i FOR SHARE OF b`,
          [body.targetCatalogItemId, provisionedBotIds],
        );
        if (
          stock.rows.reduce((sum, row) => sum + BigInt(row.quantity), 0n) <
          BigInt(body.targetQuantity)
        ) {
          conflict('TARGET_OUT_OF_STOCK', 'Target item is out of stock');
        }

        const chancePpm = calculateWinChancePpm(
          stakeValue,
          targetValue,
          config.houseEdgeBps,
          config.maxWinChancePpm,
        );
        if (chancePpm < 1)
          throw new AppError(400, 'CHANCE_TOO_LOW', 'Calculated win chance is below the minimum');
        const serverSeed = decryptSecret(
          fairness.server_seed_ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${fairness.id}`,
        );
        if (hashServerSeed(serverSeed) !== fairness.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }
        const fairRoll = createFairRoll(serverSeed, body.clientSeed, fairness.nonce);
        const outcome = fairRoll.rollPpm < chancePpm ? 'win' : 'lose';
        const roundId = randomUUID();
        const firstAwardId = outcome === 'win' ? randomUUID() : null;
        await client.query(
          `INSERT INTO upgrader_rounds
             (id, user_id, idempotency_key, request_hash, target_catalog_item_id, target_inventory_lot_id, target_quantity,
              stake_value_minor, target_value_minor, house_edge_bps, chance_ppm, roll_ppm, outcome,
              server_seed_hash, server_seed_reveal, client_seed, nonce, rng_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            roundId,
            userId,
            idempotencyKey,
            requestHash,
            body.targetCatalogItemId,
            firstAwardId,
            body.targetQuantity,
            stakeValue.toString(),
            targetValue.toString(),
            config.houseEdgeBps,
            chancePpm,
            fairRoll.rollPpm,
            outcome,
            fairness.server_seed_hash,
            serverSeed,
            body.clientSeed,
            fairness.nonce,
            fairRoll.digest,
          ],
        );

        for (const selected of body.stakes) {
          const source = stakeById.get(selected.inventoryLotId);
          if (!source) throw new Error('Locked stake disappeared');
          await client.query(
            `INSERT INTO upgrader_stakes
               (round_id, source_inventory_lot_id, catalog_item_id, quantity, unit_value_minor)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              roundId,
              source.id,
              source.catalog_item_id,
              selected.quantity,
              source.unit_value_minor,
            ],
          );
          if (selected.quantity === source.quantity) {
            await client.query(
              "UPDATE inventory_lots SET state = 'consumed', updated_at = now() WHERE id = $1",
              [source.id],
            );
          } else {
            await client.query(
              'UPDATE inventory_lots SET quantity = quantity - $2, updated_at = now() WHERE id = $1',
              [source.id, selected.quantity],
            );
          }
          await client.query(
            `INSERT INTO inventory_lots
               (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
             VALUES ($1, $2, NULL, $3, $4, 'available', 'upgrade_stake', $5)`,
            [randomUUID(), source.catalog_item_id, source.bot_id, selected.quantity, roundId],
          );
          await client.query(
            `INSERT INTO custody_movements
               (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
             VALUES ($1, $2, $3, $4, NULL, $5, 'upgrade_stake', $6)`,
            [
              randomUUID(),
              source.catalog_item_id,
              source.bot_id,
              userId,
              selected.quantity,
              roundId,
            ],
          );
        }

        if (outcome === 'win') {
          let remaining = body.targetQuantity;
          let first = true;
          for (const source of stock.rows) {
            if (remaining === 0) break;
            const quantity = Math.min(source.quantity, remaining);
            if (quantity === source.quantity) {
              await client.query(
                "UPDATE inventory_lots SET state = 'consumed', updated_at = now() WHERE id = $1",
                [source.id],
              );
            } else {
              await client.query(
                'UPDATE inventory_lots SET quantity = quantity - $2, updated_at = now() WHERE id = $1',
                [source.id, quantity],
              );
            }
            const awardId = first && firstAwardId ? firstAwardId : randomUUID();
            first = false;
            await client.query(
              `INSERT INTO inventory_lots
                 (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
               VALUES ($1, $2, $3, $4, $5, 'available', 'upgrade_win', $6)`,
              [awardId, body.targetCatalogItemId, userId, source.bot_id, quantity, roundId],
            );
            await client.query(
              `INSERT INTO upgrader_awards
                 (round_id, source_inventory_lot_id, awarded_inventory_lot_id, catalog_item_id, quantity, unit_value_minor)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                roundId,
                source.id,
                awardId,
                body.targetCatalogItemId,
                quantity,
                target.unit_value_minor,
              ],
            );
            await client.query(
              `INSERT INTO custody_movements
                 (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
               VALUES ($1, $2, $3, NULL, $4, $5, 'upgrade_win', $6)`,
              [randomUUID(), body.targetCatalogItemId, source.bot_id, userId, quantity, roundId],
            );
            remaining -= quantity;
          }
        }

        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [
          fairness.id,
        ]);
        await insertFairnessSeed(client, config, userId);
        const saved = await client.query<UpgraderRoundRow>(
          'SELECT * FROM upgrader_rounds WHERE id = $1',
          [roundId],
        );
        return saved.rows[0];
      });
      return reply.code(201).send({ round });
    },
  );

  app.get('/v1/upgrades/history', { preHandler: guards.authenticate }, async (request) => {
    const query = parseWith(historyQuery, request.query);
    const result = await db.query(
      `SELECT r.*, c.minecraft_name, c.display_name, c.image_url
         FROM upgrader_rounds r JOIN catalog_items c ON c.id = r.target_catalog_item_id
        WHERE r.user_id = $1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
        ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
      [request.authUser?.id, query.before ?? null, query.limit],
    );
    return { rounds: result.rows };
  });

  app.get('/v1/upgrades/recent-wins', async () => {
    const result = await db.query(
      `SELECT r.id, r.target_quantity, r.target_value_minor, r.chance_ppm, r.created_at,
              c.display_name, c.image_url,
              'Player-' || upper(substr(md5(r.id::text || ':' || u.id::text), 1, 8)) AS player
         FROM upgrader_rounds r
         JOIN catalog_items c ON c.id = r.target_catalog_item_id
         JOIN users u ON u.id = r.user_id
        WHERE r.outcome = 'win' ORDER BY r.created_at DESC LIMIT 30`,
    );
    return { wins: result.rows };
  });
}

async function assertEligible(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<bigint> {
  const result = await client.query<{
    status: string;
    country_code: string | null;
    terms_accepted_at: Date | null;
    age_verified_at: Date | null;
    kyc_status: string;
    daily_wager_limit_minor: string | null;
    cooldown_until: Date | null;
    self_excluded_until: Date | null;
  }>(
    `SELECT u.status, u.country_code, u.terms_accepted_at, u.age_verified_at, u.kyc_status,
            r.daily_wager_limit_minor, r.cooldown_until, r.self_excluded_until
       FROM users u JOIN responsible_limits r ON r.user_id = u.id
      WHERE u.id = $1 FOR UPDATE OF u, r`,
    [userId],
  );
  const user = result.rows[0];
  if (!user || user.status !== 'active')
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
  if (!user.terms_accepted_at || !user.age_verified_at || !user.country_code) {
    throw new AppError(
      403,
      'COMPLIANCE_INCOMPLETE',
      'Age, location, and terms verification are required',
    );
  }
  if (user.kyc_status !== 'verified') {
    throw new AppError(403, 'KYC_REQUIRED', 'Identity verification is required');
  }
  if (
    config.allowedCountries.size &&
    !config.allowedCountries.has(user.country_code.toLowerCase())
  ) {
    throw new AppError(403, 'COUNTRY_NOT_ALLOWED', 'Service is not available in this country');
  }
  if (user.cooldown_until && user.cooldown_until > new Date()) {
    throw new AppError(403, 'COOLDOWN_ACTIVE', 'Account cooldown is active');
  }
  if (user.self_excluded_until && user.self_excluded_until > new Date()) {
    throw new AppError(403, 'SELF_EXCLUDED', 'Account is self-excluded');
  }
  const wagered = await client.query<{ total: string }>(
    `SELECT COALESCE(sum(stake_value_minor), 0)::numeric AS total FROM upgrader_rounds
      WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  const limit = user.daily_wager_limit_minor
    ? BigInt(user.daily_wager_limit_minor) < config.maxDailyWagerMinor
      ? BigInt(user.daily_wager_limit_minor)
      : config.maxDailyWagerMinor
    : config.maxDailyWagerMinor;
  // The requested stake is checked by the caller after item locks; this check blocks users already at the limit.
  if (BigInt(wagered.rows[0]?.total ?? '0') >= limit) {
    throw new AppError(403, 'DAILY_LIMIT_REACHED', 'Daily wager limit reached');
  }
  return limit - BigInt(wagered.rows[0]?.total ?? '0');
}

export function checkedItemValue(total: bigint, unitValue: bigint, quantity: number): bigint {
  if (
    total < 0n ||
    total > POSTGRES_BIGINT_MAX ||
    unitValue <= 0n ||
    unitValue > POSTGRES_BIGINT_MAX ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  ) {
    throw new AppError(
      400,
      'VALUE_OUT_OF_RANGE',
      'The selected item value exceeds the supported database range',
    );
  }
  const value = unitValue * BigInt(quantity);
  if (value > POSTGRES_BIGINT_MAX - total) {
    throw new AppError(
      400,
      'VALUE_OUT_OF_RANGE',
      'The selected item value exceeds the supported database range',
    );
  }
  return total + value;
}

export function assertExpectedPrice(actual: string, expected: string, subject: string): void {
  if (actual !== expected) {
    conflict('PRICE_CHANGED', `The ${subject} item price changed; refresh the quote and try again`);
  }
}

async function ensureFairnessSeed(
  db: Database,
  config: AppConfig,
  userId: string,
): Promise<FairnessRow> {
  return db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 741))', [userId]);
    const current = await client.query<FairnessRow>(
      `SELECT id, server_seed_ciphertext, server_seed_hash, nonce
         FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
      [userId],
    );
    return current.rows[0] ?? insertFairnessSeed(client, config, userId);
  });
}

async function insertFairnessSeed(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<FairnessRow> {
  const id = randomUUID();
  const seed = generateServerSeed();
  const hash = hashServerSeed(seed);
  const ciphertext = encryptSecret(seed, config.dataEncryptionKey, `fairness:${userId}:${id}`);
  const inserted = await client.query<FairnessRow>(
    `INSERT INTO fairness_seeds(id, user_id, server_seed_ciphertext, server_seed_hash, nonce)
     VALUES ($1, $2, $3, $4, 0)
     RETURNING id, server_seed_ciphertext, server_seed_hash, nonce`,
    [id, userId, ciphertext, hash],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('Fairness seed insert returned no row');
  return row;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
