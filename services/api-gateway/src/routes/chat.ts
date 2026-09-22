import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { liveEvents } from '../lib/live-events.js';
import { safePublicText, safeText } from '../lib/sanitize.js';
import { levelFor } from '../lib/vip.js';
import { parseWith } from '../lib/validation.js';

/**
 * Chat.
 *
 * Messages are written by players and read by everyone, which makes this the one surface on the
 * platform where one user's input reaches another user's screen. Everything here follows from
 * that:
 *
 *   - the body goes through safeText, so control characters, bidi overrides and zero-width
 *     characters never reach another player's renderer;
 *   - the author's name is joined from `users` at read time and never taken from the request, so
 *     nobody can post as somebody else;
 *   - slow mode is enforced server-side against the database, not by a disabled button.
 *
 * Reads are public: the chat is visible before login, the same way the activity feed is. Writing
 * requires a session and a CSRF token.
 */

const MESSAGE_MAX = 240;

const sendSchema = z
  .object({
    // safePublicText, not safeText: this string is rendered inside other people’s pages.
    body: safePublicText(1, MESSAGE_MAX),
  })
  .strict();

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

const timeoutSchema = z
  .object({
    username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
    /* Bounded at a day. A mute longer than that is an account action, and account actions go
     * through the admin routes where they are audited as such. */
    minutes: z.number().int().min(1).max(1440),
    reason: safeText(3, 120).optional(),
  })
  .strict();

const moderateSchema = z.object({ id: z.uuid() }).strict();
const moderationReasonSchema = z.object({ reason: safeText(3, 256) }).strict();

/**
 * How a chat line is decorated.
 *
 * The VIP label is derived from lifetime wagered volume by the same ladder the VIP page renders, so
 * a badge in chat and a badge on the dashboard can never disagree. It is computed here rather than
 * sent as a raw total because the total is nobody else's business: what a chat line needs to say is
 * "Gold III", not "this player has staked $655M".
 */
interface MessageRow {
  id: string;
  body: string;
  created_at: Date;
  author: string;
  author_id: string;
  role: string;
  wagered_minor: string | null;
}

interface ChatClearRow {
  id: string;
  cleared_at: Date;
}

/**
 * The badge a chat line wears.
 *
 * Returns nothing at all when VIP is off, rather than a "Bronze I" every account would share — a
 * badge everybody has is noise on every line, and the ladder is what gives it meaning.
 */
function decorate(config: AppConfig, wageredMinor: string | null) {
  if (!config.vipEnabled) return {};
  const level = levelFor(BigInt(wageredMinor ?? '0'));
  return {
    vip: {
      level: level.level,
      tier: level.tier,
      label: level.label,
      /* The top tier is the one that gets the glow, so the client is told rather than left to
       * compare strings against a ladder it would have to duplicate. */
      isHighRoller: level.tier === 'high_roller',
    },
  };
}

