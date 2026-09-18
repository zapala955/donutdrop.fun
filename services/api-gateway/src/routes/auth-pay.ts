import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { linkCookieName } from '../lib/auth.js';
import { randomToken, safeEqualText, sha256 } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { resolveMinecraftAccount } from '../lib/minecraft-identity.js';
import { MINECRAFT_USERNAME_PATTERN } from '../lib/minecraft-username.js';
import { parseWith } from '../lib/validation.js';

/**
 * Login by paying the bot.
 *
 * The player proves control of a DonutSMP account by sending the bot an exact amount the site
 * chose. That amount is the one-time secret, so it is drawn from the range DonutSMP renders
 * exactly in chat: at a thousand and above the payment message abbreviates ("1234" arrives as
 * "1.2K") and the nonce stops being legible.
 *
 * The bot strictly matches DonutSMP's structured system-chat receipt. Once that exact nonce is
 * observed, the browser's polling request resolves the public Minecraft identity and confirms the
 * challenge. Completion remains in POST /v1/auth/link/complete.
 */

const startSchema = z
  .object({ minecraftUsername: z.string().regex(MINECRAFT_USERNAME_PATTERN) })
  .strict();
const statusSchema = z.object({ challengeId: z.uuid() }).strict();

const PAY_AMOUNT_ATTEMPTS = 12;
const PAY_CHALLENGE_TTL_MINUTES = 10;
const UNIQUE_VIOLATION = '23505';

interface ChallengeStatusRow {
  id: string;
  requested_username: string;
  pay_amount: number | null;
  observed_payment_at: Date | null;
  confirmed_at: Date | null;
  completed_at: Date | null;
  expired: boolean;
  bot_username: string;
}

