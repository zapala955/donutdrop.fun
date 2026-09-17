import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';
import { computeYield, piggyMaturedPayoutMinor } from '../lib/vault-yield.js';
import { POSTGRES_BIGINT_MAX } from './upgrades.js';

const positiveMinorPattern = /^[1-9]\d{0,18}$/;
/* Zod runs every refinement even after the pattern check has failed, so this callback still sees
 * input like "1.5" or "abc" — and BigInt() throws on those, escaping validation as a 500 rather
 * than the 400 it should be. Re-testing the pattern keeps the conversion on values already known
 * to be convertible. */
const positiveMinorSchema = z
  .string()
  .regex(positiveMinorPattern)
  .refine(
    (value) => !positiveMinorPattern.test(value) || BigInt(value) <= POSTGRES_BIGINT_MAX,
    'Value exceeds database range',
  );

const claimSchema = z
  .object({
    // Claim named lots, or omit to sweep everything that has earned. Naming lots keeps a claim
    // reproducible under an idempotency key even as other lots keep accruing around it.
    inventoryLotIds: z.array(z.uuid()).min(1).max(200).optional(),
  })
  .strict();

const piggyOpenSchema = z
  .object({
    principalMinor: positiveMinorSchema,
    lockDays: z.number().int().min(1).max(730),
  })
  .strict();

const depositParamsSchema = z.object({ id: z.uuid() }).strict();

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

interface PiggyDepositRow {
  id: string;
  principal_minor: string;
  apr_bps: number;
  lock_days: number;
  matured_payout_minor: string;
  opened_at: Date;
  unlocks_at: Date;
  claimed_at: Date | null;
  broken_at: Date | null;
  payout_minor: string | null;
  balance_after_minor: string | null;
  request_hash?: string;
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
    piggyBank: {
      enabled: config.piggyBankEnabled,
      aprBps: config.piggyBankAprBps,
      minLockDays: config.piggyBankMinLockDays,
      maxLockDays: config.piggyBankMaxLockDays,
      minDepositMinor: config.piggyBankMinDepositMinor.toString(),
      maxOpenDeposits: config.piggyBankMaxOpenDeposits,
    },
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

  // ── piggy bank ─────────────────────────────────────────────────────────────

