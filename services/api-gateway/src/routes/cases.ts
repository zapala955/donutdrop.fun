import { randomUUID } from 'node:crypto';
import { createFairRoll, generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { creditWallet, recordWager } from '../lib/cash-settlement.js';
import { payCreatorRoyalty } from '../lib/creator-royalties.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';
import { safeText } from '../lib/sanitize.js';

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const positiveValuePattern = /^[1-9]\d{0,18}$/;
/* Zod runs every refinement even after the pattern check has failed, so this callback still sees
 * input like "1.5" or "abc" — and BigInt() throws on those, escaping validation as a 500 rather
 * than the 400 it should be. Re-testing the pattern keeps the conversion on values already known
 * to be convertible. */
const positiveValueSchema = z
  .string()
  .regex(positiveValuePattern)
  .refine(
    (value) => !positiveValuePattern.test(value) || BigInt(value) <= POSTGRES_BIGINT_MAX,
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
const caseParamsSchema = z.object({ id: z.uuid() }).strict();
const caseOpenSchema = z
  .object({
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedPriceMinor: positiveValueSchema,
  })
  .strict();
const caseListQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
const historyQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const caseDropSchema = z
  .object({
    catalogItemId: z.uuid(),
    weight: z.number().int().min(1).max(1_000_000_000),
    quantity: z.number().int().min(1).max(2304).default(1),
  })
  .strict();
const caseCreateSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    name: safeText(1, 128),
    description: z.string().trim().max(512).default(''),
    imageUrl: z.url().startsWith('https://').max(2048).nullable().default(null),
    priceMinor: positiveValueSchema,
    enabled: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).default({}),
    drops: z.array(caseDropSchema).min(1).max(100),
    reason: safeText(3, 256),
  })
  .strict();
const caseUpdateSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
    name: safeText(1, 128).optional(),
    description: z.string().trim().max(512).optional(),
    imageUrl: z.url().startsWith('https://').max(2048).nullable().optional(),
    priceMinor: positiveValueSchema.optional(),
    enabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    drops: z.array(caseDropSchema).min(1).max(100).optional(),
    reason: safeText(3, 256),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'));

interface CaseRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  image_url: string | null;
  price_minor: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

interface DropRow {
  case_id: string;
  catalog_item_id: string;
  weight: number;
  quantity: number;
  minecraft_name: string;
  display_name: string;
  image_url: string | null;
  unit_value_minor: string;
  metadata: Record<string, unknown>;
}

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

interface StockRow {
  id: string;
  catalog_item_id: string;
  bot_id: string;
  quantity: number;
}

interface ExistingRoundRow {
  id: string;
  request_hash: string;
}

interface OpenedRoundRow {
  id: string;
  case_id: string;
  case_name: string;
  price_minor: string;
  balance_after_minor: string;
  payout_minor: string | null;
  payout_balance_after_minor: string | null;
  awarded_quantity: number;
  awarded_weight: number;
  pool_snapshot: unknown;
  total_weight: string;
  roll_weight: string;
  server_seed_hash: string;
  server_seed_reveal: string;
  client_seed: string;
  nonce: number;
  rng_digest: string;
  created_at: Date;
  catalog_item_id: string;
  minecraft_name: string;
  display_name: string;
  image_url: string | null;
  unit_value_minor: string;
  metadata: Record<string, unknown>;
}

