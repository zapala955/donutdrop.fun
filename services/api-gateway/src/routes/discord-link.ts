import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import {
  discordAuthorizeUrl,
  exchangeDiscordCode,
  OAUTH_STATE_PATTERN,
} from '../lib/discord-oauth.js';
import { linkDiscord } from '../lib/discord-rewards.js';
import { AppError, conflict } from '../lib/errors.js';

/**
 * Linking a Discord to a site account, by authorizing the app.
 *
 *   POST /v1/discord/link/start      the signed-in site asks; the answer is Discord's authorize URL,
 *                                    with a state minted for this account
 *   GET  /v1/discord/link/callback   Discord sends the browser back; the state is spent once, the
 *                                    code traded for the Discord, and the two are linked
 *
 * This is the only way a Discord is linked. Signing in stays Minecraft's alone: there is no "Log in
 * with Discord" (it was removed on 2026-10-22 at the operator's request), so an account is created
 * by verifying a Minecraft name, and its Discord is linked afterwards from the Discord page.
 *
 * The state is the whole defence on the callback, which is a top-level navigation the site did not
 * issue and so carries no CSRF header: it was minted for one signed-in account, it is single-use,
 * it expires, and only its hash is stored (the raw value travels in a URL that lands in browser
 * history and in Discord's referer). Which account gets linked is read from the stored row, never
 * from the request.
 *
 * Every callback answer is a redirect to `/discord?link=<outcome>`, never an error page, and never
 * Discord's own error text, which echoes request parameters back.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

const callbackSchema = z.object({
  code: z.string().min(8).max(512).optional(),
  state: z.string().regex(OAUTH_STATE_PATTERN).optional(),
  // Set instead of a code when the player pressed Cancel on Discord's consent screen.
  error: z.string().max(128).optional(),
});

/** What the Discord page is told on the way back. */
export type LinkOutcome =
  | 'linked' // linked; nothing more to say
  | 'reward' // linked, and the join reward was paid with it
  | 'join' // linked; the join reward waits for them to join the server
  | 'limit' // that Discord already carries the most accounts allowed
  | 'taken' // this account is already on a different Discord
  | 'inactive' // this account is suspended or closed
  | 'expired'
  | 'cancelled'
  | 'failed';

export async function registerDiscordLinkRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const available = () =>
    Boolean(config.discordClientId && config.discordClientSecret && config.discordRedirectUri);
  const back = (outcome: LinkOutcome) => `${config.appOrigin}/discord?link=${outcome}`;

  app.post(
    '/v1/discord/link/start',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      if (!available()) {
        throw new AppError(503, 'DISCORD_LINK_UNAVAILABLE', 'Discord linking is not set up yet');
      }
      const linked = await db.query<{ discord_user_id: string | null }>(
        'SELECT discord_user_id FROM users WHERE id = $1',
        [userId],
      );
      if (linked.rows[0]?.discord_user_id) {
        conflict('DISCORD_ALREADY_LINKED', 'This account is already linked to Discord');
      }

      const state = randomToken(32);
      await db.query(
        "DELETE FROM discord_oauth_states WHERE expires_at < now() - interval '1 day'",
      );
      await db.query(
        `INSERT INTO discord_oauth_states (state_hash, user_id, expires_at)
         VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))`,
        [sha256Hex(state), userId, STATE_TTL_MS],
      );
      return {
        authorizeUrl: discordAuthorizeUrl(config, config.discordRedirectUri, state),
        expiresInMs: STATE_TTL_MS,
      };
    },
  );

  app.get(
    '/v1/discord/link/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = callbackSchema.safeParse(request.query);
      if (!query.success || !query.data.state) return reply.redirect(back('failed'));

      const spent = await db.query<{ user_id: string }>(
        `UPDATE discord_oauth_states
            SET consumed_at = now()
          WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [sha256Hex(query.data.state)],
      );
      const userId = spent.rows[0]?.user_id;
      if (!userId) return reply.redirect(back('expired'));
      if (query.data.error || !query.data.code) {
        return reply.redirect(back(query.data.error === 'access_denied' ? 'cancelled' : 'failed'));
      }

      let identity;
      try {
        identity = await exchangeDiscordCode(config, query.data.code, config.discordRedirectUri);
      } catch {
        return reply.redirect(back('failed'));
      }

      const linked = await linkDiscord(db, config, {
        userId,
        discordUserId: identity.id,
        discordUsername: identity.username,
        member: identity.member,
      });
      if (linked.outcome !== 'linked') return reply.redirect(back(linked.outcome));
      return reply.redirect(
        back(linked.joinPaidMinor ? 'reward' : linked.joinWaiting ? 'join' : 'linked'),
      );
    },
  );
}
