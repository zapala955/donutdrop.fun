import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { accountId, ensureTwin, testModeEligible, twinBalance, twinOf } from '../lib/media-test.js';
import { parseWith } from '../lib/validation.js';
import { creditWallet } from '../lib/wallet.js';

/**
 * Media test mode: the switch, and the play-money top-up.
 *
 * The mode itself is the auth guard serving a test session as the creator's test twin; these
 * routes only flip the session flag and fill the twin's wallet. Everything that keeps play money
 * away from the real economy is in lib/media-test.ts, and none of it is here on purpose: the
 * routes that could leak are the ones that must refuse, not this one.
 */

const switchBody = z.object({ enabled: z.boolean() }).strict();

const TIGHT = { rateLimit: { max: 20, timeWindow: '1 minute' } };

/**
 * Fills the twin's wallet back up to the configured play balance. Never takes anything away: a
 * twin above the mark keeps its winnings. Returns the balance afterwards.
 */
async function topUpTwin(client: DbClient, config: AppConfig, twinId: string): Promise<bigint> {
  await client.query(
    `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [twinId],
  );
  const locked = await client.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM user_wallets WHERE user_id = $1 FOR UPDATE',
    [twinId],
  );
  const current = BigInt(locked.rows[0]?.balance_minor ?? '0');
  const target = config.mediaTestBalanceMinor;
  if (current >= target) return current;
  return BigInt(await creditWallet(client, twinId, target - current, 'demo_topup', randomUUID()));
}

function requireOwner(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}

export async function registerMediaTestRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  /* What the header needs: whether to offer the switch at all, which way it is set, and the play
   * balance. Answered for the REAL account whichever way the session is switched. */
  app.get('/v1/media/test-mode', { preHandler: guards.authenticate }, async (request) => {
    const auth = request.authUser;
    const ownerId = requireOwner(accountId(auth));
    const eligible = config.mediaTestModeEnabled && (await testModeEligible(db, ownerId));
    const twinId = auth?.demoOf ? auth.id : await twinOf(db, ownerId);
    return {
      eligible,
      active: Boolean(auth?.demoOf),
      balanceMinor: twinId ? (await twinBalance(db, twinId)).toString() : '0',
      topUpMinor: config.mediaTestBalanceMinor.toString(),
    };
  });

  app.post(
    '/v1/media/test-mode',
    { preHandler: guards.requireCsrf, config: TIGHT },
    async (request) => {
      const body = parseWith(switchBody, request.body);
      const auth = request.authUser;
      const ownerId = requireOwner(accountId(auth));
      const sessionId = requireOwner(auth?.sessionId);

      // Switching off is always allowed, whatever else has changed since it was switched on.
      if (!body.enabled) {
        await db.query('UPDATE sessions SET demo_mode = false WHERE id = $1', [sessionId]);
        return { active: false };
      }

      if (!config.mediaTestModeEnabled) {
        throw new AppError(503, 'TEST_MODE_DISABLED', 'Test mode is switched off right now');
      }
      /* With limited house stock a crate or upgrader win hands over a real item lot, and a twin
       * holding one would be play money turned into stock real players can no longer win. */
      if (!config.cashOnlyPlay && !config.houseStockUnlimited) {
        throw new AppError(503, 'TEST_MODE_UNAVAILABLE', 'Test mode needs cash-only play');
      }

      const balance = await db.transaction(async (client) => {
        if (!(await testModeEligible(client, ownerId))) {
          throw new AppError(
            403,
            'TEST_MODE_NOT_ALLOWED',
            'Test mode is for approved creators and staff',
          );
        }
        const owner = await client.query<{ minecraft_username: string }>(
          'SELECT minecraft_username FROM users WHERE id = $1',
          [ownerId],
        );
        const username = owner.rows[0]?.minecraft_username;
        if (!username) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
        const twinId = await ensureTwin(client, { id: ownerId, minecraftUsername: username });
        const filled = await topUpTwin(client, config, twinId);
        await client.query('UPDATE sessions SET demo_mode = true WHERE id = $1', [sessionId]);
        await appendAudit(client, config, {
          actorUserId: ownerId,
          action: 'media_test.on',
          targetType: 'user',
          targetId: twinId,
          details: { balanceMinor: filled.toString() },
        });
        return filled;
      });
      return { active: true, balanceMinor: balance.toString() };
    },
  );

  app.post(
    '/v1/media/test-mode/topup',
    { preHandler: guards.requireCsrf, config: TIGHT },
    async (request) => {
      const auth = request.authUser;
      if (!auth?.demoOf) {
        throw new AppError(409, 'TEST_MODE_OFF', 'Switch test mode on first');
      }
      const twinId = auth.id;
      const balance = await db.transaction((client) => topUpTwin(client, config, twinId));
      return { balanceMinor: balance.toString() };
    },
  );
}