export async function registerCaseRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];
  const requireAdminRead = async (request: FastifyRequest) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };

  app.get('/v1/cases', async (request) => {
    const query = parseWith(caseListQuery, request.query);
    const caseResult = await db.query<CaseRow>(
      `SELECT id, slug, name, description, image_url, price_minor, enabled, metadata
         FROM cases WHERE enabled ORDER BY price_minor, id LIMIT $1`,
      [query.limit],
    );
    return { cases: await attachDrops(db, caseResult.rows) };
  });

  app.get('/v1/cases/history', { preHandler: guards.authenticate }, async (request) => {
    const query = parseWith(historyQuery, request.query);
    const result = await db.query(
      `SELECT r.id, r.case_id, cs.name AS case_name, r.price_minor,
              r.balance_after_minor, r.awarded_quantity, r.awarded_weight, r.pool_snapshot,
              r.total_weight, r.roll_weight,
              r.server_seed_hash, r.server_seed_reveal, r.client_seed, r.nonce,
              r.rng_digest, r.created_at, c.id AS catalog_item_id,
              c.minecraft_name, c.display_name, c.image_url, c.unit_value_minor, c.metadata
         FROM case_rounds r
         JOIN cases cs ON cs.id = r.case_id
         JOIN catalog_items c ON c.id = r.awarded_catalog_item_id
        WHERE r.user_id = $1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
        ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
      [request.authUser?.id, query.before ?? null, query.limit],
    );
    return { rounds: result.rows };
  });

  app.post(
    '/v1/cases/:id/open',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const params = parseWith(caseParamsSchema, request.params);
      const body = parseWith(caseOpenSchema, request.body);
      const userId = requireUserId(request.authUser?.id);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson({ caseId: params.id, ...body }));

      const opened = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8834))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const prior = await client.query<ExistingRoundRow>(
          'SELECT id, request_hash FROM case_rounds WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return { round: await loadOpenedRound(client, prior.rows[0].id), replay: true };
        }

        await assertGameEligible(client, userId);
        const caseResult = await client.query<CaseRow>(
          `SELECT id, slug, name, description, image_url, price_minor, enabled, metadata
             FROM cases WHERE id = $1 AND enabled FOR SHARE`,
          [params.id],
        );
        const selectedCase = caseResult.rows[0];
        if (!selectedCase) throw new AppError(404, 'CASE_NOT_FOUND', 'Case is unavailable');
        if (selectedCase.price_minor !== body.expectedPriceMinor) {
          conflict('PRICE_CHANGED', 'The case price changed; refresh and try again');
        }
        const price = BigInt(selectedCase.price_minor);

        const dropsResult = await client.query<DropRow>(
          `SELECT ci.case_id, ci.catalog_item_id, ci.weight, ci.quantity,
                  c.minecraft_name, c.display_name, c.image_url, c.unit_value_minor, c.metadata
             FROM case_items ci JOIN catalog_items c ON c.id = ci.catalog_item_id
            WHERE ci.case_id = $1 AND ci.enabled AND c.enabled
            ORDER BY ci.catalog_item_id FOR SHARE OF ci, c`,
          [selectedCase.id],
        );
        if (!dropsResult.rows.length) {
          throw new AppError(409, 'CASE_POOL_EMPTY', 'Case has no enabled drops');
        }

        const itemIds = dropsResult.rows.map((drop) => drop.catalog_item_id);
        const stock = await client.query<StockRow>(
          `SELECT i.id, i.catalog_item_id, i.bot_id, i.quantity
             FROM inventory_lots i JOIN bot_accounts b ON b.id = i.bot_id
            WHERE i.owner_user_id IS NULL AND i.catalog_item_id = ANY($1::uuid[])
              AND i.state = 'available' AND b.status = 'online'
              AND b.reconciliation_status = 'matched' AND b.id = ANY($2::uuid[])
              AND b.last_heartbeat_at > now() - interval '45 seconds'
              AND b.last_snapshot_at > now() - interval '45 seconds'
              AND b.transfer_capable
            ORDER BY i.catalog_item_id, i.bot_id, i.created_at, i.id
            FOR UPDATE OF i FOR SHARE OF b`,
          [itemIds, provisionedBotIds],
        );
        const stockByItem = new Map<string, StockRow[]>();
        for (const lot of stock.rows) {
          const existing = stockByItem.get(lot.catalog_item_id) ?? [];
          existing.push(lot);
          stockByItem.set(lot.catalog_item_id, existing);
        }
        /* Normally a case may not open unless EVERY published outcome is backed by real stock —
         * otherwise the printed odds include prizes the house cannot pay. With unlimited stock
         * there is nothing to run out of, so the invariant is satisfied by construction. */
        if (!config.houseStockUnlimited) {
          for (const drop of dropsResult.rows) {
            const available = (stockByItem.get(drop.catalog_item_id) ?? []).reduce(
              (sum, lot) => sum + BigInt(lot.quantity),
              0n,
            );
            if (available < BigInt(drop.quantity)) {
              conflict(
                'CASE_OUT_OF_STOCK',
                'Every published case outcome must be in stock before the case can open',
              );
            }
          }
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
            'Fetch the current server-seed commitment before opening a case',
          );
        }
        if (fairness.server_seed_hash !== body.serverSeedHash) {
          conflict(
            'FAIRNESS_COMMITMENT_CHANGED',
            'The supplied server-seed commitment is no longer active',
          );
        }
        const serverSeed = decryptSecret(
          fairness.server_seed_ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${fairness.id}`,
        );
        if (hashServerSeed(serverSeed) !== fairness.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }
        const fairRoll = createFairRoll(serverSeed, body.clientSeed, fairness.nonce);
        const totalWeight = dropsResult.rows.reduce(
          (total, drop) => total + BigInt(drop.weight),
          0n,
        );
        const rollWeight = scaleDigestToWeight(fairRoll.digest, totalWeight);
        const selectedDrop = selectWeightedDrop(dropsResult.rows, rollWeight);
        /* Cash-only play: the drop names the prize, the wallet receives it. Converted at the
         * drop's full catalog value so the published pool is worth exactly what it says. */
        let cashPayoutMinor: bigint | null = null;
        let payoutBalanceAfterMinor: string | null = null;

        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const wallet = await client.query<{ balance_minor: string }>(
          'SELECT balance_minor FROM user_wallets WHERE user_id = $1 FOR UPDATE',
          [userId],
        );
        if (BigInt(wallet.rows[0]?.balance_minor ?? '0') < price) {
          throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low to open this case');
        }
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets
              SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1
            RETURNING balance_minor`,
          [userId, price.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) throw new Error('Wallet debit returned no balance');

        const roundId = randomUUID();

        /* The crate's author is paid for this open, and the marketplace counters move, inside the
         * SAME transaction that took the money. A royalty that committed separately could be lost
         * to a rollback the player never saw, and "most opened" would drift from the round table.
         *
         * Keyed on the round id, so the replay path above — which returns an existing round
         * rather than rolling a new one — cannot pay a second time. */
        await payCreatorRoyalty(client, selectedCase.id, userId, 'case_open', roundId);

        /* No lot is reserved in cash-only play, because none is ever handed over. */
        const firstAwardId = config.cashOnlyPlay ? null : randomUUID();
        if (config.cashOnlyPlay) {
          cashPayoutMinor = BigInt(selectedDrop.unit_value_minor) * BigInt(selectedDrop.quantity);
          payoutBalanceAfterMinor = await creditWallet(
            client,
            userId,
            cashPayoutMinor,
            'case_win',
            roundId,
          );
        }
        await client.query(
          `INSERT INTO case_rounds
             (id, user_id, case_id, awarded_catalog_item_id, awarded_inventory_lot_id,
              awarded_quantity, awarded_weight, pool_snapshot, price_minor, balance_after_minor, total_weight, roll_weight,
              idempotency_key, request_hash, server_seed_hash, server_seed_reveal,
              client_seed, nonce, rng_digest, payout_minor, payout_balance_after_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            roundId,
            userId,
            selectedCase.id,
            selectedDrop.catalog_item_id,
            firstAwardId,
            selectedDrop.quantity,
            selectedDrop.weight,
            JSON.stringify(
              dropsResult.rows.map((drop) => ({
                catalogItemId: drop.catalog_item_id,
                weight: drop.weight,
                quantity: drop.quantity,
                unitValueMinor: drop.unit_value_minor,
              })),
            ),
            selectedCase.price_minor,
            balanceAfter,
            totalWeight.toString(),
            rollWeight.toString(),
            idempotencyKey,
            requestHash,
            fairness.server_seed_hash,
            serverSeed,
            body.clientSeed,
            fairness.nonce,
            fairRoll.digest,
            cashPayoutMinor?.toString() ?? null,
            payoutBalanceAfterMinor,
          ],
        );

        let remaining = selectedDrop.quantity;
        let first = true;
        /* Unlimited stock mints the award, so there may be no house lot for the won item at all.
         * A live bot still has to exist for the award lot to hang off. */
        let sources = config.cashOnlyPlay
          ? []
          : (stockByItem.get(selectedDrop.catalog_item_id) ?? []);
        if (config.houseStockUnlimited && !config.cashOnlyPlay && !sources.length) {
          const liveBot = await client.query<{ id: string }>(
            `SELECT b.id FROM bot_accounts b
              WHERE b.status = 'online' AND b.reconciliation_status = 'matched'
                AND b.id = ANY($1::uuid[])
                AND b.last_heartbeat_at > now() - interval '45 seconds'
                AND b.last_snapshot_at > now() - interval '45 seconds'
                AND b.transfer_capable
              ORDER BY b.id LIMIT 1`,
            [provisionedBotIds],
          );
          const fallbackBot = liveBot.rows[0];
          if (!fallbackBot) conflict('CASE_OUT_OF_STOCK', 'No custody bot is available');
          else {
            sources = [
              {
                id: '',
                catalog_item_id: selectedDrop.catalog_item_id,
                bot_id: fallbackBot.id,
                quantity: selectedDrop.quantity,
              },
            ];
          }
        }
        for (const source of sources) {
          if (remaining === 0) break;
          const quantity = Math.min(source.quantity, remaining);
          if (!config.houseStockUnlimited) {
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
          }
          const awardId = first ? firstAwardId : randomUUID();
          first = false;
          await client.query(
            `INSERT INTO inventory_lots
               (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
             VALUES ($1, $2, $3, $4, $5, 'available', 'case_win', $6)`,
            [awardId, selectedDrop.catalog_item_id, userId, source.bot_id, quantity, roundId],
          );
          await client.query(
            `INSERT INTO custody_movements
               (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
             VALUES ($1, $2, $3, NULL, $4, $5, 'case_win', $6)`,
            [randomUUID(), selectedDrop.catalog_item_id, source.bot_id, userId, quantity, roundId],
          );
          remaining -= quantity;
        }
        if (remaining !== 0 && !config.cashOnlyPlay) {
          throw new Error('Locked case stock disappeared');
        }

        await recordWager(client, config, userId, price, 'case', roundId, [
          'cases_opened',
          'wagered_minor',
        ]);

        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'case_open', $5)`,
          [randomUUID(), userId, (-price).toString(), balanceAfter, roundId],
        );
        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [
          fairness.id,
        ]);
        await insertFairnessSeed(client, config, userId);
        return { round: await loadOpenedRound(client, roundId), replay: false };
      });

      return reply.code(opened.replay ? 200 : 201).send(formatOpenedRound(opened.round));
    },
  );

  app.get('/v1/admin/cases', { preHandler: requireAdminRead }, async () => {
    const result = await db.query<CaseRow>(
      `SELECT id, slug, name, description, image_url, price_minor, enabled, metadata
         FROM cases ORDER BY created_at, id`,
    );
    return { cases: await attachDrops(db, result.rows, false) };
  });

  app.post('/v1/admin/cases', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseWith(caseCreateSchema, request.body);
    assertUniqueDrops(body.drops);
    const actor = requireUserId(request.authUser?.id);
    const caseId = randomUUID();
    await db.transaction(async (client) => {
      await assertCatalogDropsExist(
        client,
        body.drops.map((drop) => drop.catalogItemId),
      );
      await client.query(
        `INSERT INTO cases
           (id, slug, name, description, image_url, price_minor, enabled, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          caseId,
          body.slug,
          body.name,
          body.description,
          body.imageUrl,
          body.priceMinor,
          body.enabled,
          JSON.stringify(body.metadata),
        ],
      );
      await upsertDrops(client, caseId, body.drops, false);
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'case.create',
        targetType: 'case',
        targetId: caseId,
        details: body,
      });
    });
    return reply.code(201).send({ caseId });
  });

  app.patch('/v1/admin/cases/:id', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(caseParamsSchema, request.params);
    const body = parseWith(caseUpdateSchema, request.body);
    if (body.drops) assertUniqueDrops(body.drops);
    const actor = requireUserId(request.authUser?.id);
    await db.transaction(async (client) => {
      const current = await client.query<{ id: string }>(
        'SELECT id FROM cases WHERE id = $1 FOR UPDATE',
        [params.id],
      );
      if (!current.rows[0]) throw new AppError(404, 'CASE_NOT_FOUND', 'Case was not found');
      if (body.drops) {
        await assertCatalogDropsExist(
          client,
          body.drops.map((drop) => drop.catalogItemId),
        );
        await upsertDrops(client, params.id, body.drops, true);
      }
      await client.query(
        `UPDATE cases SET
           slug = COALESCE($2, slug),
           name = COALESCE($3, name),
           description = COALESCE($4, description),
           image_url = CASE WHEN $5::boolean THEN $6 ELSE image_url END,
           price_minor = COALESCE($7::bigint, price_minor),
           enabled = COALESCE($8::boolean, enabled),
           metadata = COALESCE($9::jsonb, metadata),
           updated_at = now()
         WHERE id = $1`,
        [
          params.id,
          body.slug ?? null,
          body.name ?? null,
          body.description ?? null,
          body.imageUrl !== undefined,
          body.imageUrl ?? null,
          body.priceMinor ?? null,
          body.enabled ?? null,
          body.metadata === undefined ? null : JSON.stringify(body.metadata),
        ],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'case.update',
        targetType: 'case',
        targetId: params.id,
        details: body,
      });
    });
    return { caseId: params.id };
  });
}

