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
import type { Database, DbClient } from '../lib/db.js';
import {
  discordAuthorizeUrl,
  exchangeDiscordCode,
  OAUTH_STATE_PATTERN,
} from '../lib/discord-oauth.js';
import { AppError, conflict } from '../lib/errors.js';
import { recordNetwork } from '../lib/referral-network.js';
import { parseWith } from '../lib/validation.js';

/**
 * Log in with Discord.
 *
 * A shortcut for players who already linked a Discord (the bot's /link code, or the referral
 * verification): instead of paying the bot again they confirm on Discord and are signed in to an
 * account that Discord is linked to. It never creates an account and never links one. A Discord
 * that is not linked yet is sent back to the Minecraft sign-in, which stays the only way in.
 *
 * Four requests, one row in discord_login_states (migrations 073, 075):
 *
 *   POST /v1/auth/discord/start      from the site. Mints the state that goes to Discord and a
 *                                    browser token that stays in an httpOnly cookie.
 *   GET  /v1/auth/discord/callback   Discord sends the browser here. The state is spent once, the
 *                                    code exchanged, and the confirmed Discord noted on the row.
 *   POST /v1/auth/discord/accounts   from the page the callback lands on, when that Discord carries
 *                                    several accounts (a main and its alts): which ones it may pick.
 *   POST /v1/auth/discord/complete   the session, for the account picked (or the only one), handed
 *                                    only to the browser holding the cookie.
 *
 * The callback does not hand out the session itself. A callback URL works in any browser it is
 * pasted into, so a session minted there would let an attacker send somebody a link that signs
 * them into the attacker's account (login CSRF). The cookie from /start is what ties the result to
 * the browser that asked for it -- and so the account list as well: it is answered only to the
 * browser whose Discord confirmed.
 *
 * Administrator accounts are refused, and left out of the list. Their sessions need the TOTP that
 * only the Minecraft sign-in asks for, and authenticate() revokes an admin session without it on its
 * first request.
 */

const LOGIN_TTL_SECONDS = 10 * 60;

/* `consent` asks Discord to show its Authorize screen again. The site sends it only on the retry
 * after Discord refused the quiet `prompt=none` round trip (see the `retry` outcome). */
const startSchema = z.object({ consent: z.boolean().optional() }).strict();

const callbackSchema = z.object({
  code: z.string().min(8).max(512).optional(),
  state: z.string().regex(OAUTH_STATE_PATTERN).optional(),
  // Set instead of a code when the player pressed Cancel on Discord's consent screen.
  error: z.string().max(128).optional(),
});

const completeSchema = z.object({ userId: z.uuid().optional() }).strict();

/* Errors Discord answers `prompt=none` with when it wants the player to see the screen after all
 * (OAuth's own names for "this cannot be done without asking"). The page then starts over once,
 * with consent. */
const NEEDS_CONSENT = new Set(['consent_required', 'interaction_required', 'login_required']);

/* Where the callback sends the browser. The page reads `discord-login`, says what happened, and on
 * `ok` asks /complete for the session (on `choose`, it asks which account first). */
type CallbackOutcome =
  'ok' | 'choose' | 'not-linked' | 'admin' | 'expired' | 'cancelled' | 'retry' | 'failed';

interface LoginAttemptRow {
  state_hash: string;
  user_id: string | null;
  discord_user_id: string | null;
  discord_username: string | null;
  completed_at: Date | null;
  expired: boolean;
}

interface LinkedAccount {
  id: string;
  minecraft_identity: string;
  minecraft_username: string;
  role: 'player' | 'admin';
  status: string;
  discord_main: boolean;
  last_login_at: Date | null;
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

  /** The accounts a Discord may sign in to: linked, not a media-test twin, not an administrator. */
  async function signInAccounts(
    client: Pick<DbClient, 'query'>,
    discordUserId: string,
  ): Promise<{ eligible: LinkedAccount[]; any: boolean }> {
    const rows = await client.query<LinkedAccount>(
      `SELECT id, minecraft_identity, minecraft_username, role, status, discord_main, last_login_at
         FROM users
        WHERE discord_user_id = $1 AND demo_of IS NULL
        ORDER BY last_login_at DESC NULLS LAST, discord_main DESC, discord_verified_at, id`,
      [discordUserId],
    );
    return {
      eligible: rows.rows.filter((account) => !isAdmin(account)),
      any: rows.rows.length > 0,
    };
  }

