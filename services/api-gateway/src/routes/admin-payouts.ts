import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { DEPOSIT_KINDS, GAME_KINDS, PROMO_KINDS, staffPredicate } from '../lib/admin-stats.js';
import {
  clearPayoutHold,
  holdAllQueued,
  holdQueuedForUser,
  holdQueuedWithdrawal,
  houseNetOutflowLastHour,
  setPayoutHold,
} from '../lib/anti-drain.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { safeText } from '../lib/sanitize.js';
import { parseWith } from '../lib/validation.js';

/**
 * The payout queue manager: everything an operator needs to see and stop money leaving.
 *
 * Reads are in one response so the console paints a consistent picture; every write is one
 * transaction with an audit row carrying the operator's reason. Holding never touches a wallet --
 * see lib/anti-drain.ts for what a hold is.
 */

const idSchema = z.object({ id: z.uuid() }).strict();
const reasonSchema = z.object({ reason: safeText(3, 256) }).strict();
const queueQuery = z
  .object({ window: z.enum(['24h', '7d', '30d', 'all']).default('24h') })
  .strict();

const OPEN_STATUSES = [
  'pending_approval',
  'queued',
  'awaiting_vault',
  'processing',
  'manual_review',
];
const RESULT_KINDS: readonly string[] = [...GAME_KINDS, ...Object.keys(PROMO_KINDS)];
const WINDOW_INTERVAL: Record<'24h' | '7d' | '30d' | 'all', string | null> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  all: null,
};

