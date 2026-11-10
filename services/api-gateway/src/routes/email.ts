import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database, DbClient } from '../lib/db.js';
import {
  createAuthGuards,
  csrfCookieName,
  csrfCookieOptions,
  linkCookieName,
  sessionCookieName,
  sessionCookieOptions,
} from '../lib/auth.js';
import { pickReceivingBot } from '../lib/bot-nodes.js';
import { hmacHex, randomToken, safeEqualText, sha256 } from '../lib/crypto.js';
import {
  EMAIL_PATTERN,
  checkCode,
  codeEmail,
  createCode,
  emailAvailability,
  emailDailyLimitReached,
  invalidCode,
  maskEmail,
  noticeEmail,
  normalizeEmail,
  sendEmail,
  type CodeCheck,
} from '../lib/email.js';
import { AppError, conflict } from '../lib/errors.js';
import { accountId } from '../lib/media-test.js';
import { MINECRAFT_USERNAME_PATTERN } from '../lib/minecraft-username.js';
import { recordNetwork } from '../lib/referral-network.js';
import { TURNSTILE_TOKEN_PATTERN, verifyTurnstile } from '../lib/turnstile.js';
import { parseWith } from '../lib/validation.js';
import { addDepositRequirement } from '../lib/wager-requirements.js';
import { creditWallet } from '../lib/wallet.js';
import { createPaymentChallenge, paymentChallengeAnswer, setPaymentChallengeCookie } from './auth-pay.js';
import { unusedRelinkPlaceholder } from './auth.js';

/**
 * Email on accounts (2026-11-10).
 *
 *   LINK      a signed-in player adds an address: a code is sent to it, and entering the code links
 *             it. The sign-in card offers this straight after a first sign-up; the profile any time.
 *   CHANGE    a linked address is replaced only with a code from it (confirm) AND one from the new
 *             address (link); the old address is told.
 *   REMOVE    with a code from it.
 *   SIGN IN   by a code sent to a linked address, instead of paying the bot. Players only: an
 *             administrator signs in with Minecraft and their authenticator, as before.
 *   MOVE      with a linked address, an account can move to another Minecraft account: a code from the
 *             address, then the new Minecraft account pays the bot exactly as at sign-up. The balance,
 *             history, VIP and everything else stay with the account; the new name is where withdrawals
 *             go from then on. Not while a withdrawal is on its way, which was addressed to the old name.
 *
 * Every email counts against the provider's daily limit (lib/email.ts); at the limit these routes
 * answer EMAIL_DAILY_LIMIT and the site says email is paused for today.
 */

const emailField = z
  .string()
  .max(254)
  .transform(normalizeEmail)
  .refine((value) => EMAIL_PATTERN.test(value), { message: 'Enter a valid email address' });
const codeField = z.string().regex(/^\d{6}$/);

const loginStartSchema = z
  .object({ email: emailField, turnstileToken: z.string().regex(TURNSTILE_TOKEN_PATTERN).optional() })
  .strict();
const loginCompleteSchema = z.object({ email: emailField, code: codeField }).strict();
const linkStartSchema = z.object({ email: emailField, confirmCode: codeField.optional() }).strict();
const codeOnlySchema = z.object({ code: codeField }).strict();
const confirmCodeSchema = z
  .object({ action: z.enum(['change_email', 'remove_email', 'change_minecraft']) })
  .strict();
const relinkStartSchema = z
  .object({ minecraftUsername: z.string().regex(MINECRAFT_USERNAME_PATTERN), code: codeField })
  .strict();
const relinkCompleteSchema = z.object({ challengeId: z.uuid() }).strict();

const CONFIRM_ACTIONS: Record<z.infer<typeof confirmCodeSchema>['action'], string> = {
  change_email: 'changing the email on your account',
  remove_email: 'removing the email from your account',
  change_minecraft: 'moving your account to a different Minecraft account',
};

/* The statuses of a cash withdrawal still on its way (cash_withdrawals_one_live_idx), and of an item
 * withdrawal. Both were addressed to the name the account had when they were asked for. */
const LIVE_CASH_WITHDRAWAL = ['pending_approval', 'queued', 'processing', 'awaiting_vault', 'manual_review'];
const LIVE_ITEM_WITHDRAWAL = ['queued', 'processing', 'manual_review'];

