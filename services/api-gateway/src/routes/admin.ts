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
import {
  LADDER_CEILING_MINOR,
  LADDER_FLOOR_MINOR,
  UPGRADE_LADDER,
  ladderMetadataFor,
} from '../lib/upgrade-ladder.js';

/* The ladder is one standing thing rather than a row, so every publish audits against the same
 * target and reads back as one object's history. `audit_log.target_id` is a varchar, so this can
 * say what it is rather than being a uuid somebody has to look up. */
const LADDER_ID = 'upgrade-ladder';

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
/* The ladder's prices are fixed in code, so the operator supplies nothing but the reason. There is
 * deliberately no way to pass values here: a publish that could be handed arbitrary figures would
 * be the bulk price-setting endpoint the catalogue rules exist to prevent. */
const catalogLadderSchema = z.object({ reason: safeText(3, 256) }).strict();
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
/* Suspension is its own endpoint rather than a field on the compliance one, because the two ask
 * different questions. Compliance asks "has this person proven who they are"; this asks "is this
 * account allowed to trade right now", which is an operator's call and is reversible. The reachable
 * set deliberately excludes 'self_excluded': that is the player's own decision and an operator
 * lifting it by hand is the one thing responsible-gaming rules exist to prevent. */
const userStatusSchema = z
  .object({
    status: z.enum(['active', 'suspended', 'closed']),
    reason: safeText(3, 256),
  })
  .strict();

/* Signed rather than an amount plus a direction. A direction flag is one inverted boolean away
 * from crediting what was meant to be taken back, and the sign is unambiguous in the audit entry.
 *
 * Thirteen digits, so just under ten trillion per call. That is a ceiling against a slipped
 * keystroke running away entirely, not a policy limit — it is far above any correction anybody
 * should be making, and the real control is that every move writes a ledger row and an audit
 * entry naming who did it and why. */
const balanceAdjustSchema = z
  .object({
    amountMinor: z
      .string()
      .regex(/^-?[1-9]\d{0,12}$/, 'A non-zero whole amount in minor units'),
    reason: safeText(3, 256),
  })
  .strict();

/* Paying a player in game out of the bot's own balance. `payee` is a Minecraft name, not a user
 * id: paying somebody who has never signed into the site is a legitimate operator action. */
const adminPaySchema = z
  .object({
    payee: z
      .string()
      .regex(/^[A-Za-z0-9_]{3,16}$/, 'A Minecraft username'),
    amountMinor: z.string().regex(/^[1-9]\d{0,12}$/),
    reason: safeText(3, 256),
  })
  .strict();