export async function registerPayLoginRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const provisionedBotIds = [...config.botCredentials.keys()];

  const requireWebsiteOrigin = async (request: FastifyRequest): Promise<void> => {
    const origin = request.headers.origin;
    if (!origin || !safeEqualText(origin, config.appOrigin)) {
      throw new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed');
    }
  };

  const readLinkCookie = (request: FastifyRequest): string => {
    const signed = request.cookies[linkCookieName(config)];
    if (!signed) {
      throw new AppError(401, 'LINK_COOKIE_REQUIRED', 'The login browser cookie is missing');
    }
    const unsigned = request.unsignCookie(signed);
    if (!unsigned.valid || !unsigned.value) {
      throw new AppError(401, 'INVALID_LINK_COOKIE', 'Invalid login cookie');
    }
    return unsigned.value;
  };

  /** The one provisioned bot that is online and matches its configured identity, if any. */
  const selectOnlineBot = async () => {
    const bots = await db.query<{ id: string; username: string; server_host: string }>(
      `SELECT id, username, server_host FROM bot_accounts
        WHERE id = ANY($1::uuid[]) AND status = 'online'
          AND last_heartbeat_at > now() - interval '45 seconds'
        ORDER BY last_heartbeat_at DESC`,
      [provisionedBotIds],
    );
    return bots.rows.find((candidate) => {
      const provisioned = config.botCredentials.get(candidate.id);
      return (
        provisioned &&
        candidate.username.toLowerCase() === provisioned.username.toLowerCase() &&
        candidate.server_host.toLowerCase().replace(/\.$/, '') === provisioned.serverHost
      );
    });
  };

  app.post(
    '/v1/auth/pay/start',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const body = parseWith(startSchema, request.body);
      const selectedBot = await selectOnlineBot();
      if (!selectedBot) {
        throw new AppError(503, 'BOT_OFFLINE', 'No payment bot is currently online');
      }
      // Expired challenges keep holding their amount, so the uniqueness guarantee never depends
      // on a clock comparison inside an index predicate. Clearing them frees those amounts.
      await db.query(
        `DELETE FROM auth_link_challenges
          WHERE method = 'payment' AND completed_at IS NULL AND confirmed_at IS NULL
            AND expires_at <= now()`,
      );

      const browserToken = randomToken();
      const span = config.payLoginMaxAmount - config.payLoginMinAmount + 1;
      for (let attempt = 0; attempt < PAY_AMOUNT_ATTEMPTS; attempt += 1) {
        const payAmount = config.payLoginMinAmount + randomInt(span);
        const challengeId = randomUUID();
        try {
          await db.transaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8842))', [
              `payment-lane:${selectedBot.id}`,
            ]);
            await client.query(
              `INSERT INTO auth_link_challenges
                 (id, requested_username, normalized_username, code_hash, browser_token_hash,
                  bot_id, expires_at, method, pay_amount)
               VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7),
                       'payment', $8)`,
              [
                challengeId,
                body.minecraftUsername,
                body.minecraftUsername.toLowerCase(),
                // Unused by this method; the column is NOT NULL UNIQUE for the chat-code flow.
                sha256(randomToken()),
                sha256(browserToken),
                selectedBot.id,
                PAY_CHALLENGE_TTL_MINUTES,
                payAmount,
              ],
            );
          });
          reply.setCookie(linkCookieName(config), browserToken, {
            path: '/',
            httpOnly: true,
            secure: config.secureCookies,
            sameSite: 'strict',
            signed: true,
            maxAge: PAY_CHALLENGE_TTL_MINUTES * 60,
          });
          return reply.code(201).send({
            challengeId,
            payAmount,
            botUsername: selectedBot.username,
            expiresInSeconds: PAY_CHALLENGE_TTL_MINUTES * 60,
            instruction: `/pay ${selectedBot.username} ${payAmount}`,
          });
        } catch (error) {
          // Another live challenge already owns that amount, so draw a different one.
          const code =
            error !== null && typeof error === 'object'
              ? (error as { code?: unknown }).code
              : undefined;
          if (code !== UNIQUE_VIOLATION) throw error;
        }
      }
      throw new AppError(
        503,
        'PAY_LOGIN_BUSY',
        'Too many logins are in progress; try again in a few minutes',
      );
    },
  );

  app.get('/v1/auth/pay/status', async (request) => {
    const query = parseWith(statusSchema, request.query);
    const browserToken = readLinkCookie(request);
    const result = await db.query<ChallengeStatusRow>(
      `SELECT c.id, c.requested_username, c.pay_amount, c.observed_payment_at,
              c.confirmed_at, c.completed_at,
              c.expires_at <= now() AS expired, b.username AS bot_username
         FROM auth_link_challenges c JOIN bot_accounts b ON b.id = c.bot_id
        WHERE c.id = $1 AND c.browser_token_hash = $2 AND c.method = 'payment'`,
      [query.challengeId, sha256(browserToken)],
    );
    const challenge = result.rows[0];
    if (!challenge) {
      throw new AppError(404, 'CHALLENGE_NOT_FOUND', 'Login challenge was not found');
    }

    const base = {
      challengeId: challenge.id,
      payAmount: challenge.pay_amount,
      botUsername: challenge.bot_username,
    };
    if (challenge.completed_at) return { ...base, state: 'completed' };
    if (challenge.confirmed_at) return { ...base, state: 'confirmed' };
    if (challenge.expired) return { ...base, state: 'expired' };
    if (!challenge.observed_payment_at) return { ...base, state: 'waiting' };

    if (challenge.pay_amount === null) {
      throw new AppError(500, 'CHALLENGE_INVALID', 'Login challenge is missing payment details');
    }

    // The receipt carries a name, not an account. Names are reassignable, so store its current UUID.
    const account = await resolveMinecraftAccount(challenge.requested_username);
    if (!account) {
      throw new AppError(
        404,
        'MINECRAFT_ACCOUNT_NOT_FOUND',
        'That Minecraft account was not found',
      );
    }

    await db.query(
      `UPDATE auth_link_challenges
          SET confirmed_identity = $2, confirmed_username = $3, confirmed_at = now()
        WHERE id = $1 AND confirmed_at IS NULL AND completed_at IS NULL`,
      [challenge.id, account.identity, account.username],
    );
    return { ...base, state: 'confirmed' };
  });
}