  app.get('/v1/vault/piggy-bank', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const result = await db.query<PiggyDepositRow>(
      `SELECT id, principal_minor, apr_bps, lock_days, matured_payout_minor, opened_at,
              unlocks_at, claimed_at, broken_at, payout_minor, balance_after_minor
         FROM piggy_bank_deposits WHERE user_id = $1
        ORDER BY opened_at DESC, id DESC LIMIT 100`,
      [userId],
    );
    const now = Date.now();
    return {
      deposits: result.rows.map((row) => ({
        id: row.id,
        principalMinor: row.principal_minor,
        aprBps: row.apr_bps,
        lockDays: row.lock_days,
        maturedPayoutMinor: row.matured_payout_minor,
        openedAt: row.opened_at,
        unlocksAt: row.unlocks_at,
        claimedAt: row.claimed_at,
        brokenAt: row.broken_at,
        payoutMinor: row.payout_minor,
        state: row.claimed_at ? 'claimed' : row.broken_at ? 'broken' : 'open',
        matured: !row.claimed_at && !row.broken_at && row.unlocks_at.getTime() <= now,
      })),
    };
  });

  app.post(
    '/v1/vault/piggy-bank',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!config.piggyBankEnabled) {
        throw new AppError(409, 'PIGGY_BANK_DISABLED', 'The piggy bank is not enabled');
      }
      const body = parseWith(piggyOpenSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const userId = requireUserId(request.authUser?.id);
      const requestHash = sha256Hex(canonicalJson(body));
      const principal = BigInt(body.principalMinor);

      if (body.lockDays < config.piggyBankMinLockDays) {
        throw new AppError(
          400,
          'LOCK_TOO_SHORT',
          `Funds must be locked for at least ${config.piggyBankMinLockDays} days`,
        );
      }
      if (body.lockDays > config.piggyBankMaxLockDays) {
        throw new AppError(
          400,
          'LOCK_TOO_LONG',
          `Funds may be locked for at most ${config.piggyBankMaxLockDays} days`,
        );
      }
      if (principal < config.piggyBankMinDepositMinor) {
        throw new AppError(400, 'DEPOSIT_TOO_SMALL', 'Deposit is below the minimum');
      }

      const opened = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8841))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const previous = await client.query<PiggyDepositRow>(
          `SELECT id, principal_minor, apr_bps, lock_days, matured_payout_minor, opened_at,
                  unlocks_at, claimed_at, broken_at, payout_minor, balance_after_minor, request_hash
             FROM piggy_bank_deposits WHERE user_id = $1 AND idempotency_key = $2`,
          [userId, idempotencyKey],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return { deposit: previous.rows[0], replay: true };
        }

        const open = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM piggy_bank_deposits
            WHERE user_id = $1 AND claimed_at IS NULL AND broken_at IS NULL`,
          [userId],
        );
        if (Number(open.rows[0]?.count ?? '0') >= config.piggyBankMaxOpenDeposits) {
          conflict('TOO_MANY_DEPOSITS', 'You already hold the maximum number of open deposits');
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
        if (BigInt(wallet.rows[0]?.balance_minor ?? '0') < principal) {
          throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for this deposit');
        }
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 RETURNING balance_minor`,
          [userId, principal.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) throw new Error('Wallet debit returned no balance');

        const depositId = randomUUID();
        const maturedPayout = piggyMaturedPayoutMinor(
          principal,
          config.piggyBankAprBps,
          body.lockDays,
        );
        if (maturedPayout > POSTGRES_BIGINT_MAX) {
          throw new AppError(400, 'VALUE_OUT_OF_RANGE', 'Deposit payout exceeds the supported range');
        }

        const inserted = await client.query<PiggyDepositRow>(
          `INSERT INTO piggy_bank_deposits
             (id, user_id, idempotency_key, request_hash, principal_minor, apr_bps, lock_days,
              matured_payout_minor, unlocks_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $7))
           RETURNING id, principal_minor, apr_bps, lock_days, matured_payout_minor, opened_at,
                     unlocks_at, claimed_at, broken_at, payout_minor, balance_after_minor`,
          [
            depositId,
            userId,
            idempotencyKey,
            requestHash,
            principal.toString(),
            config.piggyBankAprBps,
            body.lockDays,
            maturedPayout.toString(),
          ],
        );

        await client.query(
          `INSERT INTO piggy_bank_events (id, deposit_id, user_id, kind, amount_minor, balance_after_minor)
           VALUES ($1, $2, $3, 'open', $4, $5)`,
          [randomUUID(), depositId, userId, (-principal).toString(), balanceAfter],
        );
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'piggy_open', $5)`,
          [randomUUID(), userId, (-principal).toString(), balanceAfter, depositId],
        );

        const row = inserted.rows[0];
        if (!row) throw new Error('Piggy bank insert returned no row');
        return { deposit: row, replay: false };
      });

      return reply.code(opened.replay ? 200 : 201).send(formatDeposit(opened.deposit));
    },
  );

  /**
   * Claim at maturity, or break early for principal only.
   *
   * Breaking is deliberately offered rather than withheld. A lock a player cannot exit is a trap,
   * and the forfeited interest is enough to make holding the better choice without making the
   * deposit a thing they regret agreeing to.
   */
  app.post(
    '/v1/vault/piggy-bank/:id/settle',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = parseWith(depositParamsSchema, request.params);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const userId = requireUserId(request.authUser?.id);

      const settled = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8843))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const found = await client.query<PiggyDepositRow>(
          `SELECT id, principal_minor, apr_bps, lock_days, matured_payout_minor, opened_at,
                  unlocks_at, claimed_at, broken_at, payout_minor, balance_after_minor
             FROM piggy_bank_deposits WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [params.id, userId],
        );
        const deposit = found.rows[0];
        if (!deposit) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Deposit not found');
        if (deposit.claimed_at || deposit.broken_at) {
          // Already settled: hand back the same answer rather than paying twice.
          return { deposit, replay: true };
        }

        const matured = deposit.unlocks_at.getTime() <= Date.now();
        const payout = matured
          ? BigInt(deposit.matured_payout_minor)
          : BigInt(deposit.principal_minor);

        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const credited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor + $2, updated_at = now()
            WHERE user_id = $1 RETURNING balance_minor`,
          [userId, payout.toString()],
        );
        const balanceAfter = credited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) throw new Error('Wallet credit returned no balance');

        const updated = await client.query<PiggyDepositRow>(
          `UPDATE piggy_bank_deposits
              SET claimed_at = CASE WHEN $2 THEN now() ELSE NULL END,
                  broken_at  = CASE WHEN $2 THEN NULL ELSE now() END,
                  payout_minor = $3,
                  balance_after_minor = $4
            WHERE id = $1
            RETURNING id, principal_minor, apr_bps, lock_days, matured_payout_minor, opened_at,
                      unlocks_at, claimed_at, broken_at, payout_minor, balance_after_minor`,
          [deposit.id, matured, payout.toString(), balanceAfter],
        );

        await client.query(
          `INSERT INTO piggy_bank_events (id, deposit_id, user_id, kind, amount_minor, balance_after_minor)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            deposit.id,
            userId,
            matured ? 'claim' : 'break',
            payout.toString(),
            balanceAfter,
          ],
        );
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            userId,
            payout.toString(),
            balanceAfter,
            matured ? 'piggy_claim' : 'piggy_break',
            deposit.id,
          ],
        );

        const row = updated.rows[0];
        if (!row) throw new Error('Piggy bank settle returned no row');
        return { deposit: row, replay: false };
      });

      return reply.code(settled.replay ? 200 : 201).send(formatDeposit(settled.deposit));
    },
  );
}

function formatDeposit(row: PiggyDepositRow) {
  return {
    id: row.id,
    principalMinor: row.principal_minor,
    aprBps: row.apr_bps,
    lockDays: row.lock_days,
    maturedPayoutMinor: row.matured_payout_minor,
    openedAt: row.opened_at,
    unlocksAt: row.unlocks_at,
    claimedAt: row.claimed_at,
    brokenAt: row.broken_at,
    payoutMinor: row.payout_minor,
    balanceAfterMinor: row.balance_after_minor,
    state: row.claimed_at ? 'claimed' : row.broken_at ? 'broken' : 'open',
  };
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
