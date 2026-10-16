import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { accountId } from '../lib/media-test.js';
import { markNotificationsRead, readNotifications } from '../lib/notifications.js';
import { parseWith } from '../lib/validation.js';

/**
 * The notification bell (lib/notifications.ts): the list, and marking it read.
 *
 * Both act on the real account behind the session, never a media test twin: a creator recording a
 * clip in test mode still wants to see their own deposit land, and play money has no news in it.
 */

const readSchema = z
  .object({
    /* The newest item the panel showed. Optional: without it everything up to now is read. */
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export async function registerNotificationRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  function requireAccount(user: Parameters<typeof accountId>[0]): string {
    const id = accountId(user);
    if (!id) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    return id;
  }

  app.get(
    '/v1/notifications',
    { preHandler: guards.authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => readNotifications(db, config, requireAccount(request.authUser)),
  );

  app.post(
    '/v1/notifications/read',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseWith(readSchema, request.body ?? {});
      const readAt = await markNotificationsRead(
        db,
        requireAccount(request.authUser),
        body.until ? new Date(body.until) : null,
      );
      return { readAt };
    },
  );
}
