import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { createLinkCode, rewardStatus } from '../lib/discord-rewards.js';
import { AppError } from '../lib/errors.js';

/**
 * The site's half of the Discord rewards: a link code for the signed-in player to type into
 * `/link` in the server, and what the rewards stand at. The bot's half is in community-bot.ts.
 */
export async function registerDiscordRewardRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
): Promise<void> {
  const guards = createAuthGuards(db, config);

  /* Readable signed out, so the Discord page can say what the rewards are before anybody logs in. */
  const softAuth = async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* anonymous is a valid answer here */
    }
  };

  app.get('/v1/discord/rewards', { preHandler: softAuth }, async (request) => {
    const userId = request.authUser?.id;
    if (!userId) {
      return {
        enabled: config.discordRewardsEnabled,
        linked: false,
        signedIn: false,
        amounts: {
          joinMinor: config.discordJoinRewardMinor.toString(),
          tagMinor: config.discordTagRewardMinor.toString(),
          inviteMinor: config.discordInviteRewardMinor.toString(),
        },
        minAccountAgeDays: config.discordRewardMinAccountAgeDays,
      };
    }
    return { signedIn: true, ...(await rewardStatus(db, config, userId)) };
  });

  app.post(
    '/v1/discord/link-code',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      if (!config.communityBotEnabled) {
        throw new AppError(
          503,
          'DISCORD_LINK_UNAVAILABLE',
          'Linking through Discord is switched off',
        );
      }
      const linked = await db.query<{ discord_user_id: string | null }>(
        'SELECT discord_user_id FROM users WHERE id = $1',
        [userId],
      );
      if (linked.rows[0]?.discord_user_id) {
        throw new AppError(
          409,
          'DISCORD_ALREADY_LINKED',
          'This account is already linked to Discord',
        );
      }
      return createLinkCode(db, userId);
    },
  );
}
