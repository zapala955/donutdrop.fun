import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { z } from 'zod';
import { dailyCodeProgress, redeemDailyCode, type RedeemResult } from '../lib/daily-codes.js';
import { createLinkCode, rewardStatus } from '../lib/discord-rewards.js';
import { AppError } from '../lib/errors.js';
import { parseWith } from '../lib/validation.js';

/* The code is whatever was typed or pasted, so it is judged (and refused politely) by the redeem
 * function rather than rejected here with a bare validation error. */
const redeemSchema = z.object({ code: z.string().min(1).max(40) }).strict();

/**
 * The site's half of the Discord rewards: a link code for the signed-in player to type into
 * `/link` in the server, what the rewards stand at, and the window where a daily code is redeemed.
 * The bot's half is in community-bot.ts.
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

  /* What a daily code can be worth, for the redeem window. Public: it is the same figure the DM
   * quotes, and the window says it to a signed-out visitor before asking them to log in. */
  const dailyCodes = {
    enabled: config.dailyCodesEnabled,
    maxPrizeMinor: config.dailyCodeMaxPrizeMinor.toString(),
    minWagerMinor: config.dailyCodeMinWagerMinor.toString(),
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
        },
        dailyCodes,
        minAccountAgeDays: config.discordRewardMinAccountAgeDays,
      };
    }
    const linkedTo = await db.query<{ discord_user_id: string | null }>(
      'SELECT discord_user_id FROM users WHERE id = $1',
      [userId],
    );
    return {
      signedIn: true,
      ...(await rewardStatus(db, config, userId)),
      // How far this player is towards the day's wagering bar, so the window can show it.
      dailyCodes: {
        ...dailyCodes,
        progress: await dailyCodeProgress(
          db,
          config,
          userId,
          linkedTo.rows[0]?.discord_user_id ?? null,
        ),
      },
    };
  });

  /* Redeeming a daily code. It happens HERE, by a signed-in player, and nowhere else: the bot only
   * delivers codes. The Discord account is the one linked to this session, never something the
   * request names, so a code can be spent only by the site account whose Discord it was sent to
   * (and every other code gets the same "not valid for you" as one that does not exist). The
   * gateway validates it, draws the prize and pays it within the day's budget (lib/daily-codes.ts).
   * A refusal is an ordinary answer, not an error: the window shows its words as they are. */
  app.post(
    '/v1/discord/daily-code/redeem',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request): Promise<RedeemResult> => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const body = parseWith(redeemSchema, request.body);
      const linked = await db.query<{ discord_user_id: string | null }>(
        'SELECT discord_user_id FROM users WHERE id = $1',
        [userId],
      );
      const discordUserId = linked.rows[0]?.discord_user_id;
      if (!discordUserId) {
        return {
          status: 'refused',
          reason:
            'Link your Discord account first: open the Discord page, copy your code and run /link in the server. Your daily code is kept',
          keepCode: true,
        };
      }
      return redeemDailyCode(db, config, { discordUserId, code: body.code });
    },
  );

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
