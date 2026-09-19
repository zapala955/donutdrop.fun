import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';
import { computeYield } from '../lib/vault-yield.js';

const claimSchema = z
  .object({
    // Claim named lots, or omit to sweep everything that has earned. Naming lots keeps a claim
    // reproducible under an idempotency key even as other lots keep accruing around it.
    inventoryLotIds: z.array(z.uuid()).min(1).max(200).optional(),
  })
  .strict();

interface YieldLotRow {
  id: string;
  catalog_item_id: string;
  quantity: number;
  unit_value_minor: string;
  yield_anchor_at: Date;
  yield_claimed_minor: string;
  display_name: string;
  image_url: string | null;
  minecraft_name: string;
}

export async function registerVaultRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const terms = {
    ratePerDayBps: config.vaultYieldBpsPerDay,
    capBps: config.vaultYieldCapBps,
  };

  app.get('/v1/vault/config', { preHandler: guards.authenticate }, async () => ({
    yieldBpsPerDay: config.vaultYieldBpsPerDay,
    yieldCapBps: config.vaultYieldCapBps,
    yieldEnabled: config.vaultYieldBpsPerDay > 0,
  }));

  /**
   * What every held lot has earned. Derived on read from the lot's anchor, so this endpoint and
   * the claim below cannot disagree: they run the same function over the same rows.
   */
  app.get('/v1/vault/yield', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const now = new Date();
    const result = await db.query<YieldLotRow>(
      `SELECT i.id, i.catalog_item_id, i.quantity, i.yield_anchor_at, i.yield_claimed_minor,
              c.unit_value_minor, c.display_name, c.image_url, c.minecraft_name
         FROM inventory_lots i JOIN catalog_items c ON c.id = i.catalog_item_id
        WHERE i.owner_user_id = $1 AND i.state = 'available'
        ORDER BY i.yield_anchor_at, i.id`,
      [userId],
    );

    let totalClaimable = 0n;
    const lots = result.rows.map((row) => {
      const accrual = computeYield({
        ...terms,
        baselineValueMinor: BigInt(row.unit_value_minor),
        quantity: row.quantity,
        anchorAt: row.yield_anchor_at,
        now,
        claimedMinor: BigInt(row.yield_claimed_minor),
      });
      totalClaimable += accrual.claimableMinor;
      return {
        inventoryLotId: row.id,
        catalogItemId: row.catalog_item_id,
        displayName: row.display_name,
        minecraftName: row.minecraft_name,
        imageUrl: row.image_url,
        quantity: row.quantity,
        unitValueMinor: row.unit_value_minor,
        anchorAt: row.yield_anchor_at,
        heldDays: accrual.elapsedDays,
        claimableMinor: accrual.claimableMinor.toString(),
        claimedMinor: row.yield_claimed_minor,
        capMinor: accrual.capMinor.toString(),
        capped: accrual.capped,
      };
    });

    return {
      lots,
      totalClaimableMinor: totalClaimable.toString(),
      yieldBpsPerDay: config.vaultYieldBpsPerDay,
      yieldCapBps: config.vaultYieldCapBps,
    };
  });

  /**
   * Settles accrued yield into the wallet and advances each lot's anchor.
   *
   * The anchor moves forward by whole days only, never to `now`. Moving it to now would silently
   * discard the hours between the last whole day and the request, so a player who claims every
   * evening would earn less than one who claims once a month. Advancing by exactly what was paid
   * for makes the two identical.
   */
  app.post(
    '/v1/vault/yield/claim',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (config.vaultYieldBpsPerDay <= 0) {
        throw new AppError(409, 'VAULT_YIELD_DISABLED', 'Vault yield is not enabled');
      }
      const body = parseWith(claimSchema, request.body ?? {});
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const userId = requireUserId(request.authUser?.id);
      const lotFilter = body.inventoryLotIds ?? null;
      if (lotFilter && new Set(lotFilter).size !== lotFilter.length) {
        throw new AppError(400, 'DUPLICATE_LOT', 'Each inventory lot may only appear once');
      }

      const settled = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8839))', [
          `${userId}:${idempotencyKey}`,
        ]);

        /* A claim is one wallet credit, and wallet_transactions is unique on
         * (kind, reference_id). The reference is derived from the idempotency key, so a retry
         * finds its own earlier row without a replay table of its own. */
        const claimId = idempotencyKeyToUuid(idempotencyKey);
        const previous = await client.query<{ amount_minor: string; balance_after_minor: string }>(
          `SELECT amount_minor, balance_after_minor FROM wallet_transactions
            WHERE user_id = $1 AND kind = 'vault_yield' AND reference_id = $2`,
          [userId, claimId],
        );
        if (previous.rows[0]) {
          return {
            replay: true,
            creditedMinor: previous.rows[0].amount_minor,
            balanceAfterMinor: previous.rows[0].balance_after_minor,
            lots: [] as string[],
          };
        }

        const lots = await client.query<YieldLotRow>(
          `SELECT i.id, i.catalog_item_id, i.quantity, i.yield_anchor_at, i.yield_claimed_minor,
                  c.unit_value_minor, c.display_name, c.image_url, c.minecraft_name
             FROM inventory_lots i JOIN catalog_items c ON c.id = i.catalog_item_id
            WHERE i.owner_user_id = $1 AND i.state = 'available'
              AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))
            ORDER BY i.id FOR UPDATE OF i`,
          [userId, lotFilter],
        );
        if (lotFilter && lots.rows.length !== lotFilter.length) {
          conflict('LOT_UNAVAILABLE', 'One or more lots are no longer held and available');
        }

        const now = new Date();
        let credited = 0n;
        const claimed: {
          row: YieldLotRow;
          accrued: bigint;
          days: number;
          anchorAfter: Date;
        }[] = [];

        for (const row of lots.rows) {
          const accrual = computeYield({
            ...terms,
            baselineValueMinor: BigInt(row.unit_value_minor),
            quantity: row.quantity,
            anchorAt: row.yield_anchor_at,
            now,
            claimedMinor: BigInt(row.yield_claimed_minor),
          });
          if (accrual.claimableMinor <= 0n) continue;
          const anchorAfter = new Date(
            row.yield_anchor_at.getTime() + accrual.elapsedDays * 86_400_000,
          );
          credited += accrual.claimableMinor;
          claimed.push({
            row,
            accrued: accrual.claimableMinor,
            days: accrual.elapsedDays,
            anchorAfter,
          });
        }

        if (credited <= 0n) {
          throw new AppError(409, 'NOTHING_TO_CLAIM', 'No vault yield has accrued yet');
        }

        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const creditedWallet = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor + $2, updated_at = now()
            WHERE user_id = $1 RETURNING balance_minor`,
          [userId, credited.toString()],
        );
        const balanceAfter = creditedWallet.rows[0]?.balance_minor;
        if (balanceAfter === undefined) throw new Error('Wallet credit returned no balance');

        for (const entry of claimed) {
          await client.query(
            `INSERT INTO vault_yield_claims
               (id, user_id, inventory_lot_id, catalog_item_id, baseline_value_minor, quantity,
                elapsed_days, rate_bps_per_day, cap_bps, accrued_minor, anchor_before, anchor_after)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              randomUUID(),
              userId,
              entry.row.id,
              entry.row.catalog_item_id,
              entry.row.unit_value_minor,
              entry.row.quantity,
              entry.days,
              config.vaultYieldBpsPerDay,
              config.vaultYieldCapBps,
              entry.accrued.toString(),
              entry.row.yield_anchor_at,
              entry.anchorAfter,
            ],
          );
          await client.query(
            `UPDATE inventory_lots
                SET yield_anchor_at = $2,
                    yield_claimed_minor = yield_claimed_minor + $3,
                    updated_at = now()
              WHERE id = $1`,
            [entry.row.id, entry.anchorAfter, entry.accrued.toString()],
          );
        }

        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'vault_yield', $5)`,
          [randomUUID(), userId, credited.toString(), balanceAfter, claimId],
        );

        return {
          replay: false,
          creditedMinor: credited.toString(),
          balanceAfterMinor: balanceAfter,
          lots: claimed.map((entry) => entry.row.id),
        };
      });

      return reply.code(settled.replay ? 200 : 201).send(settled);
    },
  );

}

/**
 * A claim needs one stable id to hang the wallet transaction and the first claim row on, and it
 * must be derivable from the idempotency key so a retry finds the same row. Hashing the key gives
 * a deterministic UUID without a second table to look it up in.
 */
function idempotencyKeyToUuid(idempotencyKey: string): string {
  const digest = sha256Hex(`vault-yield-claim:${idempotencyKey}`);
  const bytes = digest.slice(0, 32).split('');
  // RFC 4122 version 4 / variant bits, so the value is a well-formed UUID rather than 32 loose hex
  bytes[12] = '4';
  bytes[16] = '8';
  const hex = bytes.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
