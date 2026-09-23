import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../lib/db.js';
import { verifyCommunityBotSignature } from '../lib/community-bot-auth.js';
import { parseWith } from '../lib/validation.js';
import { vipStandingFor } from '../lib/vip.js';

/**
 * community-bot.ts — the one thing the public server's bot may ask this platform.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS EXACTLY ONE ENDPOINT HERE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The community bot runs in a server anyone can join, moderating messages from strangers, invited
 * by whoever holds Manage Server. Everything it can call is something a compromise of that
 * process can call. So the surface is one read: given a Discord snowflake, what is public about
 * the account it is linked to.
 *
 * WHAT IS DELIBERATELY NOT RETURNED, even though the query is one join away:
 *
 *   * the balance — this is rendered into a public channel, and a bot that announces how much
 *     money somebody is holding on a gambling site is a targeting list;
 *   * anything from the compliance columns — kyc status, date of birth, country;
 *   * the platform user id — it is the handle every other internal route keys off, and a profile
 *     card has no use for it.
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
 * WHY IT DOES NOT WRITE THE LINK
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `users.discord_user_id` is written by the OAuth callback in referrals.ts and nowhere else. The
 * bot can prove which Discord account is talking to it, but not which site account that person
 * owns — only a signed-in browser can prove that. A chat-issued link code would have been a
 * second, weaker path into the same column, and with two paths the weaker one decides how strong
 * the link is.
 */

const lookupSchema = z.object({
  discordUserId: z.string().regex(/^[0-9]{5,32}$/),
});

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
      const body = parseWith(lookupSchema, request.body);

      const found = await db.query<{
        minecraft_username: string;
        status: string;
        created_at: Date;
        discord_verified_at: Date | null;
        wagered_minor: string | null;
      }>(
        `SELECT u.minecraft_username, u.status, u.created_at, u.discord_verified_at,
                t.wagered_minor
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
        username: row.minecraft_username,
        memberSince: row.created_at.toISOString(),
        linkedAt: row.discord_verified_at?.toISOString() ?? null,
        wageredMinor: wagered.toString(),
        vip: vipStandingFor(wagered),
      };
    },
  );
}