export async function registerAdminPayoutRoutes(
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
  const actorOf = (id: string | undefined): string => {
    if (!id) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    return id;
  };

  app.get(
    '/v1/admin/payout-queue',
    { preHandler: requireAdminRead, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const { window } = parseWith(queueQuery, request.query);
      const interval = WINDOW_INTERVAL[window];

      const [queue, totals, paid, bots, held, houseNet] = await Promise.all([
        db.query<{
          id: string;
          user_id: string;
          name: string;
          payee_username: string;
          amount_minor: string;
          status: string;
          funding: string;
          error_code: string | null;
          review_reason: string | null;
          created_at: Date;
          job_status: string | null;
          job_held: boolean | null;
          job_attempts: number | null;
          hold_reason: string | null;
        }>(
          `SELECT w.id, w.user_id, u.minecraft_username AS name, w.payee_username,
                  w.amount_minor::text AS amount_minor, w.status, w.funding, w.error_code,
                  w.review_reason, w.created_at,
                  j.status AS job_status, j.attempts AS job_attempts,
                  (j.available_at > now() + interval '10 years') AS job_held,
                  u.payout_hold_reason AS hold_reason
             FROM cash_withdrawals w
             JOIN users u ON u.id = w.user_id
             LEFT JOIN bot_jobs j ON j.kind = 'cash_payout' AND j.reference_id = w.id
            WHERE w.status = ANY($1::text[])
            ORDER BY w.created_at
            LIMIT 200`,
          [OPEN_STATUSES],
        ),
        db.query<{ status: string; n: number; amount: string }>(
          `SELECT status, count(*)::int AS n, COALESCE(SUM(amount_minor), 0)::text AS amount
             FROM cash_withdrawals WHERE status = ANY($1::text[]) GROUP BY status`,
          [OPEN_STATUSES],
        ),
        db.query<{ n: number; amount: string }>(
          `SELECT count(*)::int AS n, COALESCE(SUM(amount_minor), 0)::text AS amount
             FROM cash_withdrawals
            WHERE status = 'paid' AND paid_at >= now() - interval '24 hours'`,
        ),
        db.query<{
          id: string;
          username: string;
          role: string;
          status: string;
          balance: string;
          last_heartbeat_at: Date | null;
        }>(
          `SELECT id, username, role, status, tracked_balance_minor::text AS balance,
                  last_heartbeat_at
             FROM bot_accounts ORDER BY role, username`,
        ),
        db.query<{
          id: string;
          name: string;
          reason: string;
          at: Date;
          by_name: string | null;
        }>(
          `SELECT u.id, u.minecraft_username AS name, u.payout_hold_reason AS reason,
                  u.payout_hold_at AS at, a.minecraft_username AS by_name
             FROM users u LEFT JOIN users a ON a.id = u.payout_hold_by
            WHERE u.payout_hold_reason IS NOT NULL
            ORDER BY u.payout_hold_at DESC LIMIT 100`,
        ),
        houseNetOutflowLastHour(db),
      ]);

      /* Each queued player's risk card, in two queries for the whole page rather than per row. */
      const queued = [...new Set(queue.rows.map((row) => row.user_id))];
      const [risk, withdrawn] = queued.length
        ? await Promise.all([
            db.query<{
              id: string;
              balance: string;
              deposited: string;
              result_all: string;
              result_24h: string;
            }>(
              `SELECT u.id, COALESCE(w.balance_minor, 0)::text AS balance,
                      COALESCE(SUM(t.amount_minor) FILTER (WHERE t.kind = ANY($2::text[])), 0)::text AS deposited,
                      COALESCE(SUM(t.amount_minor) FILTER (WHERE t.kind = ANY($3::text[])), 0)::text AS result_all,
                      COALESCE(SUM(t.amount_minor) FILTER (WHERE t.kind = ANY($3::text[])
                        AND t.created_at >= now() - interval '24 hours'), 0)::text AS result_24h
                 FROM users u
                 LEFT JOIN user_wallets w ON w.user_id = u.id
                 LEFT JOIN wallet_transactions t ON t.user_id = u.id
                WHERE u.id = ANY($1::uuid[])
                GROUP BY u.id, w.balance_minor`,
              [queued, [...DEPOSIT_KINDS], RESULT_KINDS],
            ),
            db.query<{ user_id: string; withdrawn: string }>(
              `SELECT user_id, SUM(amount_minor)::text AS withdrawn
                 FROM cash_withdrawals
                WHERE user_id = ANY($1::uuid[]) AND status NOT IN ('failed', 'rejected')
                GROUP BY user_id`,
              [queued],
            ),
          ])
        : [{ rows: [] }, { rows: [] }];
      const riskOf = new Map(risk.rows.map((row) => [row.id, row]));
      const withdrawnOf = new Map(withdrawn.rows.map((row) => [row.user_id, row.withdrawn]));

      /* The leaders are the players who took the most from the games and promotions over the
       * window. Staff are excluded: an operator's test balance is not a winner. */
      const leaders = await db.query<{
        id: string;
        name: string;
        status: string;
        net: string;
        balance: string;
        hold_reason: string | null;
      }>(
        `SELECT u.id, u.minecraft_username AS name, u.status, SUM(t.amount_minor)::text AS net,
                COALESCE(w.balance_minor, 0)::text AS balance,
                u.payout_hold_reason AS hold_reason
           FROM wallet_transactions t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN user_wallets w ON w.user_id = u.id
          WHERE t.kind = ANY($1::text[])
            AND ($2::text IS NULL OR t.created_at >= now() - $2::interval)
            AND NOT ${staffPredicate('u')}
          GROUP BY u.id, u.minecraft_username, u.status, w.balance_minor, u.payout_hold_reason
         HAVING SUM(t.amount_minor) > 0
          ORDER BY SUM(t.amount_minor) DESC
          LIMIT 15`,
        [RESULT_KINDS, interval],
      );

      const recent = await db.query<{
        id: string;
        name: string;
        amount_minor: string;
        status: string;
        error_code: string | null;
        updated_at: Date;
      }>(
        `SELECT w.id, u.minecraft_username AS name, w.amount_minor::text AS amount_minor,
                w.status, w.error_code, w.updated_at
           FROM cash_withdrawals w JOIN users u ON u.id = w.user_id
          WHERE w.status IN ('paid', 'failed', 'rejected')
          ORDER BY w.updated_at DESC LIMIT 20`,
      );

      const byStatus = Object.fromEntries(
        totals.rows.map((row) => [row.status, { count: row.n, amountMinor: row.amount }]),
      );

      return {
        window,
        settings: {
          holdAll: config.cashPayoutsHold,
          approvalThresholdMinor: config.cashApprovalThresholdMinor.toString(),
          antiDrainEnabled: config.antiDrainEnabled,
          netCashoutMinor: config.antiDrainNetCashoutMinor.toString(),
          houseHourlyMinor: config.antiDrainHouseHourlyMinor.toString(),
          win1hMinor: config.antiDrainWin1hMinor.toString(),
          win24hMinor: config.antiDrainWin24hMinor.toString(),
          battlesEnabled: config.battlesEnabled,
        },
        totals: {
          byStatus,
          paid24h: { count: paid.rows[0]?.n ?? 0, amountMinor: paid.rows[0]?.amount ?? '0' },
          houseNetOutflowHourMinor: houseNet.toString(),
        },
        bots: bots.rows.map((bot) => ({
          id: bot.id,
          username: bot.username,
          role: bot.role,
          status: bot.status,
          trackedBalanceMinor: bot.balance,
          lastHeartbeatAt: bot.last_heartbeat_at,
        })),
        queue: queue.rows.map((row) => {
          const card = riskOf.get(row.user_id);
          return {
            id: row.id,
            userId: row.user_id,
            name: row.name,
            payee: row.payee_username,
            amountMinor: row.amount_minor,
            status: row.status,
            funding: row.funding,
            errorCode: row.error_code,
            reviewReason: row.review_reason,
            createdAt: row.created_at,
            job: row.job_status
              ? { status: row.job_status, held: row.job_held === true, attempts: row.job_attempts }
              : null,
            holdReason: row.hold_reason,
            player: {
              balanceMinor: card?.balance ?? '0',
              depositedMinor: card?.deposited ?? '0',
              withdrawnMinor: withdrawnOf.get(row.user_id) ?? '0',
              resultAllMinor: card?.result_all ?? '0',
              result24hMinor: card?.result_24h ?? '0',
            },
          };
        }),
        held: held.rows.map((row) => ({
          userId: row.id,
          name: row.name,
          reason: row.reason,
          at: row.at,
          by: row.by_name,
        })),
        leaders: leaders.rows.map((row) => ({
          userId: row.id,
          name: row.name,
          status: row.status,
          netMinor: row.net,
          balanceMinor: row.balance,
          holdReason: row.hold_reason,
        })),
        recent: recent.rows.map((row) => ({
          id: row.id,
          name: row.name,
          amountMinor: row.amount_minor,
          status: row.status,
          errorCode: row.error_code,
          at: row.updated_at,
        })),
      };
    },
  );

  /* Pull ONE queued payout back from the bot. Refused once the bot has claimed it: from that
   * moment the money may already be on its way, and the operator's tools for that case are the
   * manual-review ones. */
  app.post(
    '/v1/admin/cash-withdrawals/:id/hold',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(reasonSchema, request.body);
      const actor = actorOf(request.authUser?.id);
      return db.transaction(async (client) => {
        const result = await holdQueuedWithdrawal(
          client,
          params.id,
          `Operator hold: ${body.reason}`,
        );
        if (result === 'not_found')
          throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'No such payout');
        if (result === 'not_holdable') {
          conflict(
            'WITHDRAWAL_NOT_HOLDABLE',
            'That payout is not waiting for the bot any more. It has been claimed, is funded by the vault, or is already held.',
          );
        }
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'cash_withdrawal.hold',
          targetType: 'cash_withdrawal',
          targetId: params.id,
          details: { reason: body.reason },
        });
        return { withdrawal: { id: params.id, status: 'pending_approval' } };
      });
    },
  );

  /* The panic button: pull everything that has not reached the bot back into the queue. */
  app.post(
    '/v1/admin/cash-withdrawals/hold-queued',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const body = parseWith(reasonSchema, request.body);
      const actor = actorOf(request.authUser?.id);
      return db.transaction(async (client) => {
        const pulled = await holdAllQueued(client, `Operator hold: ${body.reason}`);
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'cash_withdrawal.hold_all_queued',
          targetType: 'cash_withdrawal',
          targetId: 'all',
          details: { reason: body.reason, held: pulled.held, skipped: pulled.skipped },
        });
        return pulled;
      });
    },
  );

  /* A hold on one player: their next withdrawal waits for a human, and anything they already
   * have waiting for the bot is pulled back. Their wallet and their play are untouched. */
  app.post(
    '/v1/admin/users/:id/payout-hold',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(reasonSchema, request.body);
      const actor = actorOf(request.authUser?.id);
      return db.transaction(async (client) => {
        const reason = `Operator: ${body.reason}`;
        if (!(await setPayoutHold(client, params.id, reason, actor))) {
          throw new AppError(404, 'USER_NOT_FOUND', 'No such player');
        }
        const pulled = await holdQueuedForUser(client, params.id, reason);
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'user.payout_hold',
          targetType: 'user',
          targetId: params.id,
          details: { reason: body.reason, pulledBack: pulled.held },
        });
        return { userId: params.id, held: true, pulledBack: pulled.held };
      });
    },
  );

  app.post(
    '/v1/admin/users/:id/payout-release',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const body = parseWith(reasonSchema, request.body);
      const actor = actorOf(request.authUser?.id);
      return db.transaction(async (client) => {
        const released = await clearPayoutHold(client, params.id);
        if (!released) {
          conflict('NO_PAYOUT_HOLD', 'That player has no payout hold');
        }
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'user.payout_release',
          targetType: 'user',
          targetId: params.id,
          details: { reason: body.reason },
        });
        return { userId: params.id, held: false };
      });
    },
  );
}
