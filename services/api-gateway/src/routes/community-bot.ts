import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../lib/db.js';
import { verifyCommunityBotSignature } from '../lib/community-bot-auth.js';
import {
  linkedAccounts,
  mainAccount,
  setMainAccount,
  unlinkAccount,
} from '../lib/discord-accounts.js';
import {
  claimTagReward,
  linkWithCode,
  recordTagSightings,
  rewardStatus,
  tagWatchList,
} from '../lib/discord-rewards.js';
import { maskedName } from '../lib/masked-name.js';
import { MINECRAFT_USERNAME_PATTERN } from '../lib/minecraft-username.js';
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
 * made with a code the SITE issued, the tag reward and the tag sightings it is judged on, and a
 * reward status read. Every payment it can trigger is once per account (or once per account per
 * 24 hours of wearing the tag) and capped -- see lib/discord-rewards.ts, which holds the rules.
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

/* `/accounts main` and `/accounts unlink` name one of the member's own accounts by its Minecraft
 * name. The Discord is the one on the interaction, so a member can only ever touch accounts linked
 * to themselves. */
const accountChoiceSchema = z
  .object({ discordUserId: snowflake, username: z.string().regex(MINECRAFT_USERNAME_PATTERN) })
  .strict();

const watchSchema = z.object({}).strict();

const sightingsSchema = z
  .object({
    sightings: z
      .array(z.object({ discordUserId: snowflake, wearing: z.boolean() }).strict())
      .min(1)
      .max(500),
  })
  .strict();

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
          WHERE u.discord_user_id = $1 AND u.demo_of IS NULL
          ORDER BY u.discord_main DESC, u.discord_verified_at, u.id
          LIMIT 1`,
        [body.discordUserId],
      );

      const row = found.rows[0];
      if (!row) return { linked: false as const };

      /* A suspended or closed account is reported as unlinked rather than as itself. The bot
       * renders this into a public channel, and "this account is suspended" is an enforcement
       * decision that belongs between the platform and the player, not in a server's chat. */
      if (row.status !== 'active') return { linked: false as const };

      const wagered = BigInt(row.wagered_minor ?? '0');
      /* The card is the Discord's MAIN account. How many alts sit behind it is told to the member
       * themselves only (so `/link` knows whether another one fits), never to a channel. */
      const accounts = own ? await linkedAccounts(db, body.discordUserId) : null;
      return {
        linked: true as const,
        username: own ? row.minecraft_username : row.masked_username,
        memberSince: row.created_at.toISOString(),
        linkedAt: row.discord_verified_at?.toISOString() ?? null,
        wageredMinor: wagered.toString(),
        vip: vipStandingFor(wagered),
        ...(accounts ? { accounts: accounts.length, maxAccounts: config.discordMaxAccounts } : {}),
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

  /* Who the bot should keep an eye on for the 24-hour rule: linked accounts that have collected a
   * tag reward lately. Snowflakes only -- no names, no site ids. */
  app.post(
    '/internal/v1/community/rewards/tag-watch',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      parseWith(watchSchema, request.body);
      return { discordUserIds: await tagWatchList(db) };
    },
  );

  /* What the bot saw on those profiles: tag on or off. It pays nothing by itself; it is what the
   * next /tag is judged against. */
  app.post(
    '/internal/v1/community/rewards/tag-seen',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(sightingsSchema, request.body);
      const recorded = await db.transaction((client) => recordTagSightings(client, body.sightings));
      return { recorded: recorded.size };
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
      // The main account: the one /tag pays.
      const row = await mainAccount(db, body.discordUserId);
      const status = row && row.status === 'active' ? await rewardStatus(db, config, row.id) : null;
      return {
        linked: Boolean(status),
        username: status ? row!.minecraft_username : null,
        enabled: config.discordRewardsEnabled,
        amounts: {
          joinMinor: config.discordJoinRewardMinor.toString(),
          tagMinor: config.discordTagRewardMinor.toString(),
        },
        dailyCodes: {
          enabled: config.dailyCodesEnabled,
          maxPrizeMinor: config.dailyCodeMaxPrizeMinor.toString(),
          minWagerMinor: config.dailyCodeMinWagerMinor.toString(),
          firstPrizeMinor: config.dailyCodeFirstPrizeMinor.toString(),
        },
        minAccountAgeDays: config.discordRewardMinAccountAgeDays,
        join: status?.join ?? null,
        tag: status?.tag ?? null,
      };
    },
  );

  /* `/accounts list`: every site account linked to the member's Discord, main first. Answered only
   * to the member (the bot replies ephemerally), so full names are fine here; nothing about money. */
  app.post(
    '/internal/v1/community/accounts',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(lookupSchema, request.body);
      const accounts = await linkedAccounts(db, body.discordUserId);
      return {
        max: config.discordMaxAccounts,
        accounts: accounts.map((account) => ({
          username: account.minecraftUsername,
          main: account.main,
          active: account.status === 'active',
          linkedAt: account.linkedAt?.toISOString() ?? null,
          lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        })),
      };
    },
  );

  /* `/accounts main`: which of the member's accounts the bot acts for (/tag pays it). Only among
   * accounts on the member's own Discord, so even a compromised bot can move a member's rewards
   * between that member's accounts and nowhere else. */
  app.post(
    '/internal/v1/community/accounts/main',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(accountChoiceSchema, request.body);
      const account = await db.transaction((client) =>
        setMainAccount(client, body.discordUserId, body.username),
      );
      return { username: account.minecraftUsername, main: true };
    },
  );

  /* `/accounts unlink`: takes one account off the member's Discord. What it collected stays paid and
   * the Discord's claims stay spent (discord_rewards is keyed on the Discord). */
  app.post(
    '/internal/v1/community/accounts/unlink',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(accountChoiceSchema, request.body);
      const result = await db.transaction((client) =>
        unlinkAccount(client, {
          discordUserId: body.discordUserId,
          minecraftUsername: body.username,
        }),
      );
      return { unlinked: result.unlinked, newMain: result.newMain };
    },
  );
}
