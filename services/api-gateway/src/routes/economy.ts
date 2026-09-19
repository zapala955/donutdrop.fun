import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';
import { checkedItemValue, POSTGRES_BIGINT_MAX } from './upgrades.js';

const fixedItemValuePattern = /^[1-9]\d{0,18}$/;
/* Zod runs every refinement even after the pattern check has failed, so this callback still sees
 * input like "1.5" or "abc" — and BigInt() throws on those, escaping validation as a 500 rather
 * than the 400 it should be. Re-testing the pattern keeps the conversion on values already known
 * to be convertible. */
const fixedItemValueSchema = z
  .string()
  .regex(fixedItemValuePattern)
  .refine(
    (value) => !fixedItemValuePattern.test(value) || BigInt(value) <= POSTGRES_BIGINT_MAX,
    'Value exceeds database range',
  );
const lotParamsSchema = z.object({ id: z.uuid() }).strict();
const sellSchema = z
  .object({
    quantity: z.number().int().min(1).max(2304).default(1),
    expectedUnitValueMinor: fixedItemValueSchema,
    expectedSellRateBps: z.number().int().min(1).max(10_000),
  })
  .strict();
const historyQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();

interface SaleRow {
  id: string;
  request_hash: string;
  source_inventory_lot_id: string;
  catalog_item_id: string;
  quantity: number;
  unit_value_minor: string;
  sell_rate_bps: number;
  proceeds_minor: string;
  balance_after_minor: string;
  created_at: Date;
  display_name?: string;
  image_url?: string | null;
}