  /** The attempt this browser started, once its Discord has confirmed. */
  async function confirmedAttempt(
    client: Pick<DbClient, 'query'>,
    request: FastifyRequest,
    lock: boolean,
  ): Promise<LoginAttemptRow & { discord_user_id: string }> {
    const browserToken = readDiscordLoginCookie(request, config);
    const found = await client.query<LoginAttemptRow>(
      `SELECT state_hash, user_id, discord_user_id, discord_username, completed_at,
              expires_at <= now() AS expired
         FROM discord_login_states
        WHERE browser_token_hash = $1${lock ? ' FOR UPDATE' : ''}`,
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
    if (!attempt.discord_user_id) {
      conflict('DISCORD_LOGIN_NOT_CONFIRMED', 'Confirm the sign-in on Discord first');
    }
    return { ...attempt, discord_user_id: attempt.discord_user_id };
  }

  const back = (outcome: CallbackOutcome) => `${config.appOrigin}/?discord-login=${outcome}`;

  /* Whether the sign-in card should offer the button at all. */
  app.get('/v1/auth/discord', async () => ({ available: available() }));

  app.post(
    '/v1/auth/discord/start',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      if (!available()) {
        throw new AppError(503, 'DISCORD_LOGIN_UNAVAILABLE', 'Discord sign-in is not set up');
      }
      const body = parseWith(startSchema, request.body ?? {});
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
        authorizeUrl: discordAuthorizeUrl(
          config,
          config.discordLoginRedirectUri,
          state,
          body.consent ? 'consent' : 'none',
        ),
        expiresInSeconds: LOGIN_TTL_SECONDS,
      });
    },
  );

  /**
   * The callback Discord redirects the browser to.
   *
   * A GET with no CSRF header, because it is a top-level navigation the site did not issue. It
   * signs nobody in: it spends the state, learns which Discord confirmed, and notes it on the row
   * (with the account, when there is exactly one to pick). Every answer is a redirect back to the
   * site, never an error page, and never Discord's own error text.
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
        const error = query.data.error ?? '';
        return reply.redirect(
          back(
            error === 'access_denied' ? 'cancelled' : NEEDS_CONSENT.has(error) ? 'retry' : 'failed',
          ),
        );
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

      const { eligible, any } = await signInAccounts(db, identity.id);
      if (!any) return reply.redirect(back('not-linked'));
      if (!eligible.length) return reply.redirect(back('admin'));

      /* The only account is noted at once; with several the player picks on the site, and the
       * Discord alone is noted here. */
      const only = eligible.length === 1 ? eligible[0]!.id : null;
      await db.query(
        `UPDATE discord_login_states SET discord_user_id = $2, discord_username = $3, user_id = $4
          WHERE state_hash = $1`,
        [stateHash, identity.id, identity.username, only],
      );
      return reply.redirect(back(only ? 'ok' : 'choose'));
    },
  );

  /* Which accounts the confirmed Discord may pick from, for the picker. A POST so the site's origin
   * travels with it; answered only to the browser that started the attempt (the cookie). */
  app.post(
    '/v1/auth/discord/accounts',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request) => {
      const attempt = await confirmedAttempt(db, request, false);
      const { eligible } = await signInAccounts(db, attempt.discord_user_id);
      return {
        discordUsername: attempt.discord_username,
        accounts: eligible.map((account) => ({
          id: account.id,
          minecraftUsername: account.minecraft_username,
          main: account.discord_main,
          lastLoginAt: account.last_login_at?.toISOString() ?? null,
        })),
      };
    },
  );

  app.post(
    '/v1/auth/discord/complete',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const body = parseWith(completeSchema, request.body ?? {});
      const sessionToken = randomToken();
      const csrfToken = randomToken();
      const sessionId = randomUUID();
      /* A player switching accounts arrives with the old account's session still in the browser.
       * It is ended, not left valid behind a cookie the new one is about to overwrite. */
      const previous = readSessionToken(request, config);

      const user = await db.transaction(async (client) => {
        const attempt = await confirmedAttempt(client, request, true);
        const chosen = body.userId ?? attempt.user_id;
        if (!chosen) conflict('DISCORD_LOGIN_CHOOSE', 'Pick which account to sign in to');

        /* Asked again, under a lock: the link could have changed in the minutes since the callback,
         * and the session must go to an account that Discord is linked to now. A picked id that is
         * not one of this Discord's accounts lands here too, with the same answer. */
        const current = await client.query<LinkedAccount>(
          `SELECT id, minecraft_identity, minecraft_username, role, status, discord_main,
                  last_login_at
             FROM users
            WHERE id = $1 AND discord_user_id = $2 AND demo_of IS NULL
            FOR UPDATE`,
          [chosen, attempt.discord_user_id],
        );
        const account = current.rows[0];
        if (!account) {
          conflict('DISCORD_NOT_LINKED', 'That account is not linked to this Discord');
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
        if (previous) {
          await client.query(
            'UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
            [sha256(previous)],
          );
        }
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
          'UPDATE discord_login_states SET user_id = $2, completed_at = now() WHERE state_hash = $1',
          [attempt.state_hash, account.id],
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

/** The session this browser already holds, if any and if genuinely signed by this server. */
function readSessionToken(request: FastifyRequest, config: AppConfig): string | null {
  const signed = request.cookies[sessionCookieName(config)];
  if (!signed) return null;
  const unsigned = request.unsignCookie(signed);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}