const botReconnectSchema = z.object({ reason: safeText(3, 256) }).strict();

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

  /* Everything about one account on one screen: who they are, what they hold, what they have been
   * doing, and what is currently signed in as them. Assembled in one round trip because an
   * operator deciding whether to suspend somebody should not have to click four times to see the
   * four facts that decide it. */
  app.get('/v1/admin/users/:id', { preHandler: requireAdminRead }, async (request) => {
    const params = parseWith(idSchema, request.params);
    const [user, wallet, ledger, sessions, limits] = await Promise.all([
      db.query<AdminEntityRow>(
        `SELECT id, minecraft_identity, minecraft_username, normalized_username, role, status,
                country_code, date_of_birth, terms_accepted_at, age_verified_at, kyc_status,
                created_at, updated_at, last_login_at
           FROM users WHERE id = $1`,
        [params.id],
      ),
      db.query<{ balance_minor: string }>(
        'SELECT balance_minor FROM user_wallets WHERE user_id = $1',
        [params.id],
      ),
      db.query<AdminEntityRow>(
        `SELECT id, amount_minor, balance_after_minor, kind, reference_id, created_at
           FROM wallet_transactions WHERE user_id = $1
          ORDER BY created_at DESC, id DESC LIMIT 25`,
        [params.id],
      ),
      db.query<AdminEntityRow>(
        `SELECT id, user_agent, created_at, last_seen_at, expires_at
           FROM sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
          ORDER BY last_seen_at DESC LIMIT 25`,
        [params.id],
      ),
      db.query<AdminEntityRow>(
        'SELECT self_excluded_until FROM responsible_limits WHERE user_id = $1',
        [params.id],
      ),
    ]);
    if (!user.rows[0]) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
    return {
      user: user.rows[0],
      /* No wallet row means a player who has never had a balance, which is zero, not missing. */
      balanceMinor: wallet.rows[0]?.balance_minor ?? '0',
      transactions: ledger.rows,
      sessions: sessions.rows,
      selfExcludedUntil: limits.rows[0]?.['self_excluded_until'] ?? null,
    };
  });

  /* Suspending an account also ends its sessions. Leaving them live means the person keeps a
   * working page until their cookie expires, which is not what anybody means by "suspend". */
  app.patch('/v1/admin/users/:id/status', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(idSchema, request.params);
    const body = parseWith(userStatusSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    if (params.id === actor && body.status !== 'active') {
      conflict('CANNOT_LOCK_SELF', 'An administrator cannot suspend or close their own account');
    }
    return db.transaction(async (client) => {
      const current = await client.query<{ status: string; locked: boolean }>(
        `SELECT u.status,
                (u.status = 'self_excluded' AND
                  (r.self_excluded_until IS NULL OR r.self_excluded_until > now())) AS locked
           FROM users u LEFT JOIN responsible_limits r ON r.user_id = u.id
          WHERE u.id = $1 FOR UPDATE OF u`,
        [params.id],
      );
      const user = current.rows[0];
      if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
      /* A live self-exclusion outranks an operator. It is the player's own standing instruction
       * and the whole point of it is that nobody, including this console, can talk them out of it
       * before it expires. */
      if (user.locked && body.status === 'active') {
        conflict('SELF_EXCLUSION_LOCKED', 'The self-exclusion period has not expired');
      }
      const updated = await client.query<AdminEntityRow>(
        `UPDATE users SET status = $2, updated_at = now() WHERE id = $1
          RETURNING id, minecraft_username, role, status, kyc_status, age_verified_at`,
        [params.id, body.status],
      );
      let revoked = 0;
      if (body.status !== 'active') {
        const killed = await client.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [params.id],
        );
        revoked = killed.rowCount ?? 0;
      }
      await appendAudit(client, config, {
        actorUserId: actor,
        action: `user.status.${body.status}`,
        targetType: 'user',
        targetId: params.id,
        details: { reason: body.reason, from: user.status, sessionsRevoked: revoked },
      });
      return { user: updated.rows[0], sessionsRevoked: revoked };
    });
  });

  /* THERE IS NO ROLE ENDPOINT, AND THERE CANNOT USEFULLY BE ONE.
   *
   * A console lever wrote `users.role` here and reported success. It never took effect:
   * `authenticate()` re-derives the role from ADMIN_MINECRAFT_IDS on every single request and
   * corrects the row back, revoking the target's sessions on the way past (see lib/auth.ts). So
   * the grant lasted until the promoted account's next request, and its only lasting effect was
   * logging them out.
   *
   * Config is the source of truth on purpose: an administrator also needs a TOTP secret in
   * ADMIN_TOTP_SECRETS, and config refuses to boot unless every listed admin has one. Both are
   * read at startup, so no runtime write can produce an administrator who can actually sign in.
   * Promotion means editing the environment and restarting — deliberately harder than clicking a
   * button, for the one change that hands somebody every power on this page.
   *
   * The console shows the role read-only and says this instead of pretending otherwise.
   */

  /* Ends every live session for an account without changing what the account is allowed to do.
   * The case this is for is a shared or stolen cookie, where the person is not in trouble and
   * suspending them would be the wrong answer. */
  app.post(
    '/v1/admin/users/:id/sessions/revoke',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(payoutDecisionSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      return db.transaction(async (client) => {
        const exists = await client.query('SELECT 1 FROM users WHERE id = $1', [params.id]);
        if (!exists.rowCount) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
        const killed = await client.query(
          `UPDATE sessions SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [params.id],
        );
        const revoked = killed.rowCount ?? 0;
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'user.sessions.revoke',
          targetType: 'user',
          targetId: params.id,
          details: { reason: body.reason, sessionsRevoked: revoked },
        });
        return { sessionsRevoked: revoked };
      });
    },
  );

  /* Moves a player's site balance, up or down, and writes the matching ledger row.
   *
   * The ledger entry is the point. A balance edited without one is a number that no longer
   * reconciles against the sum of its transactions, and the next person to audit this account
   * cannot tell a correction from a leak. `admin_adjustment` is an existing ledger kind precisely
   * so operator corrections land somewhere a reconciliation can find them. */
  app.post('/v1/admin/users/:id/balance', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(idSchema, request.params);
    const body = parseWith(balanceAdjustSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    const delta = BigInt(body.amountMinor);
    return db.transaction(async (client) => {
      const exists = await client.query('SELECT 1 FROM users WHERE id = $1', [params.id]);
      if (!exists.rowCount) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
      await client.query(
        `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [params.id],
      );
      /* The guard is in the WHERE clause, not in a read-then-write. A debit that would take the
       * balance negative simply matches no row, which is the same mechanism every wager on this
       * site uses and is safe against two operators debiting at once. */
      const moved = await client.query<{ balance_minor: string }>(
        `UPDATE user_wallets
            SET balance_minor = balance_minor + $2, updated_at = now()
          WHERE user_id = $1 AND balance_minor + $2 >= 0
          RETURNING balance_minor`,
        [params.id, delta.toString()],
      );
      if (!moved.rows[0]) {
        conflict('INSUFFICIENT_FUNDS', 'That debit would take the balance below zero');
      }
      const balanceAfter = moved.rows[0].balance_minor;
      const adjustmentId = randomUUID();
      await client.query(
        `INSERT INTO wallet_transactions
           (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
         VALUES ($1, $2, $3, $4, 'admin_adjustment', $5)`,
        [adjustmentId, params.id, delta.toString(), balanceAfter, adjustmentId],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: delta > 0n ? 'user.balance.credit' : 'user.balance.debit',
        targetType: 'user',
        targetId: params.id,
        details: {
          reason: body.reason,
          amountMinor: delta.toString(),
          balanceAfterMinor: balanceAfter,
        },
      });
      return { balanceMinor: balanceAfter, adjustmentId };
    });
  });

  /* ─────────────────────────── bot control ─────────────────────────── */

  /* Tells a bot to drop its connection and come back.
   *
   * The bot reconnects on its own ten seconds after any disconnect, so this is not for a bot that
   * has fallen over — that fixes itself. It is for one that is nominally connected and not
   * behaving, where waiting for it to notice is slower than telling it.
   *
   * Queued as a bot_job rather than pushed, because the gateway has no channel to the bot process:
   * the bot claims work by polling. That also means one lease, one attempt counter and one dead
   * letter path, the same as every other thing a bot is ever told to do. */
  app.post('/v1/admin/bots/:id/reconnect', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(idSchema, request.params);
    const body = parseWith(botReconnectSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    return db.transaction(async (client) => {
      const bot = await client.query<{ username: string; status: string }>(
        'SELECT username, status FROM bot_accounts WHERE id = $1 FOR UPDATE',
        [params.id],
      );
      if (!bot.rows[0]) throw new AppError(404, 'BOT_NOT_FOUND', 'Bot was not found');
      /* Queueing a second reconnect behind the first would make the bot cycle twice, which is a
       * slower way to arrive at the same place. */
      const pending = await client.query(
        `SELECT 1 FROM bot_jobs
          WHERE bot_id = $1 AND kind = 'reconnect' AND status IN ('queued', 'leased')`,
        [params.id],
      );
      if (pending.rowCount) {
        conflict('RECONNECT_ALREADY_QUEUED', 'This bot is already on its way back');
      }
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload)
         VALUES ($1, $2, 'reconnect', $3, '{}'::jsonb)`,
        [jobId, params.id, jobId],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'bot.reconnect',
        targetType: 'bot_account',
        targetId: params.id,
        details: { reason: body.reason, jobId },
      });
      return { queued: true, jobId, bot: bot.rows[0].username };
    });
  });

  /* Pays a player in game, out of the bot's own DonutSMP balance.
   *
   * This is NOT a withdrawal and touches nobody's site wallet. It is the house sending currency
   * out — a comp, an apology, a refund made good — so there is no debit to take and nothing to
   * refund if it fails. A failed payout leaves a failed row and a red line in the console, which
   * is the honest outcome; silently crediting the site balance instead would be inventing a
   * different payment from the one that was ordered. */
  app.post('/v1/admin/bots/:id/pay', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(idSchema, request.params);
    const body = parseWith(adminPaySchema, request.body);
    const actor = requireActor(request.authUser?.id);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    return db.transaction(async (client) => {
      /* Only a bot this deployment actually holds credentials for, and only one the server has
       * heard from recently. The same test the withdrawal path uses. */
      const bot = await client.query<{ id: string; username: string; server_host: string }>(
        `SELECT id, username, server_host FROM bot_accounts
          WHERE id = $1 AND id = ANY($2::uuid[]) AND status = 'online'
            AND last_heartbeat_at > now() - interval '45 seconds'
          FOR UPDATE`,
        [params.id, provisionedBotIds],
      );
      const chosen = bot.rows[0];
      if (!chosen) conflict('BOT_UNAVAILABLE', 'That bot is not online and able to pay right now');
      const provisioned = config.botCredentials.get(chosen.id);
      if (
        !provisioned ||
        chosen.username.toLowerCase() !== provisioned.username.toLowerCase() ||
        chosen.server_host.toLowerCase().replace(/\.$/, '') !== provisioned.serverHost
      ) {
        conflict('BOT_UNAVAILABLE', 'That bot does not match its provisioned credentials');
      }
      /* Linked to an account when there is one, by normalized name. A payee with no account is
       * allowed; the link is recorded when it exists so the payment shows on their page. */
      const payee = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE normalized_username = lower($1)',
        [body.payee],
      );

      /* The replay check runs BEFORE the insert, not in a catch around it.
       *
       * A unique violation aborts the whole transaction in Postgres: every statement after it
       * fails with "current transaction is aborted" until a rollback. So reading the original row
       * from inside a catch block — the obvious way to write this — cannot work. The conflict is
       * avoided instead of handled: a matching key is answered here, and the insert below uses ON
       * CONFLICT DO NOTHING so a request that races another with the same key still never raises. */
      const replay = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM admin_payouts
          WHERE actor_user_id = $1 AND idempotency_key = $2`,
        [actor, idempotencyKey],
      );
      if (replay.rows[0]) {
        return {
          payoutId: replay.rows[0].id,
          bot: chosen.username,
          status: replay.rows[0].status,
          replayed: true,
        };
      }

      const payoutId = randomUUID();
      let inserted;
      try {
        inserted = await client.query<{ id: string }>(
          `INSERT INTO admin_payouts
             (id, bot_id, actor_user_id, payee_username, payee_user_id, amount_minor, reason,
              idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            payoutId,
            chosen.id,
            actor,
            body.payee,
            payee.rows[0]?.id ?? null,
            body.amountMinor,
            body.reason,
            idempotencyKey,
          ],
        );
      } catch (error) {
        /* The one-live-payout-per-payee index is a partial unique index, which ON CONFLICT cannot
         * name, so this one still arrives as an error. Nothing is read after it: the transaction
         * is already aborted and this throws straight out to a rollback. */
        if (
          isRecord(error) &&
          error['code'] === '23505' &&
          typeof error['constraint'] === 'string' &&
          error['constraint'].includes('one_live')
        ) {
          conflict('PAYOUT_ALREADY_PENDING', 'A payout to that player is already in flight');
        }
        throw error;
      }
      /* Lost a race with an identical key. The winner's row is the answer, and it is readable
       * because DO NOTHING raised nothing and the transaction is still healthy. */
      if (!inserted.rows[0]) {
        const winner = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM admin_payouts
            WHERE actor_user_id = $1 AND idempotency_key = $2`,
          [actor, idempotencyKey],
        );
        const existing = winner.rows[0];
        if (!existing) throw new AppError(500, 'PAYOUT_RACE_UNRESOLVED', 'Could not settle a retry');
        return {
          payoutId: existing.id,
          bot: chosen.username,
          status: existing.status,
          replayed: true,
        };
      }

      await client.query(
        `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload)
         VALUES ($1, $2, 'admin_payout', $3, $4)`,
        [
          randomUUID(),
          chosen.id,
          payoutId,
          JSON.stringify({
            payoutId,
            payee: body.payee,
            amountMinor: body.amountMinor,
          }),
        ],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'bot.pay',
        targetType: 'admin_payout',
        targetId: payoutId,
        details: {
          reason: body.reason,
          bot: chosen.username,
          payee: body.payee,
          amountMinor: body.amountMinor,
        },
      });
      return { payoutId, bot: chosen.username, status: 'queued' };
    });
  });

  app.get('/v1/admin/payouts', { preHandler: requireAdminRead }, async () => {
    const result = await db.query<AdminEntityRow>(
      `SELECT p.id, p.payee_username, p.amount_minor, p.status, p.reason, p.error_code,
              p.paid_at, p.created_at, b.username AS bot_username,
              a.minecraft_username AS actor_username
         FROM admin_payouts p
         JOIN bot_accounts b ON b.id = p.bot_id
         JOIN users a ON a.id = p.actor_user_id
        ORDER BY p.created_at DESC LIMIT 100`,
    );
    return { payouts: result.rows };
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

  /**
   * Publishes the upgrader's fixed-price ladder: fifty-one denominations, $100K to $10B.
   *
   * WHY THIS IS A ROUTE AND NOT A MIGRATION OR A SEED FILE
   * -----------------------------------------------------
   * Both of those paths are closed on purpose. `scripts/seed.ts` refuses to load a catalogue from
   * disk and `tests/empty-catalog.test.ts` asserts that no migration inserts `catalog_items`,
   * because `unit_value_minor` is the figure the house pays out on: a price with no authenticated
   * actor behind it is a payout nobody can be asked about. Fifty-one prices deserve that rule more
   * than one does, not less — so the ladder goes through the same admin session, the same reason
   * field and the same price-history table as a hand-created item.
   *
   * WHY ONE AUDIT ENTRY AND NOT FIFTY-ONE
   * -------------------------------------
   * Fifty-one entries would be identical but for the target id, and the thing worth proving is
   * that ONE operator set THIS whole ladder at THIS moment for THIS reason. That is one event, and
   * one hash-chained record of it carries every rung's fingerprint and value. The per-item
   * provenance the price-history table exists for is still written per item.
   *
   * REPLAYING IS SAFE
   * -----------------
   * Rows are keyed by a fingerprint derived from the value under our own namespace, so this can
   * only ever touch rungs it created — never an item a bot observed or an operator typed. A second
   * publish with nothing changed writes no price history and no audit entry at all, which is why
   * it needs no idempotency key: there is no second effect to suppress.
   */
  app.post('/v1/admin/catalog-ladder', { preHandler: guards.requireAdmin }, async (request) => {
    const body = parseWith(catalogLadderSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    return db.transaction(async (client) => {
      const existing = await client.query<{
        fingerprint: string;
        id: string;
        unit_value_minor: string;
      }>(
        `SELECT fingerprint, id, unit_value_minor FROM catalog_items
          WHERE fingerprint = ANY($1::char(64)[]) FOR UPDATE`,
        [UPGRADE_LADDER.map((rung) => rung.fingerprint)],
      );
      const byFingerprint = new Map(existing.rows.map((row) => [row.fingerprint, row]));

      let created = 0;
      let repriced = 0;
      let unchanged = 0;
      for (const rung of UPGRADE_LADDER) {
        const metadata = JSON.stringify(ladderMetadataFor(rung));
        const previous = byFingerprint.get(rung.fingerprint);
        const itemId = previous?.id ?? randomUUID();
        if (previous) {
          /* `price_updated_at` only moves when the price does. It is what the client shows as the
           * age of a quote, and a republish that changed nothing must not make every rung look
           * freshly repriced. */
          const changed = previous.unit_value_minor !== rung.unitValueMinor;
          await client.query(
            `UPDATE catalog_items SET
               minecraft_name = $2, display_name = $3, image_url = $4,
               unit_value_minor = $5, enabled = true, metadata = $6::jsonb,
               price_updated_at = CASE WHEN $7::boolean THEN now() ELSE price_updated_at END,
               updated_at = now()
             WHERE id = $1`,
            [
              itemId,
              rung.minecraftName,
              rung.displayName,
              rung.imageUrl,
              rung.unitValueMinor,
              metadata,
              changed,
            ],
          );
          if (changed) {
            await client.query(
              `INSERT INTO catalog_price_history
                 (id, catalog_item_id, old_unit_value_minor, new_unit_value_minor, actor_user_id,
                  reason)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                randomUUID(),
                itemId,
                previous.unit_value_minor,
                rung.unitValueMinor,
                actor,
                body.reason,
              ],
            );
            repriced += 1;
          } else {
            unchanged += 1;
          }
          continue;
        }
        await client.query(
          `INSERT INTO catalog_items
             (id, fingerprint, minecraft_name, display_name, image_url, unit_value_minor, enabled,
              metadata, price_updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb, now())`,
          [
            itemId,
            rung.fingerprint,
            rung.minecraftName,
            rung.displayName,
            rung.imageUrl,
            rung.unitValueMinor,
            metadata,
          ],
        );
        await client.query(
          `INSERT INTO catalog_price_history
             (id, catalog_item_id, old_unit_value_minor, new_unit_value_minor, actor_user_id,
              reason)
           VALUES ($1, $2, NULL, $3, $4, $5)`,
          [randomUUID(), itemId, rung.unitValueMinor, actor, body.reason],
        );
        created += 1;
      }

      const summary = {
        created,
        repriced,
        unchanged,
        total: UPGRADE_LADDER.length,
        floorMinor: LADDER_FLOOR_MINOR.toString(),
        ceilingMinor: LADDER_CEILING_MINOR.toString(),
      };
      /* Nothing moved, so nothing is recorded. An audit log that fills with "an operator looked at
       * this and it was already correct" is one nobody reads when something did change. */
      if (created || repriced) {
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'catalog.ladder_publish',
          targetType: 'catalog_ladder',
          targetId: LADDER_ID,
          details: {
            reason: body.reason,
            ...summary,
            rungs: UPGRADE_LADDER.map((rung) => ({
              fingerprint: rung.fingerprint,
              displayName: rung.displayName,
              unitValueMinor: rung.unitValueMinor,
            })),
          },
        });
      }
      return summary;
    });
  });

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