interface AccountRow {
  id: string;
  minecraft_identity: string;
  minecraft_username: string;
  normalized_username: string;
  role: 'player' | 'admin';
  status: string;
  email: string | null;
  email_verified_at: Date | null;
  minecraft_relinked_at: Date | null;
  demo_of: string | null;
}

const ACCOUNT_COLUMNS = `id, minecraft_identity, minecraft_username, normalized_username, role, status,
  email, email_verified_at, minecraft_relinked_at, demo_of`;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: AppError };
const failed = <T>(check: CodeCheck): Outcome<T> => ({ ok: false, error: (check as { error: AppError }).error });

export async function registerEmailRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  const requireWebsiteOrigin = async (request: FastifyRequest): Promise<void> => {
    const origin = request.headers.origin;
    if (!origin || !safeEqualText(origin, config.appOrigin)) {
      throw new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed');
    }
  };

  /** Email switched on, and today's allowance not spent: otherwise the request is refused here. */
  const requireEmail = async (): Promise<void> => {
    const state = await emailAvailability(db, config);
    if (!state.enabled) throw new AppError(503, 'EMAIL_DISABLED', 'Email is not available right now');
    if (!state.available) throw emailDailyLimitReached();
  };

  const ipHash = (request: FastifyRequest): Buffer =>
    Buffer.from(hmacHex(config.ipHashKey, request.ip ?? ''), 'hex');

  /** The real account behind the session (never a media-test twin), locked when in a transaction. */
  const loadAccount = async (client: DbClient, userId: string, lock = false): Promise<AccountRow> => {
    const result = await client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    return row;
  };

  const realAccountId = (request: FastifyRequest): string => {
    const id = accountId(request.authUser);
    if (!id) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    return id;
  };

  /** Best effort: a notice that cannot be sent (the daily limit, the provider down) never undoes
   * the change it describes, which has already been committed. */
  const sendNotice = async (to: string, userId: string, title: string, lines: string[], request: FastifyRequest) => {
    try {
      await sendEmail(db, config, { to, userId, purpose: 'notice', ...noticeEmail(title, lines) });
    } catch (error) {
      request.log.warn({ err: error }, 'Could not send an account notice email');
    }
  };

  /* ═════════════════════════ what the browser may show ═════════════════════════ */

  app.get(
    '/v1/auth/email/config',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => emailAvailability(db, config),
  );

  /* ═════════════════════════ sign in by email ═════════════════════════ */

  app.post(
    '/v1/auth/email/start',
    { preHandler: requireWebsiteOrigin, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = parseWith(loginStartSchema, request.body);
      await requireEmail();
      if (config.turnstileEnabled) {
        if (!body.turnstileToken) throw new AppError(400, 'CHALLENGE_REQUIRED', 'Complete the challenge and try again');
        await verifyTurnstile(config, body.turnstileToken, request.ip);
      }
      /* The same answer whether or not the address belongs to anyone, so this cannot be used to
       * find out which addresses have accounts. A code is only made and sent when it does, for an
       * active player; a second request inside the minute is answered the same and sends nothing. */
      const owner = await db.query<{ id: string; minecraft_username: string }>(
        `SELECT id, minecraft_username FROM users
          WHERE email = $1 AND status = 'active' AND role = 'player' AND demo_of IS NULL`,
        [body.email],
      );
      const user = owner.rows[0];
      if (user) {
        let code: string | null = null;
        try {
          code = await db.transaction(async (client) =>
            (await createCode(client, config, { purpose: 'login', email: body.email, userId: user.id, ipHash: ipHash(request) })).code,
          );
        } catch (error) {
          if (!(error instanceof AppError) || !error.code.startsWith('EMAIL_CODE_')) throw error;
        }
        if (code) {
          await sendEmail(db, config, {
            to: body.email,
            userId: user.id,
            purpose: 'login',
            ...codeEmail('login', code, user.minecraft_username),
          });
        }
      }
      return reply.code(202).send({ sent: true, email: maskEmail(body.email) });
    },
  );

  app.post(
    '/v1/auth/email/complete',
    { preHandler: requireWebsiteOrigin, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = parseWith(loginCompleteSchema, request.body);
      const sessionToken = randomToken();
      const csrfToken = randomToken();
      const sessionId = randomUUID();

      const outcome = await db.transaction<Outcome<AccountRow>>(async (client) => {
        const owner = await client.query<AccountRow>(
          `SELECT ${ACCOUNT_COLUMNS} FROM users
            WHERE email = $1 AND status = 'active' AND role = 'player' AND demo_of IS NULL FOR UPDATE`,
          [body.email],
        );
        const user = owner.rows[0];
        if (!user) return { ok: false, error: invalidCode() };
        const check = await checkCode(client, config, { purpose: 'login', email: body.email, userId: user.id, code: body.code });
        if (!check.ok) return failed(check);

        await recordNetwork(client, config, user.id, request.ip);
        await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        await client.query(
          `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, ip_hash, user_agent, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 hour'))`,
          [
            sessionId,
            user.id,
            sha256(sessionToken),
            sha256(csrfToken),
            Buffer.from(hmacHex(config.ipHashKey, request.ip), 'hex'),
            request.headers['user-agent']?.slice(0, 512) ?? null,
            config.sessionTtlHours,
          ],
        );
        return { ok: true, value: user };
      });
      // A wrong code is committed as a spent try, then refused (lib/email.ts checkCode).
      if (!outcome.ok) throw outcome.error;
      const user = outcome.value;

      reply.setCookie(sessionCookieName(config), sessionToken, sessionCookieOptions(config));
      reply.setCookie(csrfCookieName(config), csrfToken, csrfCookieOptions(config));
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

  /* ═════════════════════════ the profile's email card ═════════════════════════ */

  app.get('/v1/account/email', { preHandler: guards.authenticate }, async (request) => {
    const account = await loadAccount(db, realAccountId(request));
    const availability = await emailAvailability(db, config);
    return {
      ...availability,
      email: account.email,
      verifiedAt: account.email_verified_at,
      minecraftUsername: account.minecraft_username,
      minecraftRelinkedAt: account.minecraft_relinked_at,
      /* What the Minecraft card offers. The server checks all of it again when it is used. */
      canChangeMinecraft: Boolean(account.email) && account.role === 'player' && account.status === 'active',
      emailLogin: account.role === 'player',
    };
  });

  app.post(
    '/v1/account/email/start',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      const body = parseWith(linkStartSchema, request.body);
      await requireEmail();
      const userId = realAccountId(request);

      const outcome = await db.transaction<Outcome<{ code: string; username: string }>>(async (client) => {
        const account = await loadAccount(client, userId, true);
        if (account.demo_of) throw new AppError(403, 'TEST_ACCOUNT', 'A test account has no email');
        if (account.email === body.email) conflict('EMAIL_SAME', 'That email is already linked to your account');
        const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [body.email, userId]);
        if (taken.rows[0]) conflict('EMAIL_TAKEN', 'That email is linked to another account');
        /* Replacing a linked address takes a code from it first: whoever holds only the session
         * cannot point the account's sign-in at an address of their own. */
        if (account.email) {
          /* "Send again" for the NEW address: this same change already showed a code from the old
           * one in the last quarter hour, so it is not asked for twice. */
          const approved = await client.query(
            `SELECT 1 FROM email_codes
              WHERE user_id = $1 AND purpose = 'link' AND email = $2
                AND created_at > now() - interval '15 minutes' LIMIT 1`,
            [userId, body.email],
          );
          if (!approved.rows[0]) {
            if (!body.confirmCode) {
              throw new AppError(400, 'CONFIRM_CODE_REQUIRED', 'Enter the code sent to your current email first');
            }
            const check = await checkCode(client, config, { purpose: 'confirm', email: account.email, userId, code: body.confirmCode });
            if (!check.ok) return failed(check);
          }
        }
        const made = await createCode(client, config, { purpose: 'link', email: body.email, userId, ipHash: ipHash(request) });
        return { ok: true, value: { code: made.code, username: account.minecraft_username } };
      });
      if (!outcome.ok) throw outcome.error;
      await sendEmail(db, config, {
        to: body.email,
        userId,
        purpose: 'link',
        ...codeEmail('link', outcome.value.code, outcome.value.username),
      });
      return { sent: true, email: maskEmail(body.email) };
    },
  );

  app.post(
    '/v1/account/email/verify',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = parseWith(codeOnlySchema, request.body);
      const userId = realAccountId(request);

      const outcome = await db.transaction<Outcome<{ email: string; previous: string | null; username: string }>>(async (client) => {
        const account = await loadAccount(client, userId, true);
        const pending = await client.query<{ email: string }>(
          `SELECT email FROM email_codes
            WHERE user_id = $1 AND purpose = 'link' AND consumed_at IS NULL AND expires_at > now()
            ORDER BY created_at DESC LIMIT 1`,
          [userId],
        );
        const target = pending.rows[0]?.email;
        if (!target) return { ok: false, error: invalidCode() };
        const check = await checkCode(client, config, { purpose: 'link', email: target, userId, code: body.code });
        if (!check.ok) return failed(check);
        const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2 FOR UPDATE', [target, userId]);
        if (taken.rows[0]) return { ok: false, error: new AppError(409, 'EMAIL_TAKEN', 'That email is linked to another account') };
        await client.query(
          'UPDATE users SET email = $2, email_verified_at = now(), updated_at = now() WHERE id = $1',
          [userId, target],
        );
        return { ok: true, value: { email: target, previous: account.email, username: account.minecraft_username } };
      });
      if (!outcome.ok) throw outcome.error;
      const { email, previous, username } = outcome.value;
      if (previous && previous !== email) {
        await sendNotice(previous, userId, 'Your email was changed', [
          `The email on the DonutLuxe account ${username} was changed to ${maskEmail(email)}.`,
          'If this was not you, contact staff on the DonutLuxe Discord straight away.',
        ], request);
      }
      return reply.send({ email, verifiedAt: new Date().toISOString() });
    },
  );

  app.post(
    '/v1/account/email/confirm-code',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      const body = parseWith(confirmCodeSchema, request.body);
      await requireEmail();
      const userId = realAccountId(request);
      const made = await db.transaction(async (client) => {
        const account = await loadAccount(client, userId, true);
        if (!account.email) conflict('NO_EMAIL', 'Link an email first');
        const created = await createCode(client, config, { purpose: 'confirm', email: account.email, userId, ipHash: ipHash(request) });
        return { code: created.code, email: account.email, username: account.minecraft_username };
      });
      await sendEmail(db, config, {
        to: made.email,
        userId,
        purpose: 'confirm',
        ...codeEmail('confirm', made.code, made.username, CONFIRM_ACTIONS[body.action]),
      });
      return { sent: true, email: maskEmail(made.email) };
    },
  );

  app.post(
    '/v1/account/email/remove',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request) => {
      const body = parseWith(codeOnlySchema, request.body);
      const userId = realAccountId(request);
      const outcome = await db.transaction<Outcome<{ email: string; username: string }>>(async (client) => {
        const account = await loadAccount(client, userId, true);
        if (!account.email) conflict('NO_EMAIL', 'There is no email to remove');
        const check = await checkCode(client, config, { purpose: 'confirm', email: account.email, userId, code: body.code });
        if (!check.ok) return failed(check);
        await client.query(
          'UPDATE users SET email = NULL, email_verified_at = NULL, updated_at = now() WHERE id = $1',
          [userId],
        );
        return { ok: true, value: { email: account.email, username: account.minecraft_username } };
      });
      if (!outcome.ok) throw outcome.error;
      await sendNotice(outcome.value.email, userId, 'Your email was removed', [
        `This email is no longer linked to the DonutLuxe account ${outcome.value.username}, and can no longer be used to sign in to it.`,
        'If this was not you, contact staff on the DonutLuxe Discord straight away.',
      ], request);
      return { email: null };
    },
  );

  /* ═════════════════════════ move to another Minecraft account ═════════════════════════ */

  /** Why this account cannot move right now, or null. Checked when the move starts and again,
   * under the account's lock, when it completes. */
  const relinkBlocker = async (client: DbClient, account: AccountRow): Promise<AppError | null> => {
    if (account.demo_of) return new AppError(403, 'TEST_ACCOUNT', 'A test account cannot change its Minecraft account');
    if (account.role !== 'player') {
      return new AppError(403, 'RELINK_NOT_ALLOWED', 'Staff accounts cannot change their Minecraft account');
    }
    if (account.status !== 'active') {
      return new AppError(403, 'ACCOUNT_RESTRICTED', 'This account cannot change its Minecraft account right now');
    }
    if (!account.email) return new AppError(409, 'NO_EMAIL', 'Link an email first');
    const live = await client.query(
      `SELECT 1 FROM cash_withdrawals WHERE user_id = $1 AND status = ANY($2::text[])
       UNION ALL
       SELECT 1 FROM withdrawals WHERE user_id = $1 AND status = ANY($3::text[])
       LIMIT 1`,
      [account.id, LIVE_CASH_WITHDRAWAL, LIVE_ITEM_WITHDRAWAL],
    );
    if (live.rows[0]) {
      return new AppError(
        409,
        'WITHDRAWAL_IN_FLIGHT',
        'You have a withdrawal on its way to your current Minecraft account. Change it once that has arrived.',
      );
    }
    return null;
  };

  app.post(
    '/v1/account/minecraft/start',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = parseWith(relinkStartSchema, request.body);
      const userId = realAccountId(request);
      // A code is spent below; make sure a bot is there to be paid before spending it.
      if (!(await pickReceivingBot(db, config))) {
        throw new AppError(503, 'BOT_OFFLINE', 'No payment bot is currently online');
      }

      const outcome = await db.transaction<Outcome<null>>(async (client) => {
        const account = await loadAccount(client, userId, true);
        const blocker = await relinkBlocker(client, account);
        if (blocker) throw blocker;
        if (body.minecraftUsername.toLowerCase().replace(/^\./, '') === account.normalized_username.replace(/^\./, '')) {
          conflict('SAME_MINECRAFT_ACCOUNT', 'That is already your Minecraft account');
        }
        /* By name for now; the account that pays is checked by its UUID when the move completes. */
        const holder = await client.query(
          `SELECT 1 FROM users WHERE ltrim(normalized_username, '.') = ltrim(lower($1), '.') AND id <> $2`,
          [body.minecraftUsername, userId],
        );
        if (holder.rows[0]) {
          conflict('MINECRAFT_ACCOUNT_TAKEN', 'That Minecraft account already has a DonutLuxe account');
        }
        const check = await checkCode(client, config, { purpose: 'confirm', email: account.email!, userId, code: body.code });
        if (!check.ok) return failed(check);
        return { ok: true, value: null };
      });
      if (!outcome.ok) throw outcome.error;

      const challenge = await createPaymentChallenge(db, config, {
        minecraftUsername: body.minecraftUsername,
        referralCode: null,
        relinkUserId: userId,
      });
      setPaymentChallengeCookie(reply, config, challenge.browserToken);
      return reply.code(201).send(paymentChallengeAnswer(challenge));
    },
  );

  app.post(
    '/v1/account/minecraft/complete',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = parseWith(relinkCompleteSchema, request.body);
      const userId = realAccountId(request);
      const browserToken = readLinkCookie(request, config);
      const currentSession = request.authUser?.sessionId ?? null;

      type Moved = { email: string; from: string; to: string; identity: string };
      const outcome = await db.transaction<Outcome<Moved>>(async (client) => {
        const found = await client.query<{
          id: string;
          pay_amount: number | null;
          confirmed_identity: string | null;
          confirmed_username: string | null;
          confirmed_at: Date | null;
          completed_at: Date | null;
          expired: boolean;
        }>(
          `SELECT id, pay_amount, confirmed_identity, confirmed_username, confirmed_at, completed_at,
                  expires_at <= now() AS expired
             FROM auth_link_challenges
            WHERE id = $1 AND browser_token_hash = $2 AND relink_user_id = $3 AND method = 'payment'
            FOR UPDATE`,
          [body.challengeId, sha256(browserToken), userId],
        );
        const challenge = found.rows[0];
        if (!challenge) throw new AppError(404, 'CHALLENGE_NOT_FOUND', 'That payment was not found');
        if (challenge.completed_at) conflict('CHALLENGE_USED', 'That payment was already used');
        // A confirmed payment is money received: it stays redeemable after the ten minutes.
        if (challenge.expired && !challenge.confirmed_at) {
          throw new AppError(410, 'CHALLENGE_EXPIRED', 'The payment window ran out. Start again.');
        }
        if (!challenge.confirmed_at || !challenge.confirmed_identity || !challenge.confirmed_username) {
          conflict('CHALLENGE_NOT_CONFIRMED', 'Pay the bot from the new Minecraft account first');
        }
        if (!Number.isInteger(challenge.pay_amount) || (challenge.pay_amount ?? 0) <= 0) {
          throw new AppError(500, 'CHALLENGE_INVALID', 'The payment is missing its amount');
        }

        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('minecraft-username-ownership', 0))");
        const account = await loadAccount(client, userId, true);
        /* Refusals that leave the payment to be used later (thrown: nothing is written, and the
         * confirmed challenge stays redeemable once the reason has passed). */
        const blocker = await relinkBlocker(client, account);
        if (blocker) throw blocker;

        /* From here the payment is credited whatever happens: it is money the bot received from the
         * player, exactly like a sign-in payment (pay_login_deposit, keyed by the challenge). */
        await creditWallet(client, userId, BigInt(challenge.pay_amount!), 'pay_login_deposit', challenge.id);
        await addDepositRequirement(client, config, userId, BigInt(challenge.pay_amount!));
        await client.query('UPDATE auth_link_challenges SET completed_at = now() WHERE id = $1', [challenge.id]);

        const identity = challenge.confirmed_identity.toLowerCase();
        const name = challenge.confirmed_username;
        if (identity === account.minecraft_identity) {
          return { ok: false, error: new AppError(409, 'SAME_MINECRAFT_ACCOUNT', 'That is already your Minecraft account; the payment was added to your balance') };
        }
        if (config.adminMinecraftIds.has(identity)) {
          return { ok: false, error: new AppError(403, 'RELINK_NOT_ALLOWED', 'That Minecraft account cannot be linked this way; the payment was added to your balance') };
        }
        const holder = await client.query('SELECT 1 FROM users WHERE minecraft_identity = $1 FOR UPDATE', [identity]);
        if (holder.rows[0]) {
          return { ok: false, error: new AppError(409, 'MINECRAFT_ACCOUNT_TAKEN', 'That Minecraft account already has a DonutLuxe account; the payment was added to your balance') };
        }

        /* A stale account still holding this name (Minecraft names are recycled) gives it up, as at
         * sign-in (routes/auth.ts), and is signed out everywhere. */
        const displaced = await client.query<{ id: string; minecraft_identity: string }>(
          `SELECT id, minecraft_identity FROM users
            WHERE normalized_username = lower($1) AND id <> $2 FOR UPDATE`,
          [name, userId],
        );
        for (const stale of displaced.rows) {
          const placeholder = await unusedRelinkPlaceholder(client, stale);
          await client.query(
            'UPDATE users SET minecraft_username = $2, normalized_username = $2, updated_at = now() WHERE id = $1',
            [stale.id, placeholder],
          );
          await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [stale.id]);
        }

        await client.query(
          `UPDATE users
              SET minecraft_identity = $2, minecraft_username = $3::varchar(16),
                  normalized_username = lower($3::varchar(16)), minecraft_relinked_at = now(), updated_at = now()
            WHERE id = $1`,
          [userId, identity, name],
        );
        await client.query(
          `INSERT INTO minecraft_relinks (id, user_id, old_identity, old_username, new_identity, new_username, challenge_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), userId, account.minecraft_identity, account.minecraft_username, identity, name, challenge.id],
        );
        // Every other session ends: whoever else was signed in signs in again, as the new name.
        await client.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2',
          [userId, currentSession],
        );
        return { ok: true, value: { email: account.email!, from: account.minecraft_username, to: name, identity } };
      });

      reply.clearCookie(linkCookieName(config), { path: '/' });
      if (!outcome.ok) throw outcome.error;
      const moved = outcome.value;
      await sendNotice(moved.email, userId, 'Your Minecraft account was changed', [
        `Your DonutLuxe account is now linked to the Minecraft account ${moved.to} (it was ${moved.from}).`,
        `Withdrawals now go to ${moved.to}. If this was not you, contact staff on the DonutLuxe Discord straight away.`,
      ], request);
      return reply.send({
        user: {
          id: userId,
          minecraftIdentity: moved.identity,
          minecraftUsername: moved.to,
          role: 'player',
          status: 'active',
        },
        previousUsername: moved.from,
      });
    },
  );
}

function readLinkCookie(request: FastifyRequest, config: AppConfig): string {
  const signed = request.cookies[linkCookieName(config)];
  if (!signed) throw new AppError(401, 'LINK_COOKIE_REQUIRED', 'The payment browser cookie is missing');
  const unsigned = request.unsignCookie(signed);
  if (!unsigned.valid || !unsigned.value) throw new AppError(401, 'INVALID_LINK_COOKIE', 'Invalid payment cookie');
  return unsigned.value;
}
