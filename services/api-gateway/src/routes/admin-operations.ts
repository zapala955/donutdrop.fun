import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { isValidCurve, settleRace } from '../lib/rewards.js';
import { safeText } from '../lib/sanitize.js';
import { parseWith } from '../lib/validation.js';
import { refundWithdrawal } from './cash-withdrawals.js';

const idSchema = z.object({ id: z.uuid() }).strict();
const reasonSchema = z.object({ reason: safeText(3, 256) }).strict();
const pageSchema = z
  .object({
    search: safeText(1, 80).optional(),
    status: safeText(1, 32).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
const auditQuerySchema = pageSchema.extend({
  action: safeText(1, 80).optional(),
  targetType: safeText(1, 40).optional(),
});
const cashResolutionSchema = z
  .object({ outcome: z.enum(['paid', 'refund']), reason: safeText(3, 256) })
  .strict();
const payoutResolutionSchema = z
  .object({ outcome: z.enum(['paid', 'not_paid']), reason: safeText(3, 256) })
  .strict();
const creatorDecisionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    revshareBps: z.number().int().min(0).max(10_000).optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{3,16}$/)
      .optional(),
    note: safeText(3, 512),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === 'approved' && value.revshareBps === undefined) {
      context.addIssue({ code: 'custom', path: ['revshareBps'], message: 'Required on approval' });
    }
  });

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const positiveAmountPattern = /^[1-9]\d{0,18}$/;
const positiveAmount = z
  .string()
  .regex(positiveAmountPattern)
  .refine(
    (value) => !positiveAmountPattern.test(value) || BigInt(value) <= POSTGRES_BIGINT_MAX,
    'Value exceeds database range',
  );
const raceFields = {
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  name: safeText(1, 96),
  cadence: z.enum(['daily', 'weekly']),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  prizePoolMinor: positiveAmount,
  payoutCurveBps: z.array(z.number().int().min(0).max(10_000)).min(1).max(100),
};
const raceCreateSchema = z
  .object({ ...raceFields, reason: safeText(3, 256) })
  .strict()
  .superRefine(validateRace);
