import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import {
  FEEDBACK_MAX_CHARS,
  FEEDBACK_MIN_CHARS,
  readFeedbackAdmin,
  readFeedbackStatus,
  submitFeedback,
} from '../lib/feedback.js';
import { parseWith } from '../lib/validation.js';

/**
 * Player feedback (lib/feedback.ts): the player's status and their note, and the staff reading.
 *
 * Signed in only. Sending is a write, so it goes through requireCsrf, and it is rate limited on top
 * of the per-account daily limit the library keeps. The staff view needs an administrator.
 */

const feedbackSchema = z
  .object({
    likes3d: z.boolean(),
    message: z.string().trim().min(FEEDBACK_MIN_CHARS).max(FEEDBACK_MAX_CHARS),
  })
  .strict();

const adminQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).strict();

export async function registerFeedbackRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const requireAdminRead = async (request: FastifyRequest) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };

  app.get('/v1/feedback', { preHandler: guards.authenticate }, async (request) =>
    readFeedbackStatus(db, config, request.authUser!.id),
  );

  app.post(
    '/v1/feedback',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      const body = parseWith(feedbackSchema, request.body);
      return submitFeedback(db, config, request.authUser!.id, body);
    },
  );

  app.get('/v1/admin/feedback', { preHandler: requireAdminRead }, async (request) => {
    const query = parseWith(adminQuerySchema, request.query);
    return readFeedbackAdmin(db, query.limit);
  });
}