async function attachDrops(db: Database, cases: CaseRow[], enabledOnly = true) {
  if (!cases.length) return [];
  const result = await db.query<DropRow>(
    `SELECT ci.case_id, ci.catalog_item_id, ci.weight, ci.quantity,
            c.minecraft_name, c.display_name, c.image_url, c.unit_value_minor, c.metadata
       FROM case_items ci JOIN catalog_items c ON c.id = ci.catalog_item_id
      WHERE ci.case_id = ANY($1::uuid[])
        AND ($2::boolean = false OR (ci.enabled AND c.enabled))
      ORDER BY ci.case_id, ci.catalog_item_id`,
    [cases.map((entry) => entry.id), enabledOnly],
  );
  const byCase = new Map<string, DropRow[]>();
  for (const drop of result.rows) {
    const existing = byCase.get(drop.case_id) ?? [];
    existing.push(drop);
    byCase.set(drop.case_id, existing);
  }
  return cases.map((entry) => {
    const drops = byCase.get(entry.id) ?? [];
    const totalWeight = drops.reduce((total, drop) => total + BigInt(drop.weight), 0n);
    return {
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      imageUrl: entry.image_url,
      priceMinor: entry.price_minor,
      enabled: entry.enabled,
      metadata: entry.metadata,
      totalWeight: totalWeight.toString(),
      drops: drops.map((drop) => ({
        catalogItemId: drop.catalog_item_id,
        minecraftName: drop.minecraft_name,
        displayName: drop.display_name,
        imageUrl: drop.image_url,
        unitValueMinor: drop.unit_value_minor,
        metadata: drop.metadata,
        weight: drop.weight,
        quantity: drop.quantity,
        chancePpm: totalWeight > 0n ? Number((BigInt(drop.weight) * 1_000_000n) / totalWeight) : 0,
      })),
    };
  });
}

