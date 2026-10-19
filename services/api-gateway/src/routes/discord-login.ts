import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  csrfCookieName,
  csrfCookieOptions,
  discordLoginCookieName,
  sessionCookieName,
  sessionCookieOptions,
} from '../lib/auth.js';
import { hmacHex, randomToken, safeEqualText, sha256, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import {
  discordAuthorizeUrl,
  exchangeDiscordCode,
  OAUTH_STATE_PATTERN,
} from '../lib/discord-oauth.js';
import { AppError, conflict } from '../lib/errors.js';
import { recordNetwork } from '../lib/referral-network.js';

/**
 * Log in with Discord.
 *
 * A shortcut for players who already linked a Discord (the bot's /link code, or the referral
 * verification): instead of paying the bot again they confirm on Discord and are signed in to the
 * account that Discord is linked to. It never creates an account and never links one. A Discord
 * that is not linked yet is sent back to the Minecraft sign-in, which stays the only way in.
 *
 * Three requests, one row in discord_login_states (migration 073):
 *
 *   POST /v1/auth/discord/start      from the site. Mints the state that goes to Discord and a
 *                                    browser token that stays in an httpOnly cookie.
 *   GET  /v1/auth/discord/callback   Discord sends the browser here. The state is spent once, the
 *                                    code exchanged, and the linked account noted on the row.
 *   POST /v1/auth/discord/complete   from the page the callback lands on. Only the browser holding
 *                                    the cookie gets the session.
 *
 * The callback does not hand out the session itself. A callback URL works in any browser it is
 * pasted into, so a session minted there would let an attacker send somebody a link that signs
 * them into the attacker's account (login CSRF). The cookie from /start is what ties the result to
 * the browser that asked for it.
 *
 * Administrator accounts are refused. Their sessions need the TOTP that only the Minecraft sign-in
 * asks for, and authenticate() revokes an admin session without it on its first request.
 */

const LOGIN_TTL_SECONDS = 10 * 60;

const callbackSchema = z.object({
  code: z.string().min(8).max(512).optional(),
  state: z.string().regex(OAUTH_STATE_PATTERN).optional(),
  // Set instead of a code when the player pressed Cancel on Discord's consent screen.
  error: z.string().max(128).optional(),
});

/* Where the callback sends the browser. The page reads `discord-login`, says what happened, and on
 * `ok` asks /complete for the session. */
type CallbackOutcome = 'ok' | 'not-linked' | 'admin' | 'expired' | 'cancelled' | 'failed';

interface LoginAttemptRow {
  state_hash: string;
  user_id: string | null;
  discord_user_id: string | null;
  completed_at: Date | null;
  expired: boolean;
}

interface LinkedAccount {
  id: string;
  minecraft_identity: string;
  minecraft_username: string;
  role: 'player' | 'admin';
  status: string;
}

export async function registerDiscordLoginRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const available = () =>
    Boolean(config.discordClientId && config.discordClientSecret && config.discordLoginRedirectUri);

  const requireWebsiteOrigin = async (request: FastifyRequest): Promise<void> => {
    const origin = request.headers.origin;
    if (!origin || !safeEqualText(origin, config.appOrigin)) {
      throw new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed');
    }
  };

  const isAdmin = (account: Pick<LinkedAccount, 'role' | 'minecraft_identity'>) =>
    account.role === 'admin' ||
    config.adminMinecraftIds.has(account.minecraft_identity.toLowerCase());

  const back = (outcome: CallbackOutcome) => `${config.appOrigin}/?discord-login=${outcome}`;

  /* Whether the sign-in card should offer the button at all. */
  app.get('/v1/auth/discord', async () => ({ available: available() }));

  app.post(
    '/v1/auth/discord/start',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (_request, reply) => {
      if (!available()) {
        throw new AppError(503, 'DISCORD_LOGIN_UNAVAILABLE', 'Discord sign-in is not set up');
      }
      /* Both raw values leave this process (one in a Discord URL, one in a cookie); only their
       * hashes are stored, so a leaked table row is not a usable callback or completion. */
      const state = randomToken(32);
      const browserToken = randomToken(32);
      await db.query(
        "DELETE FROM discord_login_states WHERE expires_at < now() - interval '1 day'",
      );
      await db.query(
        `INSERT INTO discord_login_states (state_hash, browser_token_hash, expires_at)
         VALUES ($1, $2, now() + ($3::int * interval '1 second'))`,
        [sha256Hex(state), sha256Hex(browserToken), LOGIN_TTL_SECONDS],
      );
      /* Lax, like the session: the browser comes back by way of discord.com, and the page that
       * lands sends this with its /complete POST. Lax still keeps it off any cross-site POST. */
      reply.setCookie(discordLoginCookieName(config), browserToken, {
        path: '/',
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'lax',
        signed: true,
        maxAge: LOGIN_TTL_SECONDS,
      });
      return reply.code(201).send({
        authorizeUrl: discordAuthorizeUrl(config, config.discordLoginRedirectUri, state),
        expiresInSeconds: LOGIN_TTL_SECONDS,
      });
    },
  );

  /**
   * The callback Discord redirects the browser to.
   *
   * A GET with no CSRF header, because it is a top-level navigation the site did not issue. It
   * signs nobody in: it spends the state, learns which Discord confirmed, and notes the account
   * linked to it on the row for /complete. Every answer is a redirect back to the site, never an
   * error page, and never Discord's own error text.
   */
  app.get(
    '/v1/auth/discord/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = callbackSchema.safeParse(request.query);
      if (!query.success || !query.data.state) return reply.redirect(back('failed'));

      const spent = await db.query<{ state_hash: string }>(
        `UPDATE discord_login_states
            SET callback_at = now()
          WHERE state_hash = $1 AND callback_at IS NULL AND expires_at > now()
          RETURNING state_hash`,
        [sha256Hex(query.data.state)],
      );
      const stateHash = spent.rows[0]?.state_hash;
      if (!stateHash) return reply.redirect(back('expired'));
      if (query.data.error || !query.data.code) {
        return reply.redirect(back(query.data.error === 'access_denied' ? 'cancelled' : 'failed'));
      }

      let identity: { id: string; username: string };
      try {
        identity = await exchangeDiscordCode(
          config,
          query.data.code,
          config.discordLoginRedirectUri,
        );
      } catch {
        return reply.redirect(back('failed'));
      }

      const linked = await db.query<Pick<LinkedAccount, 'id' | 'role' | 'minecraft_identity'>>(
        `SELECT id, role, minecraft_identity FROM users
          WHERE discord_user_id = $1 AND demo_of IS NULL`,
        [identity.id],
      );
      const account = linked.rows[0];
      if (!account) return reply.redirect(back('not-linked'));
      if (isAdmin(account)) return reply.redirect(back('admin'));

      await db.query(
        `UPDATE discord_login_states SET user_id = $2, discord_user_id = $3
          WHERE state_hash = $1`,
        [stateHash, account.id, identity.id],
      );
      return reply.redirect(back('ok'));
    },
  );

  app.post(
    '/v1/auth/discord/complete',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const browserToken = readDiscordLoginCookie(request, config);
      const sessionToken = randomToken();
      const csrfToken = randomToken();
      const sessionId = randomUUID();

      const user = await db.transaction(async (client) => {
        const found = await client.query<LoginAttemptRow>(
          `SELECT state_hash, user_id, discord_user_id, completed_at, expires_at <= now() AS expired
             FROM discord_login_states
            WHERE browser_token_hash = $1 FOR UPDATE`,
          [sha256Hex(browserToken)],
        );
        const attempt = found.rows[0];
        if (!attempt) {
          throw new AppError(404, 'DISCORD_LOGIN_NOT_FOUND', 'Start the Discord sign-in again');
        }
        if (attempt.completed_at) conflict('DISCORD_LOGIN_USED', 'This sign-in was already used');
        if (attempt.expired) {
          throw new AppError(410, 'DISCORD_LOGIN_EXPIRED', 'The Discord sign-in expired');
        }
        if (!attempt.user_id || !attempt.discord_user_id) {
          conflict('DISCORD_LOGIN_NOT_CONFIRMED', 'Confirm the sign-in on Discord first');
        }

        /* Asked again, under a lock: the link could have changed in the minutes since the callback,
         * and the session must go to the account that Discord is linked to now. */
        const current = await client.query<LinkedAccount>(
          `SELECT id, minecraft_identity, minecraft_username, role, status FROM users
            WHERE id = $1 AND discord_user_id = $2 AND demo_of IS NULL
            FOR UPDATE`,
          [attempt.user_id, attempt.discord_user_id],
        );
        const account = current.rows[0];
        if (!account) {
          conflict('DISCORD_NOT_LINKED', 'That Discord is no longer linked to an account');
        }
        if (isAdmin(account)) {
          throw new AppError(
            403,
            'DISCORD_LOGIN_ADMIN',
            'Administrators sign in with Minecraft and their MFA code',
          );
        }

        await client.query(
          'UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1',
          [account.id],
        );
        // Every sign-in notes the network it came from, as the Minecraft sign-in does.
        await recordNetwork(client, config, account.id, request.ip);
        await client.query(
          `INSERT INTO sessions
             (id, user_id, token_hash, csrf_hash, ip_hash, user_agent, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 hour'))`,
          [
            sessionId,
            account.id,
            sha256(sessionToken),
            sha256(csrfToken),
            Buffer.from(hmacHex(config.ipHashKey, request.ip), 'hex'),
            request.headers['user-agent']?.slice(0, 512) ?? null,
            config.sessionTtlHours,
          ],
        );
        await client.query(
          'UPDATE discord_login_states SET completed_at = now() WHERE state_hash = $1',
          [attempt.state_hash],
        );
        return account;
      });

      reply.setCookie(sessionCookieName(config), sessionToken, sessionCookieOptions(config));
      reply.setCookie(csrfCookieName(config), csrfToken, csrfCookieOptions(config));
      reply.clearCookie(discordLoginCookieName(config), { path: '/' });
      return reply.send({
        user: {
          id: user.id,
          minecraftIdentity: user.minecraft_identity,
          minecraftUsername: user.minecraft_username,
          role: user.role,
          status: user.status,
        },
        csrfToken,
      });
    },
  );
}

function readDiscordLoginCookie(request: FastifyRequest, config: AppConfig): string {
  const signed = request.cookies[discordLoginCookieName(config)];
  if (!signed) {
    throw new AppError(401, 'DISCORD_LOGIN_COOKIE_REQUIRED', 'Start the Discord sign-in again');
  }
  const unsigned = request.unsignCookie(signed);
  if (!unsigned.valid || !unsigned.value) {
    throw new AppError(401, 'INVALID_DISCORD_LOGIN_COOKIE', 'Start the Discord sign-in again');
  }
  return unsigned.value;
}
