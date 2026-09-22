import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { csrfCookieName, sessionCookieName, sessionCookieOptions } from '../lib/auth.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import {
  consumeConfirmation,
  issueConfirmation,
  logCommand,
  mintAdminLink,
  redeemAdminLink,
  resolveOperator,
  spendCommandBudget,
  verifyDiscordControlSignature,
  type DiscordOperator,
} from '../lib/discord-control.js';
import { parseWith } from '../lib/validation.js';
import { safeText } from '../lib/sanitize.js';

/**
 * discord-control.ts — the routes the Discord bot is allowed to call, and the one route a browser
 * calls to turn a minted link into a session.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY ONE DISPATCH ENDPOINT RATHER THAN NINE ROUTES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every command shares the same preamble: verify the bot's signature, resolve the Discord user to
 * an administrator, spend a rate-limit unit, run it, log the outcome whichever way it went. Spread
 * across nine handlers that preamble is nine chances to leave one of the five steps out, and the
 * one that gets left out is the logging on the failure path — precisely the entry an incident
 * review needs. Written once, a new command cannot be added without it.
 *
 * The command union is still parsed strictly per command, so the dispatcher buys uniform
 * enforcement without giving up per-command validation.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE LINK IS REDEEMED BY POST, AND WHY THE TOKEN IS IN THE FRAGMENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A one-time token in a URL path that Discord can see is a one-time token Discord spends. The
 * moment a link is posted, Discord's unfurler fetches it to build a preview — so a GET endpoint
 * that redeems on sight would be consumed by a crawler before the operator ever clicked, and the
 * operator would be told their brand-new link was already used.
 *
 * The token therefore lives in the URL FRAGMENT, which is never transmitted in an HTTP request at
 * all. The crawler fetches `/admin/` and gets an ordinary page. The operator's browser reads the
 * fragment locally and POSTs it here. A prefetcher cannot spend a credential it is structurally
 * incapable of seeing.
 */

const OPERATOR_CONTEXT = z
  .object({
    discordUserId: z.string().regex(/^[0-9]{5,32}$/),
    discordGuildId: z
      .string()
      .regex(/^[0-9]{5,32}$/)
      .nullish(),
    discordChannelId: z
      .string()
      .regex(/^[0-9]{5,32}$/)
      .nullish(),
  })
  .strict();

const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('stats') }).strict(),
  z.object({ command: z.literal('bots') }).strict(),
  z.object({ command: z.literal('jobs') }).strict(),
  z.object({ command: z.literal('dashboard') }).strict(),
  z.object({ command: z.literal('user'), query: safeText(1, 32) }).strict(),
  z
    .object({
      command: z.literal('quarantine-bot'),
      botId: z.uuid(),
      quarantined: z.boolean(),
      reason: safeText(3, 256),
    })
    .strict(),
  z
    .object({
      command: z.literal('suspend-user'),
      userId: z.uuid(),
      suspended: z.boolean(),
      reason: safeText(3, 256),
    })
    .strict(),
  z.object({ command: z.literal('confirm'), nonce: z.string().min(16).max(256) }).strict(),
]);

const envelopeSchema = z
  .object({ context: OPERATOR_CONTEXT, request: commandSchema })
  .strict();

const redeemSchema = z.object({ token: z.string().min(16).max(256) }).strict();

/** What a command hands back to the bot. `confirm` means "nothing happened yet, ask again". */
type CommandResult =
  | { readonly kind: 'data'; readonly title: string; readonly fields: Record<string, unknown> }
  | { readonly kind: 'rows'; readonly title: string; readonly rows: Record<string, unknown>[] }
  | { readonly kind: 'link'; readonly url: string; readonly expiresAt: string }
  | { readonly kind: 'confirm'; readonly nonce: string; readonly summary: string }
  | { readonly kind: 'done'; readonly summary: string };

