import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { readFeedbackAdmin } from '../lib/feedback.js';
import { parseWith } from '../lib/validation.js';

/**
 * Player feedback (lib/feedback.ts): the staff reading only.
 *
 * Feedback came off the site on 2026-11-09: the window, the account-menu row and the pop-up are
 * gone, and so are the player's two routes (GET and POST /v1/feedback), so no note can be sent and
 * no reward paid by calling them directly. What players sent before stays readable in the console's
 * Feedback tab, by an administrator.
 */

const adminQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).strict();

export async function registerFeedbackRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const requireAdminRead = async (request: FastifyRequest) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };

  app.get('/v1/admin/feedback', { preHandler: requireAdminRead }, async (request) => {
    const query = parseWith(adminQuerySchema, request.query);
    return readFeedbackAdmin(db, query.limit);
  });
}