const raceUpdateSchema = z
  .object({
    slug: raceFields.slug.optional(),
    name: raceFields.name.optional(),
    cadence: raceFields.cadence.optional(),
    startsAt: raceFields.startsAt.optional(),
    endsAt: raceFields.endsAt.optional(),
    prizePoolMinor: raceFields.prizePoolMinor.optional(),
    payoutCurveBps: raceFields.payoutCurveBps.optional(),
    reason: safeText(3, 256),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'))
  .superRefine(validateRace);

const questCodeSchema = z.object({ code: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/) }).strict();
const questFields = {
  name: safeText(1, 96),
  description: safeText(1, 256),
  metric: z.enum([
    'upgrader_rolls',
    'upgrader_wins',
    'cases_opened',
    'wagered_minor',
    'piggy_deposits',
    'faction_contribution_minor',
  ]),
  targetValue: positiveAmount,
  rewardMinor: positiveAmount,
  sortOrder: z.number().int().min(-10_000).max(10_000),
  enabled: z.boolean(),
};
const questCreateSchema = z
  .object({ code: questCodeSchema.shape.code, ...questFields, reason: safeText(3, 256) })
  .strict();
const questUpdateSchema = z
  .object({
    name: questFields.name.optional(),
    description: questFields.description.optional(),
    metric: questFields.metric.optional(),
    targetValue: questFields.targetValue.optional(),
    rewardMinor: questFields.rewardMinor.optional(),
    sortOrder: questFields.sortOrder.optional(),
    enabled: questFields.enabled.optional(),
    reason: safeText(3, 256),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'reason'));

interface EntityRow {
  [column: string]: unknown;
}

/**
 * Operational admin surfaces that span more than one product route.
 *
 * This module deliberately does not expose arbitrary SQL or secret/config writes. The console
 * session is protected by those settings, so letting that same session rewrite them would turn
 * one compromised cookie into permanent infrastructure access. Runtime operations are available
 * here; trust roots remain deployment changes followed by a restart.
 */
export async function registerAdminOperationRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const requireAdminRead = async (request: Parameters<typeof guards.authenticate>[0]) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };

  app.get('/v1/admin/overview', { preHandler: requireAdminRead }, async () => {
    const result = await db.query<EntityRow>(
      `SELECT
         (SELECT count(*) FROM users WHERE minecraft_identity <> 'system:catalog-seed')::text
           AS users_total,
         (SELECT count(*) FROM users WHERE status = 'active')::text AS users_active,
         (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > now())::text
           AS sessions_live,
         (SELECT coalesce(sum(balance_minor), 0) FROM user_wallets)::text AS wallet_total_minor,
         (SELECT coalesce(sum(amount_minor), 0) FROM wager_events
           WHERE created_at >= date_trunc('day', now()))::text AS wagered_today_minor,
         (SELECT count(*) FROM bot_accounts WHERE status = 'quarantined')::text
           AS bots_quarantined,
         (SELECT count(*) FROM bot_jobs WHERE status = 'dead_letter')::text
           AS jobs_dead_letter,
         (SELECT count(*) FROM cash_withdrawals
           WHERE status IN ('pending_approval', 'manual_review'))::text AS withdrawals_attention,
         (SELECT count(*) FROM creator_applications WHERE status = 'pending')::text
           AS creator_applications_pending,
         (SELECT count(*) FROM chat_timeouts
           WHERE lifted_at IS NULL AND expires_at > now())::text AS chat_timeouts_active,
         (SELECT count(*) FROM cases WHERE enabled)::text AS cases_enabled,
         (SELECT count(*) FROM catalog_items WHERE enabled)::text AS catalog_items_enabled,
         (SELECT count(*) FROM roulette_bets b JOIN roulette_rounds r ON r.id = b.round_id
           WHERE r.status = 'open')::text AS roulette_open_bets,
         (SELECT coalesce(sum(b.stake_minor), 0) FROM roulette_bets b
           WHERE b.created_at >= date_trunc('day', now()))::text AS roulette_wagered_today_minor`,
    );
    return { metrics: result.rows[0] ?? {} };
  });

  app.get('/v1/admin/economy', { preHandler: requireAdminRead }, async (request) => {
    const query = parseWith(pageSchema, request.query);
    const [totals, transactions, deposits] = await Promise.all([
      db.query<EntityRow>(
        `SELECT
           (SELECT coalesce(sum(balance_minor), 0) FROM user_wallets)::text AS wallet_total_minor,
           (SELECT coalesce(sum(amount_minor), 0) FROM wallet_transactions
             WHERE amount_minor > 0)::text AS ledger_credits_minor,
           (SELECT coalesce(-sum(amount_minor), 0) FROM wallet_transactions
             WHERE amount_minor < 0)::text AS ledger_debits_minor,
           (SELECT coalesce(sum(amount_minor), 0) FROM cash_payment_receipts)::text
             AS cash_received_minor,
           (SELECT coalesce(sum(amount_minor), 0) FROM cash_withdrawals
             WHERE status = 'paid')::text AS cash_paid_minor`,
      ),
      db.query<EntityRow>(
        `SELECT t.id, t.seq, t.user_id, u.minecraft_username, t.amount_minor,
                t.balance_after_minor, t.kind, t.reference_id, t.created_at
           FROM wallet_transactions t JOIN users u ON u.id = t.user_id
          WHERE ($1::text IS NULL OR u.minecraft_username ILIKE '%' || $1 || '%'
                 OR t.kind ILIKE '%' || $1 || '%')
          ORDER BY t.seq DESC LIMIT $2 OFFSET $3`,
        [query.search ?? null, query.limit, query.offset],
      ),
      db.query<EntityRow>(
        `SELECT r.event_id AS id, r.payer_username, r.displayed_amount, r.amount_minor,
                r.status, r.created_at, r.user_id, u.minecraft_username
           FROM cash_payment_receipts r
           LEFT JOIN users u ON u.id = r.user_id
          ORDER BY r.created_at DESC LIMIT 100`,
      ),
    ]);
    return {
      totals: totals.rows[0] ?? {},
      transactions: transactions.rows,
      deposits: deposits.rows,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.get('/v1/admin/catalog-items', { preHandler: requireAdminRead }, async () => {
    const result = await db.query<EntityRow>(
      `SELECT c.id, c.fingerprint, c.minecraft_name, c.display_name, c.image_url,
              c.unit_value_minor, c.enabled, c.metadata, c.price_updated_at, c.created_at,
              coalesce(sum(l.quantity) FILTER (WHERE l.state = 'available'), 0)::text
                AS available_quantity,
              coalesce(sum(l.quantity) FILTER (WHERE l.state = 'withdrawal_pending'), 0)::text
                AS pending_quantity,
              count(DISTINCT l.bot_id)::integer AS stocked_bots
         FROM catalog_items c LEFT JOIN inventory_lots l ON l.catalog_item_id = c.id
        GROUP BY c.id ORDER BY c.enabled DESC, c.unit_value_minor, c.display_name`,
    );
    return { items: result.rows };
  });

  app.get('/v1/admin/inventory', { preHandler: requireAdminRead }, async (request) => {
    const query = parseWith(pageSchema, request.query);
    const result = await db.query<EntityRow>(
      `SELECT l.id, l.catalog_item_id, c.display_name, l.owner_user_id,
              u.minecraft_username AS owner_username, l.bot_id, b.username AS bot_username,
              l.quantity, l.state, l.source_type, l.source_ref, l.created_at, l.updated_at
         FROM inventory_lots l
         JOIN catalog_items c ON c.id = l.catalog_item_id
         JOIN bot_accounts b ON b.id = l.bot_id
         LEFT JOIN users u ON u.id = l.owner_user_id
        WHERE ($1::text IS NULL OR c.display_name ILIKE '%' || $1 || '%'
               OR u.minecraft_username ILIKE '%' || $1 || '%' OR b.username ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR l.state = $2)
        ORDER BY l.updated_at DESC LIMIT $3 OFFSET $4`,
      [query.search ?? null, query.status ?? null, query.limit, query.offset],
    );
    return { lots: result.rows, limit: query.limit, offset: query.offset };
  });

  app.post(
    '/v1/admin/cash-withdrawals/:id/resolve',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(cashResolutionSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      return db.transaction(async (client) => {
        const locked = await client.query<{ amount_minor: string; status: string }>(
          `SELECT amount_minor, status FROM cash_withdrawals WHERE id = $1 FOR UPDATE`,
          [params.id],
        );
        const withdrawal = locked.rows[0];
        if (!withdrawal)
          throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal was not found');
        if (withdrawal.status !== 'manual_review') {
          conflict('WITHDRAWAL_NOT_IN_REVIEW', 'Only a payout under manual review can be resolved');
        }
        if (body.outcome === 'paid') {
          await client.query(
            `UPDATE cash_withdrawals SET status = 'paid', paid_at = now(), error_code = NULL,
                    approved_by = coalesce(approved_by, $2),
                    approved_at = coalesce(approved_at, now()), updated_at = now()
              WHERE id = $1`,
            [params.id, actor],
          );
        } else {
          await refundWithdrawal(client, params.id, 'ADMIN_CONFIRMED_NOT_PAID');
        }
        await client.query(
          `UPDATE bot_jobs SET status = 'completed', lease_token_hash = NULL,
                  lease_expires_at = NULL, updated_at = now()
            WHERE kind = 'cash_payout' AND reference_id = $1 AND status = 'dead_letter'`,
          [params.id],
        );
        await appendAudit(client, config, {
          actorUserId: actor,
          action: `cash_withdrawal.resolve.${body.outcome}`,
          targetType: 'cash_withdrawal',
          targetId: params.id,
          details: { reason: body.reason, amountMinor: withdrawal.amount_minor },
        });
        return {
          withdrawal: { id: params.id, status: body.outcome === 'paid' ? 'paid' : 'failed' },
        };
      });
    },
  );

  app.post(
    '/v1/admin/payouts/:id/resolve',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(payoutResolutionSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      return db.transaction(async (client) => {
        const updated = await client.query<{ amount_minor: string }>(
          `UPDATE admin_payouts
              SET status = $2, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE NULL END,
                  error_code = CASE WHEN $2 = 'paid' THEN NULL ELSE 'ADMIN_CONFIRMED_NOT_PAID' END,
                  updated_at = now()
            WHERE id = $1 AND status IN ('manual_review', 'failed')
            RETURNING amount_minor`,
          [params.id, body.outcome === 'paid' ? 'paid' : 'failed'],
        );
        const payout = updated.rows[0];
        if (!payout) conflict('PAYOUT_NOT_IN_REVIEW', 'That payout cannot be manually resolved');
        await client.query(
          `UPDATE bot_jobs SET status = 'completed', lease_token_hash = NULL,
                  lease_expires_at = NULL, updated_at = now()
            WHERE kind = 'admin_payout' AND reference_id = $1 AND status = 'dead_letter'`,
          [params.id],
        );
        await appendAudit(client, config, {
          actorUserId: actor,
          action: `admin_payout.resolve.${body.outcome}`,
          targetType: 'admin_payout',
          targetId: params.id,
          details: { reason: body.reason, amountMinor: payout.amount_minor },
        });
        return { payout: { id: params.id, status: body.outcome === 'paid' ? 'paid' : 'failed' } };
      });
    },
  );

  app.post('/v1/admin/jobs/:id/retry', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(idSchema, request.params);
    const body = parseWith(reasonSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    return db.transaction(async (client) => {
      /* Payment and item-transfer jobs may have taken effect before their acknowledgement was
       * lost. Blind retry can duplicate a payment or delivery, so only idempotent control work is
       * eligible here. Value-bearing dead letters have explicit human-resolution endpoints. */
      const retried = await client.query<{ kind: string }>(
        `UPDATE bot_jobs SET status = 'queued', attempts = 0, available_at = now(),
                lease_token_hash = NULL, lease_expires_at = NULL, last_error_code = NULL,
                updated_at = now()
          WHERE id = $1 AND status = 'dead_letter' AND kind IN ('inventory_resync', 'reconnect')
          RETURNING kind`,
        [params.id],
      );
      const job = retried.rows[0];
      if (!job)
        conflict('JOB_NOT_RETRYABLE', 'Only dead-lettered control jobs can be safely retried');
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'bot_job.retry',
        targetType: 'bot_job',
        targetId: params.id,
        details: { reason: body.reason, kind: job.kind },
      });
      return { job: { id: params.id, status: 'queued' } };
    });
  });

  app.get('/v1/admin/moderation', { preHandler: requireAdminRead }, async () => {
    const [messages, timeouts] = await Promise.all([
      db.query<EntityRow>(
        `SELECT m.id, m.user_id, u.minecraft_username, m.body, m.created_at,
                m.deleted_at, d.minecraft_username AS deleted_by_username
           FROM chat_messages m JOIN users u ON u.id = m.user_id
           LEFT JOIN users d ON d.id = m.deleted_by
          ORDER BY m.created_at DESC LIMIT 200`,
      ),
      db.query<EntityRow>(
        `SELECT t.id, t.user_id, u.minecraft_username, t.reason, t.expires_at, t.created_at,
                t.lifted_at, a.minecraft_username AS issued_by_username
           FROM chat_timeouts t JOIN users u ON u.id = t.user_id
           JOIN users a ON a.id = t.issued_by
          ORDER BY t.created_at DESC LIMIT 200`,
      ),
    ]);
    return { messages: messages.rows, timeouts: timeouts.rows };
  });

  app.get('/v1/admin/creator-applications', { preHandler: requireAdminRead }, async () => {
    const result = await db.query<EntityRow>(
      `SELECT a.id, a.user_id, u.minecraft_username, a.platform, a.channel_url,
              a.audience_size, a.requested_code, a.status, a.granted_revshare_bps,
              a.review_note, a.created_at, a.reviewed_at,
              r.minecraft_username AS reviewer_username
         FROM creator_applications a JOIN users u ON u.id = a.user_id
         LEFT JOIN users r ON r.id = a.reviewer_id
        ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT 500`,
    );
    return { applications: result.rows, maxRevshareBps: config.creatorMaxRevshareBps };
  });

  app.post(
    '/v1/admin/creator-applications/:id/decision',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(creatorDecisionSchema, request.body);
      const actor = requireActor(request.authUser?.id);
      if (body.decision === 'approved' && (body.revshareBps ?? 0) > config.creatorMaxRevshareBps) {
        throw new AppError(
          400,
          'CREATOR_REVSHARE_TOO_HIGH',
          `Revshare cannot exceed ${config.creatorMaxRevshareBps} bps`,
        );
      }
      return db.transaction(async (client) => {
        const current = await client.query<{ user_id: string; requested_code: string }>(
          `SELECT user_id, requested_code FROM creator_applications
            WHERE id = $1 AND status = 'pending' FOR UPDATE`,
          [params.id],
        );
        const application = current.rows[0];
        if (!application)
          conflict('APPLICATION_NOT_PENDING', 'That application is no longer pending');
        const code = body.code ?? application.requested_code;
        if (body.decision === 'approved') {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `referral-code:${code}`,
          ]);
          const owner = await client.query<{ user_id: string }>(
            'SELECT user_id FROM referral_codes WHERE code = $1',
            [code],
          );
          if (owner.rows[0] && owner.rows[0].user_id !== application.user_id) {
            conflict('REFERRAL_CODE_TAKEN', 'That creator code is already in use');
          }
          await client.query(
            `INSERT INTO referral_codes(user_id, code) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code`,
            [application.user_id, code],
          );
        }
        await client.query(
          `UPDATE creator_applications
              SET status = $2, granted_revshare_bps = $3, reviewer_id = $4,
                  reviewed_at = now(), review_note = $5, updated_at = now()
            WHERE id = $1`,
          [
            params.id,
            body.decision,
            body.decision === 'approved' ? body.revshareBps : null,
            actor,
            body.note,
          ],
        );
        await appendAudit(client, config, {
          actorUserId: actor,
          action: `creator_application.${body.decision}`,
          targetType: 'creator_application',
          targetId: params.id,
          details: {
            reason: body.note,
            code: body.decision === 'approved' ? code : null,
            revshareBps: body.decision === 'approved' ? body.revshareBps : null,
          },
        });
        return { application: { id: params.id, status: body.decision } };
      });
    },
  );

  app.get('/v1/admin/races', { preHandler: requireAdminRead }, async () => {
    const result = await db.query<EntityRow>(
      `SELECT r.id, r.slug, r.name, r.cadence, r.starts_at, r.ends_at,
              r.prize_pool_minor, r.payout_curve, r.settled_at, r.created_at,
              count(e.user_id)::integer AS entrants,
              coalesce(sum(e.wagered_minor), 0)::text AS wagered_minor
         FROM wager_races r LEFT JOIN wager_race_entries e ON e.race_id = r.id
        GROUP BY r.id ORDER BY r.starts_at DESC LIMIT 200`,
    );
    return { races: result.rows };
  });

  app.post('/v1/admin/races', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseWith(raceCreateSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    const id = randomUUID();
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO wager_races
           (id, slug, name, cadence, starts_at, ends_at, prize_pool_minor, payout_curve)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          id,
          body.slug,
          body.name,
          body.cadence,
          body.startsAt,
          body.endsAt,
          body.prizePoolMinor,
          JSON.stringify(body.payoutCurveBps),
        ],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'race.create',
        targetType: 'wager_race',
        targetId: id,
        details: body,
      });
    });
    return reply.code(201).send({ race: { id } });
  });

  app.patch('/v1/admin/races/:id', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(idSchema, request.params);
    const body = parseWith(raceUpdateSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    return db.transaction(async (client) => {
      const updated = await client.query<EntityRow>(
        `UPDATE wager_races SET
           slug = coalesce($2, slug), name = coalesce($3, name),
           cadence = coalesce($4, cadence), starts_at = coalesce($5::timestamptz, starts_at),
           ends_at = coalesce($6::timestamptz, ends_at),
           prize_pool_minor = coalesce($7::bigint, prize_pool_minor),
           payout_curve = coalesce($8::jsonb, payout_curve)
         WHERE id = $1 AND settled_at IS NULL AND starts_at > now()
         RETURNING id, slug, name, cadence, starts_at, ends_at, prize_pool_minor, payout_curve`,
        [
          params.id,
          body.slug ?? null,
          body.name ?? null,
          body.cadence ?? null,
          body.startsAt ?? null,
          body.endsAt ?? null,
          body.prizePoolMinor ?? null,
          body.payoutCurveBps === undefined ? null : JSON.stringify(body.payoutCurveBps),
        ],
      );
      if (!updated.rows[0]) {
        conflict('RACE_LOCKED', 'A race can only be edited before it starts');
      }
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'race.update',
        targetType: 'wager_race',
        targetId: params.id,
        details: body,
      });
      return { race: updated.rows[0] };
    });
  });

  app.post('/v1/admin/races/settle', { preHandler: guards.requireAdmin }, async (request) => {
    const body = parseWith(reasonSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    const due = await db.query<{ id: string }>(
      `SELECT id FROM wager_races WHERE settled_at IS NULL AND ends_at <= now()
        ORDER BY ends_at LIMIT 50`,
    );
    let paid = 0;
    for (const race of due.rows) {
      paid += await db.transaction(async (client) => {
        const racePaid = await settleRace(client, config, race.id);
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'race.settle',
          targetType: 'wager_race',
          targetId: race.id,
          details: { reason: body.reason, paid: racePaid },
        });
        return racePaid;
      });
    }
    return { settled: due.rows.length, paid };
  });

  app.get('/v1/admin/quests', { preHandler: requireAdminRead }, async () => {
    const result = await db.query<EntityRow>(
      `SELECT q.code, q.name, q.description, q.metric, q.target_value, q.reward_minor,
              q.sort_order, q.enabled, q.created_at, q.updated_at,
              count(p.user_id) FILTER (WHERE p.quest_day = current_date)::integer AS players_today,
              count(p.user_id) FILTER (
                WHERE p.quest_day = current_date AND p.claimed_at IS NOT NULL)::integer AS claims_today
         FROM quest_definitions q LEFT JOIN quest_progress p ON p.quest_code = q.code
        GROUP BY q.code ORDER BY q.sort_order, q.code`,
    );
    return { quests: result.rows };
  });

  app.post('/v1/admin/quests', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseWith(questCreateSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO quest_definitions
           (code, name, description, metric, target_value, reward_minor, sort_order, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          body.code,
          body.name,
          body.description,
          body.metric,
          body.targetValue,
          body.rewardMinor,
          body.sortOrder,
          body.enabled,
        ],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'quest.create',
        targetType: 'quest_definition',
        targetId: body.code,
        details: body,
      });
    });
    return reply.code(201).send({ quest: { code: body.code } });
  });

  app.patch('/v1/admin/quests/:code', { preHandler: guards.requireAdmin }, async (request) => {
    const params = parseWith(questCodeSchema, request.params);
    const body = parseWith(questUpdateSchema, request.body);
    const actor = requireActor(request.authUser?.id);
    return db.transaction(async (client) => {
      const updated = await client.query<EntityRow>(
        `UPDATE quest_definitions SET
           name = coalesce($2, name), description = coalesce($3, description),
           metric = coalesce($4, metric), target_value = coalesce($5::bigint, target_value),
           reward_minor = coalesce($6::bigint, reward_minor),
           sort_order = coalesce($7::integer, sort_order),
           enabled = coalesce($8::boolean, enabled), updated_at = now()
         WHERE code = $1 RETURNING *`,
        [
          params.code,
          body.name ?? null,
          body.description ?? null,
          body.metric ?? null,
          body.targetValue ?? null,
          body.rewardMinor ?? null,
          body.sortOrder ?? null,
          body.enabled ?? null,
        ],
      );
      if (!updated.rows[0]) throw new AppError(404, 'QUEST_NOT_FOUND', 'Quest was not found');
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'quest.update',
        targetType: 'quest_definition',
        targetId: params.code,
        details: body,
      });
      return { quest: updated.rows[0] };
    });
  });

  app.get('/v1/admin/audit', { preHandler: requireAdminRead }, async (request) => {
    const query = parseWith(auditQuerySchema, request.query);
    const result = await db.query<EntityRow>(
      `SELECT a.id, a.actor_user_id, u.minecraft_username AS actor_username, a.action,
              a.target_type, a.target_id, a.details, a.previous_hash, a.entry_hash, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::text IS NULL OR a.action ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR a.target_type = $2)
          AND ($3::text IS NULL OR a.target_id ILIKE '%' || $3 || '%'
               OR u.minecraft_username ILIKE '%' || $3 || '%')
        ORDER BY a.created_at DESC, a.id DESC LIMIT $4 OFFSET $5`,
      [
        query.action ?? null,
        query.targetType ?? null,
        query.search ?? null,
        query.limit,
        query.offset,
      ],
    );
    return { entries: result.rows, limit: query.limit, offset: query.offset };
  });

  app.get('/v1/admin/system-config', { preHandler: requireAdminRead }, async () => ({
    restartRequired: true,
    note: 'Security and economic trust roots are managed in the VPS environment and require a controlled restart.',
    config: {
      environment: config.environment,
      appOrigin: config.appOrigin,
      sessionTtlHours: config.sessionTtlHours,
      houseEdgeBps: config.houseEdgeBps,
      itemSellRateBps: config.itemSellRateBps,
      minMultiplierBps: config.minMultiplierBps,
      maxMultiplierBps: config.maxMultiplierBps,
      maxWinChancePpm: config.maxWinChancePpm,
      upgradeMaxStakeMinor: config.upgradeMaxStakeMinor.toString(),
      rouletteEnabled: config.rouletteEnabled,
      rouletteRoundSeconds: config.rouletteRoundSeconds,
      rouletteSpinSeconds: config.rouletteSpinSeconds,
      rouletteMinStakeMinor: config.rouletteMinStakeMinor.toString(),
      rouletteMaxStakeMinor: config.rouletteMaxStakeMinor.toString(),
      houseStockUnlimited: config.houseStockUnlimited,
      cashOnlyPlay: config.cashOnlyPlay,
      minecraftTransfersEnabled: config.minecraftTransfersEnabled,
      physicalCustodyEnabled: config.physicalCustodyEnabled,
      chatEnabled: config.chatEnabled,
      chatSlowModeSeconds: config.chatSlowModeSeconds,
      vipEnabled: config.vipEnabled,
      rakebackEnabled: config.rakebackEnabled,
      skillDuelEnabled: config.skillDuelEnabled,
      vaultJackpotEnabled: config.vaultJackpotEnabled,
      lavaRainEnabled: config.lavaRainEnabled,
      tipsEnabled: config.tipsEnabled,
      sideBetsEnabled: config.sideBetsEnabled,
      racesEnabled: config.racesEnabled,
      creatorProgrammeEnabled: config.creatorProgrammeEnabled,
      referralsEnabled: config.referralsEnabled,
      discordControlEnabled: config.discordControlEnabled,
      turnstileEnabled: config.turnstileEnabled,
      adminCount: config.adminMinecraftIds.size,
      provisionedBotCount: config.botCredentials.size,
    },
  }));
}

function validateRace(
  value: {
    startsAt?: string | undefined;
    endsAt?: string | undefined;
    payoutCurveBps?: number[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    context.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must be after startsAt' });
  }
  if (value.payoutCurveBps && !isValidCurve(value.payoutCurveBps)) {
    context.addIssue({
      code: 'custom',
      path: ['payoutCurveBps'],
      message: 'Must total at most 10000 bps',
    });
  }
}

function requireActor(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
