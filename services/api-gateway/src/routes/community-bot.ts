import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../lib/db.js';
import { verifyCommunityBotSignature } from '../lib/community-bot-auth.js';
import { claimTagReward, linkWithCode, rewardStatus } from '../lib/discord-rewards.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith } from '../lib/validation.js';
import { vipStandingFor } from '../lib/vip.js';

/**
 * community-bot.ts — what the public server's bot may ask this platform.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE SURFACE IS THIS SMALL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The community bot runs in a server anyone can join, moderating messages from strangers, invited
 * by whoever holds Manage Server. Everything it can call is something a compromise of that
 * process can call. So the surface is: a read of what is public about a linked account, a link
 * made with a code the SITE issued, the daily tag reward, and a reward status read. Every payment
 * it can trigger is once per account (or once per account per day) and capped -- see
 * lib/discord-rewards.ts, which holds the rules.
 *
 * WHAT IS DELIBERATELY NOT RETURNED, even though the query is one join away:
 *
 *   * the balance — this is rendered into a public channel, and a bot that announces how much
 *     money somebody is holding on a gambling site is a targeting list;
 *   * anything from the compliance columns — kyc status, date of birth, country;
 *   * the platform user id — it is the handle every other internal route keys off, and a profile
 *     card has no use for it;
 *   * somebody else's Minecraft name in full — the profile read returns it masked, as the site's
 *     public pages do, unless the person asking is the person asked about.
 *
 * Wagered total and VIP level ARE returned: the site already shows both on public leaderboards,
 * so they are public facts about the account rather than a disclosure this route invents.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ROUTE DOES NOT, BY ITSELF, PROTECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The bot also holds a database connection, for its own tables. By default that connection uses
 * the API's role, which can read `users` directly -- so withholding the balance here narrows what
 * this ENDPOINT discloses, not what a compromised bot could reach. Running
 * infra/postgres/community-bot-role.sql narrows the connection to the nine tables the bot owns and
 * makes the restraint above real. Said plainly because a comment claiming a boundary that is not
 * there is worse than no comment.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW IT CAN WRITE THE LINK
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The bot can prove which Discord account is talking to it, but not which site account that
 * person owns -- only a signed-in browser can. So the code that joins the two is minted by the
 * SITE for a session (POST /v1/discord/link-code) and only typed into the bot; the bot cannot pick
 * an account, only report who typed a code the site gave out. OAuth (referrals.ts) remains the
 * stronger path, because it trusts nothing in between; this one exists because a deployment
 * without a Discord client secret otherwise has no way to link at all, and then no way to pay the
 * server's rewards to anybody.
 */

const snowflake = z.string().regex(/^[0-9]{5,32}$/);

const lookupSchema = z.object({
  discordUserId: snowflake,
});

/* `/profile` also says who is asking, because that decides how the name is shown: in full to the
 * player themselves, masked the way the site masks it to anybody else. Optional, and a request
 * without it is answered as if a stranger asked -- the safe side to fail on. */
const profileSchema = z.object({
  discordUserId: snowflake,
  viewerDiscordUserId: snowflake.optional(),
});

const linkSchema = z
  .object({
    discordUserId: snowflake,
    discordUsername: z.string().min(1).max(64),
    guildId: snowflake,
    code: z.string().min(4).max(16),
  })
  .strict();

const tagSchema = z.object({ discordUserId: snowflake, wearingTag: z.boolean() }).strict();

export async function registerCommunityBotRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
): Promise<void> {
  /* Registers nothing when the feature is off. An endpoint that exists and always answers 401 is
   * still an endpoint to probe and still a line in the router; absent is cheaper and quieter. */
  if (!config.communityBotEnabled) return;

  app.post(
    '/internal/v1/community/profile',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(profileSchema, request.body);
      /* The full name only to its owner. Anybody else looking somebody up -- in a public channel,
       * where the card lands -- gets the mask every public surface of the site uses (lib/
       * masked-name.ts), so the bot cannot be used to undo it. Before this the card's title was
       * the name in full for whoever asked. */
      const own = body.viewerDiscordUserId === body.discordUserId;

      const found = await db.query<{
        minecraft_username: string;
        masked_username: string;
        status: string;
        created_at: Date;
        discord_verified_at: Date | null;
        wagered_minor: string | null;
      }>(
        `SELECT u.minecraft_username, ${maskedName('u.minecraft_username')} AS masked_username,
                u.status, u.created_at, u.discord_verified_at, t.wagered_minor
           FROM users u
           LEFT JOIN user_wager_totals t ON t.user_id = u.id
          WHERE u.discord_user_id = $1`,
        [body.discordUserId],
      );

      const row = found.rows[0];
      if (!row) return { linked: false as const };

      /* A suspended or closed account is reported as unlinked rather than as itself. The bot
       * renders this into a public channel, and "this account is suspended" is an enforcement
       * decision that belongs between the platform and the player, not in a server's chat. */
      if (row.status !== 'active') return { linked: false as const };

      const wagered = BigInt(row.wagered_minor ?? '0');
      return {
        linked: true as const,
        username: own ? row.minecraft_username : row.masked_username,
        memberSince: row.created_at.toISOString(),
        linkedAt: row.discord_verified_at?.toISOString() ?? null,
        wageredMinor: wagered.toString(),
        vip: vipStandingFor(wagered),
      };
    },
  );

  /* `/link <code>`: ties the Discord account to the site account the code was minted for, and pays
   * what that unlocks -- the join reward, and the invite rewards that were waiting on it. */
  app.post(
    '/internal/v1/community/link',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(linkSchema, request.body);
      return linkWithCode(db, config, body);
    },
  );

  /* `/tag`: the daily reward for wearing the server's tag, which only the bot can see. */
  app.post(
    '/internal/v1/community/rewards/tag',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(tagSchema, request.body);
      return claimTagReward(db, config, body);
    },
  );

  /* `/rewards`: where a member stands. Amounts and counts only; no balance, for the same reason the
   * profile read above leaves it out. */
  app.post(
    '/internal/v1/community/rewards/status',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(lookupSchema, request.body);
      const linked = await db.query<{ id: string; minecraft_username: string; status: string }>(
        'SELECT id, minecraft_username, status FROM users WHERE discord_user_id = $1',
        [body.discordUserId],
      );
      const row = linked.rows[0];
      const status = row && row.status === 'active' ? await rewardStatus(db, config, row.id) : null;
      return {
        linked: Boolean(status),
        username: status ? row!.minecraft_username : null,
        enabled: config.discordRewardsEnabled,
        amounts: {
          joinMinor: config.discordJoinRewardMinor.toString(),
          tagMinor: config.discordTagRewardMinor.toString(),
        },
        minAccountAgeDays: config.discordRewardMinAccountAgeDays,
        join: status?.join ?? null,
        tag: status?.tag ?? null,
      };
    },
  );
}