/** Maps the full 256-bit HMAC digest into [0, totalWeight) without floating-point math. */
export function scaleDigestToWeight(digest: string, totalWeight: bigint): bigint {
  if (!/^[a-f0-9]{64}$/.test(digest) || totalWeight <= 0n || totalWeight > POSTGRES_BIGINT_MAX) {
    throw new RangeError('Digest and total weight are invalid');
  }
  return (BigInt(`0x${digest}`) * totalWeight) >> 256n;
}

function selectWeightedDrop(drops: DropRow[], rollWeight: bigint): DropRow {
  let cursor = 0n;
  for (const drop of drops) {
    cursor += BigInt(drop.weight);
    if (rollWeight < cursor) return drop;
  }
  throw new Error('Weighted case roll fell outside the configured pool');
}

async function insertFairnessSeed(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<void> {
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

async function loadOpenedRound(client: DbClient, roundId: string): Promise<OpenedRoundRow> {
  const result = await client.query<OpenedRoundRow>(
    `SELECT r.id, r.case_id, cs.name AS case_name, r.price_minor, r.balance_after_minor,
            r.payout_minor, r.payout_balance_after_minor,
            r.awarded_quantity, r.awarded_weight, r.pool_snapshot, r.total_weight, r.roll_weight, r.server_seed_hash,
            r.server_seed_reveal, r.client_seed, r.nonce, r.rng_digest, r.created_at,
            c.id AS catalog_item_id, c.minecraft_name, c.display_name, c.image_url,
            c.unit_value_minor, c.metadata
       FROM case_rounds r
       JOIN cases cs ON cs.id = r.case_id
       JOIN catalog_items c ON c.id = r.awarded_catalog_item_id
      WHERE r.id = $1`,
    [roundId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Case round insert returned no row');
  return row;
}

function formatOpenedRound(row: OpenedRoundRow) {
  return {
    round: {
      id: row.id,
      caseId: row.case_id,
      caseName: row.case_name,
      priceMinor: row.price_minor,
      balanceAfterMinor: row.balance_after_minor,
      /* What the win actually paid, and the balance once it landed. In cash-only play this is the
       * whole result of the round — without it the client has an item name and no idea what it was
       * worth, which is how a toast ends up reading "+$undefined". */
      payoutMinor: row.payout_minor,
      payoutBalanceAfterMinor: row.payout_balance_after_minor,
      quantity: row.awarded_quantity,
      awardedWeight: row.awarded_weight,
      poolSnapshot: row.pool_snapshot,
      totalWeight: row.total_weight,
      rollWeight: row.roll_weight,
      serverSeedHash: row.server_seed_hash,
      serverSeedReveal: row.server_seed_reveal,
      clientSeed: row.client_seed,
      nonce: row.nonce,
      rngDigest: row.rng_digest,
      createdAt: row.created_at,
    },
    item: {
      id: row.catalog_item_id,
      minecraftName: row.minecraft_name,
      displayName: row.display_name,
      imageUrl: row.image_url,
      unitValueMinor: row.unit_value_minor,
      metadata: row.metadata,
      quantity: row.awarded_quantity,
    },
    balanceMinor: row.balance_after_minor,
  };
}

function assertUniqueDrops(drops: Array<{ catalogItemId: string }>): void {
  const ids = drops.map((drop) => drop.catalogItemId);
  if (new Set(ids).size !== ids.length) {
    throw new AppError(400, 'DUPLICATE_CASE_DROP', 'Each catalog item may appear once per case');
  }
}

async function assertCatalogDropsExist(client: DbClient, ids: string[]): Promise<void> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM catalog_items WHERE id = ANY($1::uuid[]) AND enabled FOR SHARE',
    [ids],
  );
  if (result.rows.length !== ids.length) {
    throw new AppError(
      400,
      'CASE_DROP_INVALID',
      'Every case drop must reference an enabled catalog item',
    );
  }
}

async function upsertDrops(
  client: DbClient,
  caseId: string,
  drops: Array<{ catalogItemId: string; weight: number; quantity: number }>,
  disableExisting: boolean,
): Promise<void> {
  if (disableExisting) {
    await client.query(
      'UPDATE case_items SET enabled = false, updated_at = now() WHERE case_id = $1',
      [caseId],
    );
  }
  for (const drop of drops) {
    await client.query(
      `INSERT INTO case_items(case_id, catalog_item_id, weight, quantity, enabled)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (case_id, catalog_item_id) DO UPDATE
         SET weight = EXCLUDED.weight, quantity = EXCLUDED.quantity,
             enabled = true, updated_at = now()`,
      [caseId, drop.catalogItemId, drop.weight, drop.quantity],
    );
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
