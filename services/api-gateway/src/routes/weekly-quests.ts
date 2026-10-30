import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { readWeeklyQuests } from '../lib/weekly-quests.js';

/**
 * Weekly quests (lib/weekly-quests.ts): the week's deposit race and recruit quest, read-only.
 *
 * Public, like the leaderboard: masked names and amounts, the pots and the time left, because a
 * prize nobody can see before signing up is not one that brings anybody in. Signed in, it also
 * says where the viewer stands: their counted deposit and place, and the friends they invited this
 * week with how far each has got. Nothing here pays anything; the sweeper settles and pays.
 */
export async function registerWeeklyQuestRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const softAuth = async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* anonymous is a valid answer here */
    }
  };

  app.get(
    '/v1/quests/weekly',
    { preHandler: softAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => readWeeklyQuests(db, config, request.authUser?.id ?? null),
  );
}