export async function registerEconomyRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/balance', { preHandler: guards.authenticate }, async (request) => {
    const result = await db.query<{ balance_minor: string }>(
      `SELECT COALESCE(w.balance_minor, 0)::bigint AS balance_minor
         FROM users u LEFT JOIN user_wallets w ON w.user_id = u.id
        WHERE u.id = $1`,
      [request.authUser?.id],
    );
    return { balanceMinor: result.rows[0]?.balance_minor ?? '0' };
  });

  app.get(
    '/v1/balance/transactions',
    { preHandler: guards.authenticate },
    async (request) => {
      const query = parseWith(historyQuery, request.query);
      const result = await db.query(
        /* By `seq`, not by `created_at`. Two rows from one transaction share a timestamp — now()
         * is transaction-start time — so the old ordering tie-broke on a random uuid and a round's
         * credit and debit came back in either order. `seq` is monotonic and cannot tie. */
        `SELECT id, amount_minor, balance_after_minor, kind, reference_id, created_at
           FROM wallet_transactions WHERE user_id = $1
          ORDER BY seq DESC LIMIT $2`,
        [request.authUser?.id, query.limit],
      );
      return { transactions: result.rows };
    },
  );

  app.post(
    '/v1/inventory/:id/sell',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const params = parseWith(lotParamsSchema, request.params);
      const body = parseWith(sellSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(
        canonicalJson({ inventoryLotId: params.id, ...body }),
      );

      const result = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8835))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const previous = await client.query<SaleRow>(
          `SELECT s.*, c.display_name, c.image_url
             FROM inventory_sales s JOIN catalog_items c ON c.id = s.catalog_item_id
            WHERE s.user_id = $1 AND s.idempotency_key = $2`,
          [userId, idempotencyKey],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return { sale: previous.rows[0], replay: true };
        }

        const lots = await client.query<{
          id: string;
          catalog_item_id: string;
          bot_id: string;
          quantity: number;
          unit_value_minor: string;
          display_name: string;
          image_url: string | null;
        }>(
          `SELECT i.id, i.catalog_item_id, i.bot_id, i.quantity, c.unit_value_minor,
                  c.display_name, c.image_url
             FROM inventory_lots i JOIN catalog_items c ON c.id = i.catalog_item_id
            WHERE i.id = $1 AND i.owner_user_id = $2 AND i.state = 'available' AND c.enabled
            FOR UPDATE OF i FOR SHARE OF c`,
          [params.id, userId],
        );
        const lot = lots.rows[0];
        if (!lot) conflict('ITEM_UNAVAILABLE', 'The inventory item is unavailable');
        if (body.quantity > lot.quantity) {
          conflict('QUANTITY_INVALID', 'Requested quantity exceeds inventory');
        }
        if (lot.unit_value_minor !== body.expectedUnitValueMinor) {
          conflict('PRICE_CHANGED', 'The item price changed; refresh and try again');
        }
        if (body.expectedSellRateBps !== config.itemSellRateBps) {
          conflict('SELL_RATE_CHANGED', 'The item sell rate changed; refresh and try again');
        }
        const bookValue = checkedItemValue(0n, BigInt(lot.unit_value_minor), body.quantity);
        const proceeds = (bookValue * BigInt(config.itemSellRateBps)) / 10_000n;
        if (proceeds <= 0n || proceeds > POSTGRES_BIGINT_MAX) {
          throw new AppError(400, 'VALUE_OUT_OF_RANGE', 'The item sale value is unsupported');
        }

        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const wallet = await client.query<{ balance_minor: string }>(
          'SELECT balance_minor FROM user_wallets WHERE user_id = $1 FOR UPDATE',
          [userId],
        );
        const currentBalance = BigInt(wallet.rows[0]?.balance_minor ?? '0');
        if (proceeds > POSTGRES_BIGINT_MAX - currentBalance) {
          throw new AppError(400, 'BALANCE_LIMIT_EXCEEDED', 'Wallet balance limit exceeded');
        }

        if (body.quantity === lot.quantity) {
          await client.query(
            "UPDATE inventory_lots SET state = 'consumed', updated_at = now() WHERE id = $1",
            [lot.id],
          );
        } else {
          await client.query(
            'UPDATE inventory_lots SET quantity = quantity - $2, updated_at = now() WHERE id = $1',
            [lot.id, body.quantity],
          );
        }
        const saleId = randomUUID();
        await client.query(
          `INSERT INTO inventory_lots
             (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
           VALUES ($1, $2, NULL, $3, $4, 'available', 'item_sale', $5)`,
          [randomUUID(), lot.catalog_item_id, lot.bot_id, body.quantity, saleId],
        );
        await client.query(
          `INSERT INTO custody_movements
             (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
           VALUES ($1, $2, $3, $4, NULL, $5, 'item_sale', $6)`,
          [randomUUID(), lot.catalog_item_id, lot.bot_id, userId, body.quantity, saleId],
        );
        const credited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets
              SET balance_minor = balance_minor + $2, updated_at = now()
            WHERE user_id = $1 RETURNING balance_minor`,
          [userId, proceeds.toString()],
        );
        const balanceAfter = credited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) throw new Error('Wallet credit returned no balance');
        await client.query(
          `INSERT INTO inventory_sales
             (id, user_id, source_inventory_lot_id, catalog_item_id, quantity,
              unit_value_minor, sell_rate_bps, proceeds_minor, balance_after_minor,
              idempotency_key, request_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            saleId,
            userId,
            lot.id,
            lot.catalog_item_id,
            body.quantity,
            lot.unit_value_minor,
            config.itemSellRateBps,
            proceeds.toString(),
            balanceAfter,
            idempotencyKey,
            requestHash,
          ],
        );
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'item_sale', $5)`,
          [randomUUID(), userId, proceeds.toString(), balanceAfter, saleId],
        );
        return { replay: false, sale: await loadSale(client, saleId) };
      });

      return reply.code(result.replay ? 200 : 201).send(formatSale(result.sale));
    },
  );
}

async function loadSale(client: DbClient, saleId: string): Promise<SaleRow> {
  const result = await client.query<SaleRow>(
    `SELECT s.*, c.display_name, c.image_url
       FROM inventory_sales s JOIN catalog_items c ON c.id = s.catalog_item_id
      WHERE s.id = $1`,
    [saleId],
  );
  const sale = result.rows[0];
  if (!sale) throw new Error('Inventory sale insert returned no row');
  return sale;
}

function formatSale(sale: SaleRow) {
  return {
    sale: {
      id: sale.id,
      inventoryLotId: sale.source_inventory_lot_id,
      catalogItemId: sale.catalog_item_id,
      displayName: sale.display_name,
      imageUrl: sale.image_url,
      quantity: sale.quantity,
      unitValueMinor: sale.unit_value_minor,
      sellRateBps: sale.sell_rate_bps,
      proceedsMinor: sale.proceeds_minor,
      createdAt: sale.created_at,
    },
    balanceMinor: sale.balance_after_minor,
  };
}
