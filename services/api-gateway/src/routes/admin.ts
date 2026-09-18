import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, safeEqualText, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';
import { queueWithdrawalJob, refundWithdrawal } from './cash-withdrawals.js';
import { safeText } from '../lib/sanitize.js';

const catalogCreateSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    minecraftName: z.string().regex(/^[a-z0-9_.:-]{1,128}$/),
    displayName: safeText(1, 128),
    imageUrl: z.url().startsWith('https://').max(2048).nullable().default(null),
    unitValueMinor: z.string().regex(/^[1-9]\d{0,15}$/),
    enabled: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).default({}),
    reason: safeText(3, 256),
  })
  .strict();
const catalogUpdateSchema = z
  .object({
    displayName: safeText(1, 128).optional(),
    imageUrl: z.url().startsWith('https://').max(2048).nullable().optional(),
    unitValueMinor: z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .optional(),
    enabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    reason: safeText(3, 256),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'));
const payoutDecisionSchema = z.object({ reason: safeText(3, 256) }).strict();
const stockSchema = z
  .object({
    catalogItemId: z.uuid(),
    botId: z.uuid(),
    quantity: z.number().int().min(1).max(100_000),
    reason: safeText(3, 256),
  })
  .strict();
const complianceSchema = z
  .object({
    ageVerified: z.boolean(),
    kycStatus: z.enum(['not_started', 'pending', 'verified', 'rejected']),
    activate: z.boolean().default(false),
    reason: safeText(3, 256),
  })
  .strict();
const idSchema = z.object({ id: z.uuid() }).strict();
const botQuarantineSchema = z
  .object({
    quarantined: z.boolean(),
    reason: safeText(3, 256),
  })
  .strict();
const adminListSchema = z
  .object({
    search: safeText(1, 64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

/**
 * Administrative routes return these rows to the caller whole. Declaring the columns as
 * `unknown` keeps the response shape intact while preventing an untyped `any` from flowing
 * into application logic, which is what `no-unsafe-assignment` is there to catch.
 */
interface AdminEntityRow {
  [column: string]: unknown;
}

export async function registerAdminRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];
  const requireAdminRead = async (request: Parameters<typeof guards.authenticate>[0]) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };

  app.get('/v1/admin/observed-items', { preHandler: requireAdminRead }, async () => {
    const result = await db.query(
      `SELECT o.bot_id, o.fingerprint, o.minecraft_name, o.display_name, o.metadata,
              o.last_quantity, o.last_seen_at, c.id AS catalog_item_id
         FROM observed_bot_items o LEFT JOIN catalog_items c ON c.fingerprint = o.fingerprint
        ORDER BY o.last_seen_at DESC LIMIT 500`,
    );
    return { items: result.rows };
  });

  app.get('/v1/admin/bots', { preHandler: requireAdminRead }, async () => {
    const result = await db.query(
      `SELECT b.id, b.username, b.status, b.server_host, b.last_heartbeat_at,
              b.last_snapshot_at, b.reconciliation_status, b.transfer_capable,
              (SELECT count(*)::integer FROM bot_jobs j
                WHERE j.bot_id = b.id AND j.status IN ('queued', 'leased', 'dead_letter')) AS open_jobs
         FROM bot_accounts b ORDER BY b.username`,
    );
    return { bots: result.rows };
  });

  app.patch(
    '/v1/admin/bots/:id/quarantine',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(botQuarantineSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      return db.transaction(async (client) => {
        const current = await client.query<{ status: string; can_release: boolean }>(
          `SELECT status,
                  reconciliation_status = 'matched'
                    AND last_heartbeat_at > now() - interval '45 seconds'
                    AND last_snapshot_at > now() - interval '45 seconds' AS can_release
             FROM bot_accounts WHERE id = $1 FOR UPDATE`,
          [params.id],
        );
        const bot = current.rows[0];
        if (!bot) throw new AppError(404, 'BOT_NOT_FOUND', 'Bot was not found');
        if (!body.quarantined && bot.status === 'quarantined' && !bot.can_release) {
          conflict(
            'BOT_RECONCILIATION_REQUIRED',
            'A fresh matching snapshot and heartbeat are required before release',
          );
        }
        const updated = await client.query<AdminEntityRow>(
          `UPDATE bot_accounts
              SET status = $2,
                  transfer_capable = false,
                  updated_at = now()
            WHERE id = $1
            RETURNING id, username, status, reconciliation_status, transfer_capable,
                      last_heartbeat_at, last_snapshot_at`,
          [params.id, body.quarantined ? 'quarantined' : 'degraded'],
        );
        if (body.quarantined) {
          const stoppedJobs = await client.query<{ reference_id: string }>(
            `UPDATE bot_jobs
                SET status = 'dead_letter', last_error_code = 'BOT_QUARANTINED',
                    lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
              WHERE bot_id = $1 AND status IN ('queued', 'leased')
              RETURNING reference_id`,
            [params.id],
          );
          if (stoppedJobs.rows.length) {
            await client.query(
              `UPDATE withdrawals
                  SET status = 'manual_review', error_code = 'BOT_QUARANTINED', updated_at = now()
                WHERE id = ANY($1::uuid[]) AND status IN ('queued', 'processing')`,
              [stoppedJobs.rows.map((row) => row.reference_id)],
            );
          }
        }
        await appendAudit(client, config, {
          actorUserId: actor,
          action: body.quarantined ? 'bot.quarantine' : 'bot.release',
          targetType: 'bot_account',
          targetId: params.id,
          details: { reason: body.reason },
        });
        return { bot: updated.rows[0] };
      });
    },
  );

  app.get('/v1/admin/users', { preHandler: requireAdminRead }, async (request) => {
    const query = parseWith(adminListSchema, request.query);
    const result = await db.query(
      `SELECT id, minecraft_identity, minecraft_username, role, status, country_code,
              age_verified_at, kyc_status, created_at, last_login_at
         FROM users
        WHERE minecraft_identity <> 'system:catalog-seed'
          AND ($1::text IS NULL OR minecraft_username ILIKE '%' || $1 || '%')
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [query.search ?? null, query.limit, query.offset],
    );
    return { users: result.rows, limit: query.limit, offset: query.offset };
  });

  app.get('/v1/admin/jobs', { preHandler: requireAdminRead }, async () => {
    const result = await db.query(
      `SELECT j.id, j.bot_id, j.kind, j.reference_id, j.status, j.attempts,
              j.available_at, j.lease_expires_at, j.last_error_code, j.created_at, j.updated_at
         FROM bot_jobs j WHERE j.status <> 'completed'
        ORDER BY j.created_at DESC LIMIT 500`,
    );
    return { jobs: result.rows };
  });

  app.post(
    '/v1/admin/catalog-items',
    { preHandler: guards.requireAdmin },
    async (request, reply) => {
      const body = parseWith(catalogCreateSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      const itemId = randomUUID();
      const result = await db.transaction(async (client) => {
        const inserted = await client.query<AdminEntityRow>(
          `INSERT INTO catalog_items
           (id, fingerprint, minecraft_name, display_name, image_url, unit_value_minor, enabled, metadata, price_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         RETURNING *`,
          [
            itemId,
            body.fingerprint,
            body.minecraftName,
            body.displayName,
            body.imageUrl,
            body.unitValueMinor,
            body.enabled,
            JSON.stringify(body.metadata),
          ],
        );
        await client.query(
          `INSERT INTO catalog_price_history
           (id, catalog_item_id, old_unit_value_minor, new_unit_value_minor, actor_user_id, reason)
         VALUES ($1, $2, NULL, $3, $4, $5)`,
          [randomUUID(), itemId, body.unitValueMinor, actor, body.reason],
        );
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'catalog.create',
          targetType: 'catalog_item',
          targetId: itemId,
          details: body,
        });
        return inserted.rows[0];
      });
      return reply.code(201).send({ item: result });
    },
  );

  app.patch('/v1/admin/catalog-items/:id', { preHandler: guards.requireAdmin }, async (request) => {
    const body = parseWith(catalogUpdateSchema, request.body);
    const params = parseWith(idSchema, request.params);
    const actor = requireActor(request.authUser?.id);
    return db.transaction(async (client) => {
      const current = await client.query<{ unit_value_minor: string }>(
        'SELECT unit_value_minor FROM catalog_items WHERE id = $1 FOR UPDATE',
        [params.id],
      );
      const old = current.rows[0];
      if (!old) throw new AppError(404, 'CATALOG_ITEM_NOT_FOUND', 'Catalog item was not found');
      const updated = await client.query<AdminEntityRow>(
        `UPDATE catalog_items SET
           display_name = COALESCE($2, display_name),
           image_url = CASE WHEN $3::boolean THEN $4 ELSE image_url END,
           unit_value_minor = COALESCE($5::bigint, unit_value_minor),
           enabled = COALESCE($6::boolean, enabled),
           metadata = COALESCE($7::jsonb, metadata),
           price_updated_at = CASE WHEN $5::bigint IS NULL THEN price_updated_at ELSE now() END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          params.id,
          body.displayName ?? null,
          body.imageUrl !== undefined,
          body.imageUrl ?? null,
          body.unitValueMinor ?? null,
          body.enabled ?? null,
          body.metadata === undefined ? null : JSON.stringify(body.metadata),
        ],
      );
      if (body.unitValueMinor && body.unitValueMinor !== old.unit_value_minor) {
        await client.query(
          `INSERT INTO catalog_price_history
             (id, catalog_item_id, old_unit_value_minor, new_unit_value_minor, actor_user_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), params.id, old.unit_value_minor, body.unitValueMinor, actor, body.reason],
        );
      }
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'catalog.update',
        targetType: 'catalog_item',
        targetId: params.id,
        details: body,
      });
      return { item: updated.rows[0] };
    });
  });

  app.post('/v1/admin/stock', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseWith(stockSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const requestHash = sha256Hex(canonicalJson(body));
    const result = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `admin-command:${actor}:${idempotencyKey}`,
      ]);
      const previous = await client.query<{
        command_type: string;
        request_hash: string;
        result: unknown;
      }>(
        `SELECT command_type, request_hash, result FROM admin_commands
          WHERE actor_user_id = $1 AND idempotency_key = $2`,
        [actor, idempotencyKey],
      );
      if (previous.rows[0]) {
        const replay = readStockCommand(previous.rows[0], requestHash);
        return { value: replay, replay: true };
      }
      const catalog = await client.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM catalog_items WHERE id = $1 AND enabled',
        [body.catalogItemId],
      );
      const item = catalog.rows[0];
      if (!item)
        throw new AppError(404, 'CATALOG_ITEM_NOT_FOUND', 'Enabled catalog item was not found');
      const bot = await client.query(
        `SELECT id FROM bot_accounts
          WHERE id = $1 AND id = ANY($2::uuid[])
            AND last_snapshot_at > now() - interval '45 seconds'
          FOR UPDATE`,
        [body.botId, provisionedBotIds],
      );
      if (!bot.rowCount) {
        conflict('FRESH_SNAPSHOT_REQUIRED', 'A fresh physical bot snapshot is required');
      }
      const snapshot = await client.query<{ totals: Record<string, number> }>(
        `SELECT totals FROM bot_inventory_snapshots WHERE bot_id = $1
             AND created_at > now() - interval '45 seconds'
           ORDER BY created_at DESC LIMIT 1`,
        [body.botId],
      );
      const physical = snapshot.rows[0]?.totals[item.fingerprint] ?? 0;
      const allocated = await client.query<{ quantity: string }>(
        `SELECT COALESCE(sum(quantity), 0)::bigint AS quantity FROM inventory_lots
          WHERE bot_id = $1 AND catalog_item_id = $2
            AND state IN ('available', 'withdrawal_pending', 'quarantined')`,
        [body.botId, body.catalogItemId],
      );
      if (BigInt(physical) < BigInt(allocated.rows[0]?.quantity ?? '0') + BigInt(body.quantity)) {
        conflict(
          'INSUFFICIENT_UNALLOCATED_STOCK',
          'Admin stock cannot exceed the bot physical snapshot',
        );
      }
      const lotId = randomUUID();
      await client.query(
        `INSERT INTO inventory_lots
           (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
         VALUES ($1, $2, NULL, $3, $4, 'available', 'admin', $5)`,
        [lotId, body.catalogItemId, body.botId, body.quantity, lotId],
      );
      const value = { inventoryLotId: lotId, ...body };
      await client.query(
        `INSERT INTO admin_commands
           (id, actor_user_id, idempotency_key, request_hash, command_type, result)
         VALUES ($1, $2, $3, $4, 'stock.import', $5)`,
        [randomUUID(), actor, idempotencyKey, requestHash, JSON.stringify(value)],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'stock.import',
        targetType: 'inventory_lot',
        targetId: lotId,
        details: body,
      });
      // The next bot snapshot is required to return the bot to matched status.
      await client.query(
        `UPDATE bot_accounts SET status = 'degraded', reconciliation_status = 'mismatch',
                transfer_capable = false, updated_at = now() WHERE id = $1`,
        [body.botId],
      );
      return { value, replay: false };
    });
    return reply.code(result.replay ? 200 : 201).send(result.value);
  });

  app.patch(
    '/v1/admin/users/:id/compliance',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const body = parseWith(complianceSchema, request.body);
      const params = parseWith(idSchema, request.params);
      const actor = requireActor(request.authUser?.id);
      return db.transaction(async (client) => {
        const current = await client.query<{
          status: string;
          country_code: string | null;
          date_of_birth: Date | string | null;
          terms_accepted_at: Date | null;
          age_verified_at: Date | null;
          kyc_status: 'not_started' | 'pending' | 'verified' | 'rejected';
          self_exclusion_locked: boolean;
          self_exclusion_expired: boolean;
        }>(
          `SELECT u.status, u.country_code, u.date_of_birth, u.terms_accepted_at,
                  u.age_verified_at, u.kyc_status,
                  (u.status = 'self_excluded' AND
                    (r.self_excluded_until IS NULL OR r.self_excluded_until > now()))
                    AS self_exclusion_locked,
                  (u.status = 'self_excluded' AND r.self_excluded_until <= now())
                    AS self_exclusion_expired
             FROM users u JOIN responsible_limits r ON r.user_id = u.id
            WHERE u.id = $1 FOR UPDATE OF u, r`,
          [params.id],
        );
        const user = current.rows[0];
        if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
        if (user.self_exclusion_locked && body.activate) {
          conflict('SELF_EXCLUSION_LOCKED', 'The self-exclusion period has not expired');
        }
        if (body.activate && (user.status === 'closed' || user.status === 'suspended')) {
          conflict(
            'ACCOUNT_STATUS_LOCKED',
            'Closed or suspended accounts require a separate account review',
          );
        }
        if (
          body.activate &&
          (!body.ageVerified ||
            body.kycStatus !== 'verified' ||
            !user.country_code ||
            !user.date_of_birth ||
            !user.terms_accepted_at)
        ) {
          conflict(
            'COMPLIANCE_INCOMPLETE',
            'Country, birth date, accepted terms, age verification, and verified KYC are required',
          );
        }
        if (body.activate && user.date_of_birth && !isAdult(user.date_of_birth)) {
          conflict('AGE_RESTRICTED', 'The account holder must be at least 18 years old');
        }
        if (
          body.activate &&
          config.allowedCountries.size &&
          user.country_code &&
          !config.allowedCountries.has(user.country_code.trim().toLowerCase())
        ) {
          conflict('COUNTRY_NOT_ALLOWED', 'Service is not available in this country');
        }
        const nextStatus = body.activate
          ? 'active'
          : user.status === 'active' && (!body.ageVerified || body.kycStatus !== 'verified')
            ? 'pending_compliance'
            : user.status;
        const updated = await client.query<AdminEntityRow>(
          `UPDATE users SET age_verified_at = CASE WHEN $2 THEN COALESCE(age_verified_at, now()) ELSE NULL END,
                kyc_status = $3, status = $4, updated_at = now()
          WHERE id = $1 RETURNING id, minecraft_username, status, age_verified_at, kyc_status`,
          [params.id, body.ageVerified, body.kycStatus, nextStatus],
        );
        if (body.activate && user.self_exclusion_expired) {
          await client.query(
            `UPDATE responsible_limits SET self_excluded_until = NULL, updated_at = now()
              WHERE user_id = $1`,
            [params.id],
          );
        }
        if (
          nextStatus !== user.status ||
          Boolean(user.age_verified_at) !== body.ageVerified ||
          user.kyc_status !== body.kycStatus
        ) {
          await client.query(
            'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [params.id],
          );
        }
        if (nextStatus !== 'active') {
          await client.query(
            `UPDATE deposit_intents SET status = 'cancelled'
              WHERE user_id = $1 AND status = 'pending'`,
            [params.id],
          );
        }
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'user.compliance_update',
          targetType: 'user',
          targetId: params.id,
          details: body,
        });
        return { user: updated.rows[0] };
      });
    },
  );

  /* ─────────────────────── cash payouts awaiting a human ───────────────────────
   *
   * Anything over the auto-approval ceiling lands here, along with any payout whose outcome the
   * bot could not establish. The two share one queue deliberately: both mean money is held and
   * somebody has to decide what happens to it.
   */

  app.get('/v1/admin/cash-withdrawals', { preHandler: requireAdminRead }, async () => {
    const result = await db.query(
      `SELECT w.id, w.user_id, u.minecraft_username, w.payee_username, w.amount_minor,
              w.status, w.error_code, w.created_at, w.approved_at
         FROM cash_withdrawals w JOIN users u ON u.id = w.user_id
        WHERE w.status IN ('pending_approval', 'manual_review', 'processing')
        ORDER BY w.created_at LIMIT 200`,
    );
    return { withdrawals: result.rows };
  });

  app.post(
    '/v1/admin/cash-withdrawals/:id/approve',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(payoutDecisionSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      return db.transaction(async (client) => {
        /* The status guard lives in the UPDATE. Two operators opening the same queue and both
         * clicking approve is an ordinary Tuesday, and only one of them may queue a job. */
        const approved = await client.query<{
          id: string;
          bot_id: string;
          payee_username: string;
          amount_minor: string;
        }>(
          `UPDATE cash_withdrawals
              SET status = 'queued', approved_by = $2, approved_at = now(), error_code = NULL,
                  updated_at = now()
            WHERE id = $1 AND status = 'pending_approval'
            RETURNING id, bot_id, payee_username, amount_minor`,
          [params.id, actor],
        );
        const row = approved.rows[0];
        if (!row) {
          conflict('WITHDRAWAL_NOT_PENDING', 'That payout is not waiting for approval');
          throw new AppError(409, 'WITHDRAWAL_NOT_PENDING', 'Unreachable');
        }
        await queueWithdrawalJob(client, row);
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'cash_withdrawal.approve',
          targetType: 'cash_withdrawal',
          targetId: params.id,
          details: { amountMinor: row.amount_minor, reason: body.reason },
        });
        return { withdrawal: { id: row.id, status: 'queued' } };
      });
    },
  );

  app.post(
    '/v1/admin/cash-withdrawals/:id/reject',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(payoutDecisionSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      return db.transaction(async (client) => {
        /* Only a payout still waiting for approval can be rejected. One under manual review may
         * already have been paid in game, and handing the money back a second time is the mistake
         * this refuses to let an operator make in one click. */
        const held = await client.query<{ amount_minor: string }>(
          `SELECT amount_minor FROM cash_withdrawals
            WHERE id = $1 AND status = 'pending_approval' FOR UPDATE`,
          [params.id],
        );
        const row = held.rows[0];
        if (!row) {
          conflict('WITHDRAWAL_NOT_PENDING', 'That payout is not waiting for approval');
          throw new AppError(409, 'WITHDRAWAL_NOT_PENDING', 'Unreachable');
        }
        await refundWithdrawal(client, params.id, 'REJECTED_BY_ADMIN');
        await client.query(
          `UPDATE cash_withdrawals SET status = 'rejected', approved_by = $2, approved_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [params.id, actor],
        );
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'cash_withdrawal.reject',
          targetType: 'cash_withdrawal',
          targetId: params.id,
          details: { amountMinor: row.amount_minor, reason: body.reason },
        });
        return { withdrawal: { id: params.id, status: 'rejected' } };
      });
    },
  );
}

interface StoredCommand {
  command_type: string;
  request_hash: string;
  result: unknown;
}

function readStockCommand(command: StoredCommand, requestHash: string): unknown {
  if (
    command.command_type !== 'stock.import' ||
    !isRecord(command.result) ||
    !safeEqualText(command.request_hash, requestHash)
  ) {
    conflict('IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for another request');
  }
  return command.result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAdult(dateOfBirth: Date | string, now = new Date()): boolean {
  const birth =
    dateOfBirth instanceof Date ? dateOfBirth : new Date(`${dateOfBirth}T00:00:00.000Z`);
  if (Number.isNaN(birth.getTime())) return false;
  const birthdayThisYear = new Date(
    Date.UTC(now.getUTCFullYear(), birth.getUTCMonth(), birth.getUTCDate()),
  );
  const age = now.getUTCFullYear() - birth.getUTCFullYear() - (now < birthdayThisYear ? 1 : 0);
  return age >= 18 && age <= 120;
}

function requireActor(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