export async function registerChatRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/chat', async (request) => {
    const query = parseWith(listQuery, request.query);
    const clear = await db.query<ChatClearRow>(
      `SELECT id, cleared_at FROM chat_clear_events
        ORDER BY cleared_at DESC, id DESC LIMIT 1`,
    );
    const reset = clear.rows[0] ?? null;
    const result = await db.query<MessageRow>(
      `SELECT m.id, m.body, m.created_at, u.minecraft_username AS author,
              m.user_id AS author_id, u.role, t.wagered_minor
         FROM chat_messages m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN user_wager_totals t ON t.user_id = m.user_id
        WHERE m.deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR m.created_at > $2)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $1`,
      [query.limit, reset?.cleared_at ?? null],
    );
    // Oldest first, so the client appends downward without reversing a list on every poll.
    return {
      messages: result.rows.reverse().map((row) => ({
        id: row.id,
        body: row.body,
        author: row.author,
        authorId: row.author_id,
        isStaff: row.role === 'admin',
        ...decorate(config, row.wagered_minor),
        createdAt: row.created_at,
      })),
      slowModeSeconds: config.chatSlowModeSeconds,
      maxLength: MESSAGE_MAX,
      /* What the client should promote into the conversation. Sent by the server so the threshold
       * is one number in one place rather than a constant the frontend guesses at. */
      bigHitMinor: config.chatBigHitMinor.toString(),
      enabled: config.chatEnabled,
      reset: reset ? { id: reset.id, clearedAt: reset.cleared_at } : null,
    };
  });

  app.post(
    '/v1/chat',
    {
      preHandler: guards.requireCsrf,
      // A coarse ceiling. Slow mode below is the real per-user spacing; this bounds the damage a
      // client can do before it gets there.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = parseWith(sendSchema, request.body);
      const userId = requireUserId(request.authUser?.id);
      if (!config.chatEnabled) {
        throw new AppError(409, 'CHAT_DISABLED', 'Chat is closed right now');
      }

      const sent = await db.transaction(async (client) => {
        /* Slow mode, measured against the database rather than the clock the client sends.
         *
         * The row is locked so two requests racing each other cannot both read "no recent
         * message" and both insert — the second waits, sees the first, and is refused. */
        /* Checked here rather than in a preHandler, because a mute is a property of the account at
         * the moment it speaks and the session may have been opened before the timeout was issued.
         * The row is kept after it expires, so this asks about effect, not existence. */
        const muted = await client.query<{ expires_at: Date; reason: string | null }>(
          `SELECT expires_at, reason FROM chat_timeouts
            WHERE user_id = $1 AND lifted_at IS NULL AND expires_at > now()
            ORDER BY expires_at DESC LIMIT 1`,
          [userId],
        );
        if (muted.rows[0]) {
          throw new AppError(
            403,
            'CHAT_TIMED_OUT',
            `You are timed out until ${muted.rows[0].expires_at.toISOString()}`,
          );
        }

        const recent = await client.query<{ created_at: Date }>(
          `SELECT created_at FROM chat_messages
            WHERE user_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            FOR UPDATE`,
          [userId],
        );
        const last = recent.rows[0]?.created_at;
        if (last) {
          const elapsedSeconds = (Date.now() - last.getTime()) / 1000;
          if (elapsedSeconds < config.chatSlowModeSeconds) {
            throw new AppError(
              429,
              'CHAT_SLOW_MODE',
              `Wait ${Math.ceil(config.chatSlowModeSeconds - elapsedSeconds)}s before posting again`,
            );
          }
        }

        const id = randomUUID();
        const inserted = await client.query<MessageRow>(
          `INSERT INTO chat_messages (id, user_id, body)
           VALUES ($1, $2, $3)
           RETURNING id, body, created_at,
                     (SELECT minecraft_username FROM users WHERE id = $2) AS author,
                     user_id AS author_id,
                     (SELECT role FROM users WHERE id = $2) AS role,
                     (SELECT wagered_minor::text FROM user_wager_totals WHERE user_id = $2)
                       AS wagered_minor`,
          [id, userId, body.body],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Chat insert returned no row');
        return row;
      });
      liveEvents.publish('chat');

      return reply.code(201).send({
        message: {
          id: sent.id,
          body: sent.body,
          author: sent.author,
          authorId: sent.author_id,
          isStaff: sent.role === 'admin',
          ...decorate(config, sent.wagered_minor ?? null),
          createdAt: sent.created_at,
        },
      });
    },
  );

  /**
   * Clears the shared timeline for everyone without destroying moderation evidence.
   *
   * Player messages are soft-deleted, the reset boundary hides earlier automated game cards, and
   * the append-only audit records both the operator's reason and the number of messages affected.
   */
  app.post(
    '/v1/admin/chat/clear',
    { preHandler: guards.requireAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseWith(moderationReasonSchema, request.body);
      const actor = requireUserId(request.authUser?.id);
      const clearId = randomUUID();

      const result = await db.transaction(async (client) => {
        const cleared = await client.query(
          `UPDATE chat_messages
              SET deleted_at = now(), deleted_by = $1
            WHERE deleted_at IS NULL`,
          [actor],
        );
        const boundary = await client.query<ChatClearRow>(
          `INSERT INTO chat_clear_events (id, cleared_by, reason)
           VALUES ($1, $2, $3)
           RETURNING id, cleared_at`,
          [clearId, actor, body.reason],
        );
        const reset = boundary.rows[0];
        if (!reset) throw new Error('Chat clear boundary insert returned no row');

        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'chat.clear',
          targetType: 'chat',
          targetId: clearId,
          details: { reason: body.reason, messagesCleared: cleared.rowCount ?? 0 },
        });

        return {
          cleared: cleared.rowCount ?? 0,
          resetId: reset.id,
          clearedAt: reset.cleared_at,
        };
      });
      liveEvents.publish('chat');
      return result;
    },
  );

  /**
   * Soft-delete one message. Admin only.
   *
   * The row stays so the record of what was posted, and that it was taken down and by whom,
   * survives the moderation. Only the read filter changes.
   */
  app.delete(
    '/v1/chat/:id',
    { preHandler: guards.requireAdmin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(moderateSchema, request.params);
      const body = parseWith(moderationReasonSchema, request.body);
      const userId = requireUserId(request.authUser?.id);
      await db.transaction(async (client) => {
        const result = await client.query<{ user_id: string }>(
          `UPDATE chat_messages
              SET deleted_at = now(), deleted_by = $2
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING user_id`,
          [params.id, userId],
        );
        if (!result.rows[0]) {
          throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such visible message');
        }
        await appendAudit(client, config, {
          actorUserId: userId,
          action: 'chat.message.delete',
          targetType: 'chat_message',
          targetId: params.id,
          details: { reason: body.reason, authorUserId: result.rows[0].user_id },
        });
      });
      liveEvents.publish('chat');
      return { deleted: true };
    },
  );

  /**
   * Times a player out of chat. Admin only.
   *
   * Deliberately NOT the responsible-play cooldown: this silences somebody, it does not stop them
   * playing. Conflating the two would mean a moderator dealing with a spammer also barred them from
   * games they have money in, and would make a self-exclusion indistinguishable from a punishment
   * in the audit trail.
   */
  app.post(
    '/v1/chat/timeouts',
    { preHandler: guards.requireAdmin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseWith(timeoutSchema, request.body);
      const issuedBy = requireUserId(request.authUser?.id);

      const target = await db.query<{ id: string; minecraft_username: string }>(
        `SELECT id, minecraft_username FROM users WHERE normalized_username = lower($1::varchar)`,
        [body.username],
      );
      const user = target.rows[0];
      if (!user) throw new AppError(404, 'NO_SUCH_PLAYER', 'No player by that name');
      if (user.id === issuedBy) {
        throw new AppError(400, 'TIMEOUT_SELF', 'You cannot time yourself out');
      }

      const id = randomUUID();
      await db.transaction(async (client) => {
        await client.query(
          `INSERT INTO chat_timeouts (id, user_id, issued_by, reason, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
          [id, user.id, issuedBy, body.reason ?? null, body.minutes],
        );
        await appendAudit(client, config, {
          actorUserId: issuedBy,
          action: 'chat.timeout.issue',
          targetType: 'user',
          targetId: user.id,
          details: { reason: body.reason ?? 'Chat moderation', minutes: body.minutes },
        });
      });
      return { id, username: user.minecraft_username, minutes: body.minutes };
    },
  );

  /** Lifts every live timeout on a player. The rows stay; only the effect ends. */
  app.delete(
    '/v1/chat/timeouts/:username',
    { preHandler: guards.requireAdmin, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(
        z.object({ username: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) }),
        request.params,
      );
      const body = parseWith(moderationReasonSchema, request.body);
      const liftedBy = requireUserId(request.authUser?.id);
      return db.transaction(async (client) => {
        const result = await client.query<{ user_id: string }>(
          `UPDATE chat_timeouts SET lifted_at = now(), lifted_by = $2
            WHERE lifted_at IS NULL AND expires_at > now()
              AND user_id = (SELECT id FROM users WHERE normalized_username = lower($1::varchar))
            RETURNING user_id`,
          [params.username, liftedBy],
        );
        const target = result.rows[0]?.user_id;
        if (target) {
          await appendAudit(client, config, {
            actorUserId: liftedBy,
            action: 'chat.timeout.lift',
            targetType: 'user',
            targetId: target,
            details: { reason: body.reason, lifted: result.rowCount ?? 0 },
          });
        }
        return { lifted: result.rowCount ?? 0 };
      });
    },
  );
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
