import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { periodOf, QUEST_KINDS, claimBoardQuest, readQuestBoard } from '../lib/quest-board.js';
import { safeText } from '../lib/sanitize.js';
import { parseWith } from '../lib/validation.js';

/**
 * The quest board (lib/quest-board.ts): the player's Quests tab, and the console's editor for it.
 *
 * The board is public, like the leaderboard: a reward nobody can see before signing up is not one
 * that brings anybody in. Signed in, it also says how far the player has got on each quest this
 * period and which they can claim. Claiming pays through the ledger, once per quest per period.
 *
 * The console writes the quests: a name, a kind (deposit or wager), a target and a reward, an order
 * and an on/off switch. Every write is audited. Editing a quest applies at once, to the period that
 * is running; a claim already made keeps the reward it was paid.
 */

const MINOR_MAX = 9_223_372_036_854_775_807n;
const amount = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= MINOR_MAX, 'Value exceeds database range');
const idSchema = z.object({ id: z.uuid() }).strict();
const fields = {
  name: safeText(1, 80),
  description: safeText(0, 240),
  kind: z.enum(QUEST_KINDS),
  targetMinor: amount,
  rewardMinor: amount,
  sortOrder: z.number().int().min(-10_000).max(10_000),
  enabled: z.boolean(),
};
// The console asks every write for a reason, kept in the audit log with it.
const reason = safeText(3, 256);
const createSchema = z.object({ ...fields, reason }).strict();
const updateSchema = z
  .object({
    name: fields.name.optional(),
    description: fields.description.optional(),
    kind: fields.kind.optional(),
    targetMinor: fields.targetMinor.optional(),
    rewardMinor: fields.rewardMinor.optional(),
    sortOrder: fields.sortOrder.optional(),
    enabled: fields.enabled.optional(),
    reason,
  })
  .strict();

interface AdminQuestRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  target_minor: string;
  reward_minor: string;
  sort_order: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  claims_period: number;
  paid_period_minor: string;
  claims_total: number;
  paid_total_minor: string;
}

export async function registerQuestBoardRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const softAuth = async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* anonymous is a valid answer here */
    }
  };
  const requireAdminRead = async (request: FastifyRequest) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };
  const actorOf = (request: FastifyRequest) => {
    const id = request.authUser?.id;
    if (!id) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    return id;
  };

  /* ─────────── the player's board ─────────── */

  app.get(
    '/v1/quests/board',
    { preHandler: softAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => readQuestBoard(db, config, request.authUser?.id ?? null),
  );

  app.post(
    '/v1/quests/board/:id/claim',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = parseWith(idSchema, request.params);
      const claimed = await claimBoardQuest(db, config, actorOf(request), id);
      return reply.code(201).send(claimed);
    },
  );

  /* ─────────── the console ─────────── */

  app.get('/v1/admin/quest-board', { preHandler: requireAdminRead }, async () => {
    const clock = await db.query<{ now: Date }>('SELECT now() AS now');
    const { start, end } = periodOf(new Date(clock.rows.at(0)!.now));
    const result = await db.query<AdminQuestRow>(
      `SELECT q.id, q.name, q.description, q.kind, q.target_minor, q.reward_minor, q.sort_order,
              q.enabled, q.created_at, q.updated_at,
              count(c.user_id) FILTER (WHERE c.period_start = $1)::integer AS claims_period,
              coalesce(sum(c.reward_minor) FILTER (WHERE c.period_start = $1), 0)::text AS paid_period_minor,
              count(c.user_id)::integer AS claims_total,
              coalesce(sum(c.reward_minor), 0)::text AS paid_total_minor
         FROM board_quests q LEFT JOIN board_quest_claims c ON c.quest_id = q.id
        GROUP BY q.id ORDER BY q.sort_order, q.created_at, q.id`,
      [start],
    );
    return { periodStart: start.toISOString(), periodEnd: end.toISOString(), quests: result.rows };
  });

  app.post('/v1/admin/quest-board', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = parseWith(createSchema, request.body);
    const actor = actorOf(request);
    const id = randomUUID();
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO board_quests
           (id, name, description, kind, target_minor, reward_minor, sort_order, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, body.name, body.description, body.kind, body.targetMinor, body.rewardMinor, body.sortOrder, body.enabled, actor],
      );
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'quest_board.create',
        targetType: 'board_quest',
        targetId: id,
        details: body,
      });
    });
    return reply.code(201).send({ quest: { id } });
  });

  app.patch('/v1/admin/quest-board/:id', { preHandler: guards.requireAdmin }, async (request) => {
    const { id } = parseWith(idSchema, request.params);
    const body = parseWith(updateSchema, request.body);
    const actor = actorOf(request);
    return db.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE board_quests SET
           name = coalesce($2, name), description = coalesce($3, description),
           kind = coalesce($4, kind), target_minor = coalesce($5::bigint, target_minor),
           reward_minor = coalesce($6::bigint, reward_minor),
           sort_order = coalesce($7::integer, sort_order),
           enabled = coalesce($8::boolean, enabled), updated_at = now()
         WHERE id = $1 RETURNING id`,
        [
          id,
          body.name ?? null,
          body.description ?? null,
          body.kind ?? null,
          body.targetMinor ?? null,
          body.rewardMinor ?? null,
          body.sortOrder ?? null,
          body.enabled ?? null,
        ],
      );
      if (!updated.rows[0]) throw new AppError(404, 'QUEST_NOT_FOUND', 'Quest was not found');
      await appendAudit(client, config, {
        actorUserId: actor,
        action: 'quest_board.update',
        targetType: 'board_quest',
        targetId: id,
        details: body,
      });
      return { quest: { id } };
    });
  });
}
