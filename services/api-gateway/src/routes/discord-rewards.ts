import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { z } from 'zod';
import { codeDropStatus, redeemCodeDrop, type DropRedeemResult } from '../lib/code-drops.js';
import { unlinkAccount } from '../lib/discord-accounts.js';
import { createLinkCode, rewardStatus } from '../lib/discord-rewards.js';
import { AppError } from '../lib/errors.js';
import { TURNSTILE_TOKEN_PATTERN, verifyTurnstile } from '../lib/turnstile.js';
import { parseWith } from '../lib/validation.js';

/* The code is whatever was typed or pasted, so it is judged (and refused politely) by the redeem
 * function rather than rejected here with a bare validation error. */
/* `turnstileToken` is optional in the shape and required by the handler while Turnstile is on, as on
 * the sign-in routes, so a deployment without it configured still redeems. */
const redeemSchema = z
  .object({ code: z.string().min(1).max(40), turnstileToken: z.string().regex(TURNSTILE_TOKEN_PATTERN).optional() })
  .strict();

/* The server's invite, the same one the Discord page's button opens (DONUTDROP FRONTEND
 * assets/js/discord.js INVITE_URL). Its public endpoint carries the counts Discord itself shows on
 * an invite: how many members, how many online. */
const INVITE_CODE = 'aHfRsUaGgx';
const SERVER_COUNTS_TTL_MS = 5 * 60_000;
type ServerCounts = { members: number | null; online: number | null };
let serverCounts: { at: number; body: ServerCounts } | null = null;

/** The live member and online counts, at most one request to Discord every five minutes. */
async function readServerCounts(): Promise<ServerCounts> {
  if (serverCounts && Date.now() - serverCounts.at < SERVER_COUNTS_TTL_MS) return serverCounts.body;
  let body: ServerCounts = { members: null, online: null };
  try {
    const response = await fetch(`https://discord.com/api/v10/invites/${INVITE_CODE}?with_counts=true`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4_000),
    });
    if (response.ok) {
      const data = (await response.json()) as { approximate_member_count?: unknown; approximate_presence_count?: unknown };
      const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null);
      body = { members: count(data.approximate_member_count), online: count(data.approximate_presence_count) };
    }
  } catch {
    /* Discord slow or down: the page leaves the counts out rather than waiting on them. */
  }
  serverCounts = { at: Date.now(), body };
  return body;
}

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

  /* Public: the Discord page says how big the server is before anybody logs in. */
  app.get(
    '/v1/discord/server',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => readServerCounts(),
  );

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
        // Public: what a drop pays, when the next one comes and how many claims the current has left.
        codeDrops: await codeDropStatus(db, config),
        minAccountAgeDays: config.discordRewardMinAccountAgeDays,
      };
    }
    return {
      signedIn: true,
      ...(await rewardStatus(db, config, userId)),
      codeDrops: await codeDropStatus(db, config),
    };
  });

  /* Redeeming a code drop's code (lib/code-drops.ts). It happens HERE, by a signed-in player, and
   * nowhere else: the bot only posts codes. The Discord account is the one linked to this session,
   * never something the request names. A refusal is an ordinary answer, not an error: the window
   * shows its words as they are. */
  app.post(
    '/v1/discord/codes/redeem',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request): Promise<DropRedeemResult> => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const body = parseWith(redeemSchema, request.body);
      /* The owner, 2026-11-13: "add turnstile". A claim is a race for five places, so a script that
       * reads the Discord and posts the code wins it; Cloudflare's challenge makes it a person's. */
      if (config.turnstileEnabled) {
        if (!body.turnstileToken) throw new AppError(400, 'CHALLENGE_REQUIRED', 'Complete the challenge and try again');
        await verifyTurnstile(config, body.turnstileToken, request.ip);
      }
      return redeemCodeDrop(db, config, { userId, code: body.code, ip: request.ip });
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

  /* Unlinks THIS account from its Discord, from the site. Only the signed-in account: the others on
   * the same Discord are managed from Discord itself (/accounts), where the Discord is proven. It
   * frees a slot for another alt.
   * Rewards already paid stay paid; the Discord's claims stay spent. */
  app.post(
    '/v1/discord/unlink',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const result = await db.transaction((client) => unlinkAccount(client, { userId }));
      return { unlinked: true, newMain: result.newMain };
    },
  );
}
