import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  createAuthGuards,
  csrfCookieName,
  csrfCookieOptions,
  emailLoginCookieName,
  sessionCookieName,
  sessionCookieOptions,
} from '../lib/auth.js';
import { hmacHex, randomToken, safeEqualText, sha256, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import {
  CODE_PATTERN,
  CODE_TTL_MINUTES,
  EMAIL_PAYOUT_WAIT_HOURS,
  checkCode,
  issueCode,
  maskEmail,
  normalizeEmail,
  spendCode,
} from '../lib/email-codes.js';
import { AppError, conflict } from '../lib/errors.js';
import { codeMail, mailAvailable, sendMail } from '../lib/mailer.js';
import { accountId } from '../lib/media-test.js';
import { MINECRAFT_USERNAME_PATTERN } from '../lib/minecraft-username.js';
import { recordNetwork } from '../lib/referral-network.js';
import { parseWith } from '../lib/validation.js';

/**
 * Email: link one to an account, sign in with a code sent to it, and confirm a withdrawal to a
 * different Minecraft name with one (migration 079).
 *
 *   GET  /v1/email                      this account's email, if any, and when it can confirm payouts
 *   POST /v1/email/link/start           a code to the address being linked
 *   POST /v1/email/link/confirm         that code; the address is stored only now
 *   POST /v1/email/remove/start         a code to the address on the account
 *   POST /v1/email/remove/confirm       that code; the address is removed
 *   POST /v1/email/withdraw-code        a code for one withdrawal: this amount, to this other name
 *   GET  /v1/auth/email                 whether the sign-in card offers "Sign in with an email code"
 *   POST /v1/auth/email/start           a sign-in code, if the address belongs to an account
 *   POST /v1/auth/email/complete        that code; a session, for the browser that asked
 *
 * The Minecraft sign-in stays the way in: an account is created only by verifying a Minecraft
 * name, and an email is linked to it afterwards from Settings. Administrators cannot sign in by
 * email, because their sessions need the TOTP only the Minecraft sign-in asks for.
 *
 * Why removing an email needs a code sent to it, and why a new email waits 24 hours before it can
 * confirm a payout to another name: the email is now what stops a stolen session from cashing out
 * to somebody else's name. Without the first, a thief would swap in their own address; without the
 * second, they would link theirs to an account that had none and pay themselves at once.
 *
 * Sign-in codes are tied to the browser that asked (an httpOnly cookie, as the Minecraft sign-in
 * does), and the start answers the same whether or not the address belongs to anybody, so it
 * cannot be used to find out who has an account.
 */

const emailSchema = z.object({ email: z.string().min(3).max(320) }).strict();
const codeSchema = z.object({ code: z.string().regex(CODE_PATTERN) }).strict();
const withdrawCodeSchema = z
  .object({
    amountMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    payeeUsername: z.string().regex(MINECRAFT_USERNAME_PATTERN),
  })
  .strict();

const LOGIN_COOKIE_SECONDS = CODE_TTL_MINUTES * 60;

interface AccountRow {
  id: string;
  minecraft_identity: string;
  minecraft_username: string;
  role: 'player' | 'admin';
  status: string;
}

/** Whole DonutSMP dollars, grouped: what the withdrawal email quotes. */
function dollars(amount: bigint): string {
  return `$${amount.toLocaleString('en-US')}`;
}

export async function registerEmailRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const requireAvailable = () => {
    if (!mailAvailable(config)) {
      throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Email is not set up on this site yet');
    }
  };
  const requireWebsiteOrigin = async (request: FastifyRequest): Promise<void> => {
    const origin = request.headers.origin;
    if (!origin || !safeEqualText(origin, config.appOrigin)) {
      throw new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed');
    }
  };
  const isAdmin = (account: Pick<AccountRow, 'role' | 'minecraft_identity'>) =>
    account.role === 'admin' ||
    config.adminMinecraftIds.has(account.minecraft_identity.toLowerCase());
  const userOf = (request: FastifyRequest) => {
    const id = accountId(request.authUser);
    if (!id) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    return id;
  };

  /**
   * Issues a code and mails it. The code row is committed first; if the mail cannot be sent it is
   * deleted again, so a mail service hiccup does not also cost the player their once-a-minute.
   */
  async function issueAndSend(
    input: Parameters<typeof issueCode>[2] & {
      username: string | null;
      withdrawal?: { amount: string; payee: string };
    },
  ): Promise<void> {
    const { username, withdrawal, ...issue } = input;
    const code = await db.transaction((client) => issueCode(client, config, issue));
    try {
      await sendMail(
        config,
        codeMail({ to: issue.email, code, purpose: issue.purpose, username, withdrawal }),
      );
    } catch (error) {
      await db.query(
        `DELETE FROM email_codes
          WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND created_at > now() - interval '1 minute'`,
        [issue.userId, issue.purpose],
      );
      throw new AppError(
        503,
        'EMAIL_SEND_FAILED',
        'The code could not be sent. Try again in a moment',
        undefined,
        {
          message: (error as Error).message,
        },
      );
    }
  }

  async function emailStatus(userId: string) {
    const found = await db.query<{ email: string | null; email_verified_at: Date | null }>(
      'SELECT email, email_verified_at FROM users WHERE id = $1',
      [userId],
    );
    const row = found.rows[0];
    const readyAt = row?.email_verified_at
      ? new Date(row.email_verified_at.getTime() + EMAIL_PAYOUT_WAIT_HOURS * 3_600_000)
      : null;
    return {
      available: mailAvailable(config),
      email: row?.email ?? null,
      verifiedAt: row?.email_verified_at?.toISOString() ?? null,
      /* From when this email can confirm a withdrawal to a different name. */
      payoutReadyAt: readyAt?.toISOString() ?? null,
      payoutWaitHours: EMAIL_PAYOUT_WAIT_HOURS,
    };
  }

  app.get('/v1/email', { preHandler: guards.authenticate }, async (request) =>
    emailStatus(userOf(request)),
  );

  app.get('/v1/auth/email', async () => ({ available: mailAvailable(config) }));

  // ── linking ───────────────────────────────────────────────────────────────

  app.post(
    '/v1/email/link/start',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      requireAvailable();
      const userId = userOf(request);
      const email = normalizeEmail(parseWith(emailSchema, request.body ?? {}).email);
      if (!email)
        throw new AppError(400, 'EMAIL_INVALID', 'That does not look like an email address');
      const current = await db.query<{ email: string | null; minecraft_username: string }>(
        'SELECT email, minecraft_username FROM users WHERE id = $1',
        [userId],
      );
      if (current.rows[0]?.email) {
        conflict('EMAIL_ALREADY_LINKED', 'This account already has an email. Remove it first');
      }
      const taken = await db.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [
        email,
        userId,
      ]);
      if (taken.rowCount)
        conflict('EMAIL_TAKEN', 'That email is already linked to another account');
      await issueAndSend({
        purpose: 'link',
        userId,
        email,
        username: current.rows[0]?.minecraft_username ?? null,
      });
      return { sentTo: maskEmail(email), expiresInMinutes: CODE_TTL_MINUTES };
    },
  );

  app.post(
    '/v1/email/link/confirm',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request) => {
      const userId = userOf(request);
      const { code } = parseWith(codeSchema, request.body ?? {});
      const checked = await checkCode(db, config, { purpose: 'link', userId }, code);
      try {
        await db.transaction(async (client) => {
          await spendCode(client, checked.id);
          const linked = await client.query(
            `UPDATE users SET email = $2, email_verified_at = now(), updated_at = now()
              WHERE id = $1 AND email IS NULL`,
            [userId, checked.email],
          );
          if (!linked.rowCount) {
            conflict('EMAIL_ALREADY_LINKED', 'This account already has an email. Remove it first');
          }
        });
      } catch (error) {
        // users_email_idx: somebody else linked the same address in the meantime.
        if ((error as { code?: string }).code === '23505') {
          conflict('EMAIL_TAKEN', 'That email is already linked to another account');
        }
        throw error;
      }
      return emailStatus(userId);
    },
  );

  // ── removing ──────────────────────────────────────────────────────────────

  app.post(
    '/v1/email/remove/start',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      requireAvailable();
      const userId = userOf(request);
      const current = await db.query<{ email: string | null; minecraft_username: string }>(
        'SELECT email, minecraft_username FROM users WHERE id = $1',
        [userId],
      );
      const email = current.rows[0]?.email;
      if (!email) conflict('EMAIL_NOT_LINKED', 'This account has no email');
      await issueAndSend({
        purpose: 'remove',
        userId,
        email,
        username: current.rows[0]?.minecraft_username ?? null,
      });
      return { sentTo: maskEmail(email), expiresInMinutes: CODE_TTL_MINUTES };
    },
  );

  app.post(
    '/v1/email/remove/confirm',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request) => {
      const userId = userOf(request);
      const { code } = parseWith(codeSchema, request.body ?? {});
      const checked = await checkCode(db, config, { purpose: 'remove', userId }, code);
      await db.transaction(async (client) => {
        await spendCode(client, checked.id);
        // Only the address the code was sent to: a code for an old address removes nothing new.
        await client.query(
          `UPDATE users SET email = NULL, email_verified_at = NULL, updated_at = now()
            WHERE id = $1 AND email = $2`,
          [userId, checked.email],
        );
      });
      return emailStatus(userId);
    },
  );

  // ── a withdrawal to a different name ─────────────────────────────────────

  app.post(
    '/v1/email/withdraw-code',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      requireAvailable();
      const userId = userOf(request);
      const body = parseWith(withdrawCodeSchema, request.body ?? {});
      const current = await db.query<{
        email: string | null;
        minecraft_username: string;
        ready: boolean | null;
        ready_at: Date | null;
      }>(
        `SELECT email, minecraft_username,
                email_verified_at <= now() - ($2::int * interval '1 hour') AS ready,
                email_verified_at + ($2::int * interval '1 hour') AS ready_at
           FROM users WHERE id = $1`,
        [userId, EMAIL_PAYOUT_WAIT_HOURS],
      );
      const row = current.rows[0];
      if (!row?.email) {
        conflict('EMAIL_NOT_LINKED', 'Link an email in Settings to pay a different name');
      }
      if (!row.ready) {
        throw new AppError(
          409,
          'EMAIL_TOO_NEW',
          `A new email can confirm payouts to another name ${EMAIL_PAYOUT_WAIT_HOURS} hours after it was linked`,
          { readyAt: row.ready_at?.toISOString() ?? null },
        );
      }
      if (body.payeeUsername.toLowerCase() === row.minecraft_username.toLowerCase()) {
        throw new AppError(400, 'PAYEE_IS_YOU', 'That is your own name; no code is needed for it');
      }
      const amount = BigInt(body.amountMinor);
      await issueAndSend({
        purpose: 'withdraw',
        userId,
        email: row.email,
        payeeUsername: body.payeeUsername,
        amountMinor: amount,
        username: row.minecraft_username,
        withdrawal: { amount: dollars(amount), payee: body.payeeUsername },
      });
      return { sentTo: maskEmail(row.email), expiresInMinutes: CODE_TTL_MINUTES };
    },
  );

  // ── signing in ────────────────────────────────────────────────────────────

  app.post(
    '/v1/auth/email/start',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      requireAvailable();
      const email = normalizeEmail(parseWith(emailSchema, request.body ?? {}).email);
      if (!email)
        throw new AppError(400, 'EMAIL_INVALID', 'That does not look like an email address');

      const browserToken = randomToken(32);
      reply.setCookie(emailLoginCookieName(config), browserToken, {
        path: '/',
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'strict',
        signed: true,
        maxAge: LOGIN_COOKIE_SECONDS,
      });

      /* The same answer whatever happens below: an unknown address, an administrator, a throttled
       * account and a mail that went out all read "if it is linked, a code is on its way". */
      const found = await db.query<AccountRow>(
        `SELECT id, minecraft_identity, minecraft_username, role, status FROM users
          WHERE email = $1 AND demo_of IS NULL`,
        [email],
      );
      const account = found.rows[0];
      if (account && !isAdmin(account)) {
        try {
          await issueAndSend({
            purpose: 'login',
            userId: account.id,
            email,
            browserTokenHash: sha256Hex(browserToken),
            username: account.minecraft_username,
          });
        } catch (error) {
          request.log.warn({ err: error }, 'An email sign-in code was not sent');
        }
      }
      return reply.send({ sentTo: maskEmail(email), expiresInMinutes: CODE_TTL_MINUTES });
    },
  );

  app.post(
    '/v1/auth/email/complete',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const { code } = parseWith(codeSchema, request.body ?? {});
      const browserToken = readLoginCookie(request, config);
      const checked = await checkCode(
        db,
        config,
        { purpose: 'login', browserTokenHash: sha256Hex(browserToken) },
        code,
      );
      const sessionToken = randomToken();
      const csrfToken = randomToken();
      const sessionId = randomUUID();
      const previous = readSessionToken(request, config);

      const user = await db.transaction(async (client) => {
        await spendCode(client, checked.id);
        /* Asked again under a lock: the email could have been removed or moved since the code was
         * sent, and the session must go to the account that address belongs to now. */
        const found = await client.query<AccountRow>(
          `SELECT id, minecraft_identity, minecraft_username, role, status FROM users
            WHERE id = $1 AND email = $2 AND demo_of IS NULL
            FOR UPDATE`,
          [checked.userId, checked.email],
        );
        const account = found.rows[0];
        if (!account) conflict('EMAIL_NOT_LINKED', 'That email is no longer linked to an account');
        if (isAdmin(account)) {
          throw new AppError(
            403,
            'EMAIL_LOGIN_ADMIN',
            'Administrators sign in with Minecraft and their MFA code',
          );
        }
        await client.query(
          'UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1',
          [account.id],
        );
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
        return account;
      });

      reply.setCookie(sessionCookieName(config), sessionToken, sessionCookieOptions(config));
      reply.setCookie(csrfCookieName(config), csrfToken, csrfCookieOptions(config));
      reply.clearCookie(emailLoginCookieName(config), { path: '/' });
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

function readLoginCookie(request: FastifyRequest, config: AppConfig): string {
  const signed = request.cookies[emailLoginCookieName(config)];
  const unsigned = signed ? request.unsignCookie(signed) : null;
  if (!unsigned?.valid || !unsigned.value) {
    throw new AppError(400, 'EMAIL_CODE_INVALID', 'That code is wrong or has expired');
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
