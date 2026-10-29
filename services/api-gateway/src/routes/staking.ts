import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { readStaking, requestUnstake, stake } from '../lib/staking.js';
import { parseWith } from '../lib/validation.js';

/**
 * The house pool (lib/staking.ts): the page, a stake, and an unstake request.
 *
 * Readable signed out, so the pool's terms and its settled days can be seen before anybody signs up.
 * Moving money in or out is the signed-in player's own account only; the server decides every
 * figure, and nothing here pays anything: the settler does that once a day is over.
 */

const stakeSchema = z
  .object({ amountMinor: z.string().regex(/^[1-9][0-9]{0,17}$/, 'a whole amount') })
  .strict();
const lotParams = z.object({ id: z.uuid() }).strict();

export async function registerStakingRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const softAuth = async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* anonymous is a valid answer here */
    }
  };

  function activePlayer(request: FastifyRequest): string {
    const user = request.authUser;
    if (!user?.id) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    if (user.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_RESTRICTED', 'This account cannot stake right now');
    }
    return user.id;
  }

  app.get(
    '/v1/staking',
    { preHandler: softAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => readStaking(db, config, request.authUser?.id ?? null),
  );

  app.post(
    '/v1/staking/stake',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = activePlayer(request);
      const body = parseWith(stakeSchema, request.body);
      return stake(db, config, userId, BigInt(body.amountMinor));
    },
  );

  app.post(
    '/v1/staking/lots/:id/unstake',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = activePlayer(request);
      const { id } = parseWith(lotParams, request.params);
      return requestUnstake(db, config, userId, id);
    },
  );
}