export async function registerDiscordControlRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  /* Registering nothing at all when the control plane is off is stronger than registering routes
   * that check a flag: a route that does not exist cannot be reached by a bug in the check. */
  if (!config.discordControlEnabled) return;

  // ── read commands ─────────────────────────────────────────────────────────

  async function platformStats(): Promise<CommandResult> {
    const result = await db.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM users)::text AS users_total,
         (SELECT count(*) FROM users WHERE status = 'active')::text AS users_active,
         (SELECT count(*) FROM users WHERE created_at > now() - interval '24 hours')::text
           AS users_new_24h,
         (SELECT count(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > now())::text
           AS sessions_live,
         (SELECT COALESCE(sum(balance_minor), 0) FROM user_wallets)::text AS wallet_total_minor,
         (SELECT count(*) FROM bot_accounts WHERE status = 'quarantined')::text AS bots_quarantined,
         (SELECT count(*) FROM bot_jobs WHERE status = 'dead_letter')::text AS jobs_dead_letter,
         (SELECT count(*) FROM bot_jobs WHERE status IN ('queued', 'leased'))::text AS jobs_open`,
    );
    return { kind: 'data', title: 'Platform', fields: result.rows[0] ?? {} };
  }

  async function lookupUser(query: string): Promise<CommandResult> {
    /* Username prefix search. `normalized_username` is the indexed, case-folded column the rest of
     * the platform matches on, so this agrees with every other lookup rather than inventing a
     * second notion of "the same player". */
    const result = await db.query<Record<string, unknown>>(
      `SELECT u.id, u.minecraft_username, u.role, u.status,
              u.created_at, u.last_login_at,
              COALESCE(w.balance_minor, 0)::text AS balance_minor
         FROM users u
         LEFT JOIN user_wallets w ON w.user_id = u.id
        WHERE u.normalized_username LIKE $1
        ORDER BY u.normalized_username
        LIMIT 10`,
      [`${query.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`],
    );
    if (!result.rows.length) throw new AppError(404, 'USER_NOT_FOUND', 'No player matched');
    return { kind: 'rows', title: `Players matching “${query}”`, rows: result.rows };
  }

  async function botHealth(): Promise<CommandResult> {
    const result = await db.query<Record<string, unknown>>(
      `SELECT b.id, b.username, b.status, b.reconciliation_status, b.transfer_capable,
              b.last_heartbeat_at,
              (SELECT count(*)::integer FROM bot_jobs j
                WHERE j.bot_id = b.id AND j.status IN ('queued', 'leased', 'dead_letter'))
                AS open_jobs
         FROM bot_accounts b ORDER BY b.username LIMIT 25`,
    );
    return { kind: 'rows', title: 'Bots', rows: result.rows };
  }

  async function jobQueue(): Promise<CommandResult> {
    const result = await db.query<Record<string, unknown>>(
      `SELECT status, count(*)::integer AS count,
              max(updated_at) AS latest
         FROM bot_jobs GROUP BY status ORDER BY status`,
    );
    return { kind: 'rows', title: 'Job queue', rows: result.rows };
  }

  // ── the dashboard link ────────────────────────────────────────────────────

  async function dashboardLink(
    operator: DiscordOperator,
    guildId: string | null,
  ): Promise<CommandResult> {
    const minted = await mintAdminLink(db, config, operator, { guildId });
    /* The fragment is the point. See this file's header: anything before the `#` is visible to
     * Discord's unfurler and would be spent before the operator clicked. */
    return {
      kind: 'link',
      url: `${config.appOrigin}/admin/#${minted.token}`,
      expiresAt: minted.expiresAt.toISOString(),
    };
  }

  // ── destructive commands ──────────────────────────────────────────────────

  async function executeQuarantineBot(
    client: DbClient,
    operator: DiscordOperator,
    payload: { botId: string; quarantined: boolean; reason: string },
  ): Promise<string> {
    const current = await client.query<{ username: string; status: string; can_release: boolean }>(
      `SELECT username, status,
              reconciliation_status = 'matched'
                AND last_heartbeat_at > now() - interval '45 seconds'
                AND last_snapshot_at > now() - interval '45 seconds' AS can_release
         FROM bot_accounts WHERE id = $1 FOR UPDATE`,
      [payload.botId],
    );
    const bot = current.rows[0];
    if (!bot) throw new AppError(404, 'BOT_NOT_FOUND', 'Bot was not found');
    /* The same guard the HTTP admin route enforces. Releasing a quarantined bot without a fresh
     * matching snapshot is how a bot returns to service still holding an unexplained inventory —
     * and a command typed in a chat window must not be the cheap way around a safety check that
     * the dashboard enforces. */
    if (!payload.quarantined && bot.status === 'quarantined' && !bot.can_release) {
      conflict(
        'BOT_RECONCILIATION_REQUIRED',
        'A fresh matching snapshot and heartbeat are required before release',
      );
    }
    await client.query(
      `UPDATE bot_accounts
          SET status = $2, transfer_capable = false, updated_at = now()
        WHERE id = $1`,
      [payload.botId, payload.quarantined ? 'quarantined' : 'degraded'],
    );
    if (payload.quarantined) {
      const stopped = await client.query<{ reference_id: string }>(
        `UPDATE bot_jobs
            SET status = 'dead_letter', last_error_code = 'BOT_QUARANTINED',
                lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE bot_id = $1 AND status IN ('queued', 'leased')
          RETURNING reference_id`,
        [payload.botId],
      );
      if (stopped.rows.length) {
        await client.query(
          `UPDATE withdrawals
              SET status = 'manual_review', error_code = 'BOT_QUARANTINED', updated_at = now()
            WHERE id = ANY($1::uuid[]) AND status IN ('queued', 'processing')`,
          [stopped.rows.map((row) => row.reference_id)],
        );
      }
    }
    await appendAudit(client, config, {
      actorUserId: operator.userId,
      action: payload.quarantined ? 'bot.quarantine' : 'bot.release',
      targetType: 'bot_account',
      targetId: payload.botId,
      details: { reason: payload.reason, via: 'discord', discordUserId: operator.discordUserId },
    });
    return `${bot.username} is now ${payload.quarantined ? 'quarantined' : 'degraded'}`;
  }

  async function executeSuspendUser(
    client: DbClient,
    operator: DiscordOperator,
    payload: { userId: string; suspended: boolean; reason: string },
  ): Promise<string> {
    const current = await client.query<{ minecraft_username: string; status: string; role: string }>(
      `SELECT minecraft_username, status, role FROM users WHERE id = $1 FOR UPDATE`,
      [payload.userId],
    );
    const user = current.rows[0];
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
    /* An operator cannot suspend an administrator from Discord. Admin-on-admin action is exactly
     * the move a compromised Discord account would make first — lock the real operators out — and
     * it is rare enough in practice that requiring the dashboard for it costs nothing. */
    if (user.role === 'admin') {
      throw new AppError(
        403,
        'ADMIN_TARGET_FORBIDDEN',
        'Administrator accounts cannot be changed from Discord',
      );
    }
    if (!payload.suspended && user.status === 'closed') {
      conflict('ACCOUNT_STATUS_LOCKED', 'Closed accounts require a dashboard review');
    }
    const next = payload.suspended ? 'suspended' : 'active';
    await client.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [
      payload.userId,
      next,
    ]);
    if (payload.suspended) {
      /* A suspension that leaves live sessions running is not a suspension. */
      await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [payload.userId],
      );
    }
    await appendAudit(client, config, {
      actorUserId: operator.userId,
      action: payload.suspended ? 'user.suspend' : 'user.reinstate',
      targetType: 'user',
      targetId: payload.userId,
      details: { reason: payload.reason, via: 'discord', discordUserId: operator.discordUserId },
    });
    return `${user.minecraft_username} is now ${next}`;
  }

  /** Runs a previously confirmed action. The only place a destructive command actually lands. */
  async function runConfirmedAction(
    operator: DiscordOperator,
    action: string,
    payload: Record<string, unknown>,
    client: DbClient,
  ): Promise<string> {
    if (action === 'quarantine-bot') {
      const parsed = parseWith(
        z
          .object({ botId: z.uuid(), quarantined: z.boolean(), reason: safeText(3, 256) })
          .strict(),
        payload,
      );
      return executeQuarantineBot(client, operator, parsed);
    }
    if (action === 'suspend-user') {
      const parsed = parseWith(
        z.object({ userId: z.uuid(), suspended: z.boolean(), reason: safeText(3, 256) }).strict(),
        payload,
      );
      return executeSuspendUser(client, operator, parsed);
    }
    throw new AppError(400, 'UNKNOWN_ACTION', 'That action is no longer supported');
  }

  // ── the dispatcher ────────────────────────────────────────────────────────

  app.post(
    '/internal/v1/discord/command',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      preHandler: async (request: FastifyRequest) => verifyDiscordControlSignature(request, config),
    },
    async (request, reply) => {
      const startedAt = Date.now();
      const envelope = parseWith(envelopeSchema, request.body);
      const { context, request: command } = envelope;

      /* The log entry is assembled up front and written in `finally`, so every exit path — refused,
       * rate limited, thrown, succeeded — produces exactly one row. A `return` added later cannot
       * silently skip it. */
      let outcome: 'ok' | 'denied' | 'rate_limited' | 'error' = 'error';
      let errorCode: string | null = null;
      let actorUserId: string | null = null;
      try {
        let operator: DiscordOperator;
        try {
          operator = await resolveOperator(db, config, context.discordUserId);
        } catch (error) {
          outcome = 'denied';
          errorCode = error instanceof AppError ? error.code : 'NOT_AN_OPERATOR';
          throw error;
        }
        actorUserId = operator.userId;

        /* The guild pin. Without it, anyone who can invite the bot to their own server gets a
         * console pointed at production — the operator allowlist still holds, but an operator
         * tricked into running a command somewhere else would be acting in a channel the attacker
         * controls and can read. */
        if (context.discordGuildId && context.discordGuildId !== config.discordGuildId) {
          outcome = 'denied';
          errorCode = 'WRONG_GUILD';
          throw new AppError(403, 'WRONG_GUILD', 'These commands are not available in this server');
        }

        if (!(await spendCommandBudget(db, config, operator.discordUserId))) {
          outcome = 'rate_limited';
          errorCode = 'COMMAND_RATE_LIMITED';
          throw new AppError(429, 'COMMAND_RATE_LIMITED', 'Too many commands; wait a moment');
        }

        let result: CommandResult;
        switch (command.command) {
          case 'stats':
            result = await platformStats();
            break;
          case 'user':
            result = await lookupUser(command.query);
            break;
          case 'bots':
            result = await botHealth();
            break;
          case 'jobs':
            result = await jobQueue();
            break;
          case 'dashboard':
            result = await dashboardLink(operator, context.discordGuildId ?? null);
            break;
          case 'quarantine-bot': {
            const summary = `${command.quarantined ? 'Quarantine' : 'Release'} bot ${command.botId} — ${command.reason}`;
            const issued = await issueConfirmation(
              db,
              config,
              operator,
              'quarantine-bot',
              {
                botId: command.botId,
                quarantined: command.quarantined,
                reason: command.reason,
              },
              summary,
            );
            result = { kind: 'confirm', nonce: issued.nonce, summary };
            break;
          }
          case 'suspend-user': {
            const summary = `${command.suspended ? 'Suspend' : 'Reinstate'} user ${command.userId} — ${command.reason}`;
            const issued = await issueConfirmation(
              db,
              config,
              operator,
              'suspend-user',
              {
                userId: command.userId,
                suspended: command.suspended,
                reason: command.reason,
              },
              summary,
            );
            result = { kind: 'confirm', nonce: issued.nonce, summary };
            break;
          }
          case 'confirm': {
            /* Consumption and execution share one serializable transaction. Split apart, a crash
             * between them would burn the nonce without performing the action, and the operator
             * would have to re-issue something that may or may not have already happened. */
            const summary = await db.transaction(async (client) => {
              const consumed = await consumeConfirmation(client, operator, command.nonce);
              return runConfirmedAction(operator, consumed.action, consumed.payload, client);
            });
            result = { kind: 'done', summary };
            break;
          }
          default: {
            /* Exhaustiveness: adding a command to the union without handling it fails the build
             * rather than silently returning nothing at runtime. */
            const unreachable: never = command;
            throw new AppError(400, 'UNKNOWN_COMMAND', `Unsupported command ${String(unreachable)}`);
          }
        }
        outcome = 'ok';
        errorCode = null;
        return reply.send(result);
      } catch (error) {
        if (outcome === 'error') {
          errorCode = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
        }
        throw error;
      } finally {
        await logCommand(db, {
          discordUserId: context.discordUserId,
          discordGuildId: context.discordGuildId ?? null,
          discordChannelId: context.discordChannelId ?? null,
          command: command.command,
          arguments: command,
          actorUserId,
          outcome,
          errorCode,
          latencyMs: Date.now() - startedAt,
        });
      }
    },
  );

  // ── the alert feed ────────────────────────────────────────────

  /**
   * Operational counters for the bot's alert poller.
   *
   * Signature-gated but NOT operator-gated, and the distinction is deliberate. Nobody types this:
   * it is the bot's own heartbeat, running on a timer with no human attached, so there is no
   * Discord user whose privileges it could borrow. Inventing one — a service account in the
   * operator allowlist — would mean a permanently live administrator identity existing only to
   * satisfy a check, which is worse than not making the check.
   *
   * What makes that safe is the payload: four integers about queue and bot health. No player, no
   * balance, no identifier, nothing that reads differently depending on who is asking. Proving the
   * caller is the bot is proportionate to handing back four numbers; it would not be proportionate
   * to handing back a player's wallet, which is why the commands above ask for more.
   */
  app.post(
    '/internal/v1/discord/alerts',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: async (request: FastifyRequest) => verifyDiscordControlSignature(request, config),
    },
    async () => {
      const result = await db.query<Record<string, string>>(
        `SELECT
           (SELECT count(*) FROM bot_accounts WHERE status = 'quarantined')::text
             AS bots_quarantined,
           (SELECT count(*) FROM bot_accounts
             WHERE last_heartbeat_at IS NULL
                OR last_heartbeat_at < now() - interval '2 minutes')::text AS bots_stale,
           (SELECT count(*) FROM bot_jobs WHERE status = 'dead_letter')::text
             AS jobs_dead_letter,
           (SELECT count(*) FROM withdrawals WHERE status = 'manual_review')::text
             AS withdrawals_manual_review`,
      );
      return result.rows[0] ?? {};
    },
  );

  // ── redemption ────────────────────────────────────────────────────────────

  app.post(
    '/v1/admin/link/redeem',
    {
      /* Tighter than the global limit. This endpoint takes an opaque credential and answers
       * "valid" or "not", which is a guessing oracle if it is allowed to answer quickly, forever.
       * The token is 256 bits of randomness, so this is defence in depth rather than the control —
       * but it is the difference between an attacker needing centuries and needing the heat death
       * of the universe, at no cost to an operator who redeems one link a day. */
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const body = parseWith(redeemSchema, request.body);
      const session = await redeemAdminLink(db, config, body.token, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.setCookie(sessionCookieName(config), session.sessionToken, {
        ...sessionCookieOptions(config),
        maxAge: session.ttlHours * 60 * 60,
      });
      reply.setCookie(csrfCookieName(config), session.csrfToken, {
        path: '/',
        httpOnly: false,
        secure: config.secureCookies,
        sameSite: 'strict',
        maxAge: session.ttlHours * 60 * 60,
      });
      return reply.send({
        csrfToken: session.csrfToken,
        minecraftUsername: session.minecraftUsername,
      });
    },
  );
}
