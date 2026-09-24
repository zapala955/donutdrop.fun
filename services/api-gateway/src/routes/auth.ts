import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database, DbClient } from '../lib/db.js';
import { hmacHex, randomToken, safeEqualText, sha256, sha256Hex } from '../lib/crypto.js';
import { AppError, conflict } from '../lib/errors.js';
import {
  createAuthGuards,
  csrfCookieName,
  linkCookieName,
  sessionCookieName,
  sessionCookieOptions,
} from '../lib/auth.js';
import { MINECRAFT_USERNAME_PATTERN } from '../lib/minecraft-username.js';
import { parseWith } from '../lib/validation.js';
import { verifyAdminTotp } from '../lib/totp.js';
import { creditWallet } from '../lib/wallet.js';
import {
  addDepositRequirement,
  addWagerRequirement,
  requirementFor,
} from '../lib/wager-requirements.js';

const startSchema = z
  .object({
    minecraftUsername: z.string().regex(MINECRAFT_USERNAME_PATTERN),
    /* An invite code, if the signup form carried one.
     *
     * Optional, and never fatal. A code that is wrong, expired or owned by nobody must not be able
     * to fail a login the player has already paid for, so this is recorded here and resolved at
     * completion, where the worst case is that no referral is created. */
    referralCode: z
      .string()
      .regex(/^[A-Z0-9]{6,16}$/)
      .optional(),
  })
  .strict();
const challengeStatusSchema = z
  .object({
    challengeId: z.uuid(),
  })
  .strict();
const challengeCompletionSchema = z
  .object({
    challengeId: z.uuid(),
    // The verifier enforces the exact eight-digit format. Keeping format validation
    // inside the locked transaction ensures malformed codes consume the same
    // per-challenge attempt budget as well-formed but incorrect codes.
    adminTotpCode: z.string().max(64).optional(),
  })
  .strict();

const MAX_ADMIN_MFA_ATTEMPTS = 5;

interface ChallengeRow {
  id: string;
  method: 'chat_code' | 'payment';
  requested_username: string;
  pay_amount: number | null;
  confirmed_identity: string | null;
  confirmed_username: string | null;
  confirmed_at: Date | null;
  completed_at: Date | null;
  attempts: number;
  /** Only selected by the completion path; the status route has no use for it. */
  referral_code?: string | null;
  expired: boolean;
}

interface LinkedUser {
  id: string;
  minecraft_identity: string;
  minecraft_username: string;
  role: 'player' | 'admin';
  status: string;
}

type LinkCompletion = { ok: true; user: LinkedUser } | { ok: false; error: AppError };

function generateLinkCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = Buffer.from(randomToken(12), 'base64url');
  return Array.from(bytes.subarray(0, 10), (byte) => alphabet[byte % alphabet.length]).join('');
}

export async function registerAuthRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];
  const requireWebsiteOrigin = async (request: FastifyRequest): Promise<void> => {
    const origin = request.headers.origin;
    if (!origin || !safeEqualText(origin, config.appOrigin)) {
      throw new AppError(403, 'INVALID_ORIGIN', 'Request origin is not allowed');
    }
  };

  app.post(
    '/v1/auth/link/start',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const body = parseWith(startSchema, request.body);
      const bot = await db.query<{ id: string; username: string; server_host: string }>(
        `SELECT id, username, server_host FROM bot_accounts
          WHERE id = ANY($1::uuid[]) AND status = 'online'
            AND last_heartbeat_at > now() - interval '45 seconds'
          ORDER BY last_heartbeat_at DESC`,
        [provisionedBotIds],
      );
      const selectedBot = bot.rows.find((candidate) => {
        const provisioned = config.botCredentials.get(candidate.id);
        return (
          provisioned &&
          candidate.username.toLowerCase() === provisioned.username.toLowerCase() &&
          candidate.server_host.toLowerCase().replace(/\.$/, '') === provisioned.serverHost
        );
      });
      if (!selectedBot)
        throw new AppError(503, 'BOT_OFFLINE', 'No deposit bot is currently online');

      const challengeId = randomUUID();
      const browserToken = randomToken();
      const linkCode = generateLinkCode();
      await db.query(
        `INSERT INTO auth_link_challenges
           (id, requested_username, normalized_username, code_hash, browser_token_hash, bot_id,
            referral_code, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 minutes')`,
        [
          challengeId,
          body.minecraftUsername,
          body.minecraftUsername.toLowerCase(),
          sha256(linkCode),
          sha256(browserToken),
          selectedBot.id,
          body.referralCode ?? null,
        ],
      );
      reply.setCookie(linkCookieName(config), browserToken, {
        path: '/',
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'strict',
        signed: true,
        maxAge: 10 * 60,
      });
      return reply.code(201).send({
        challengeId,
        expiresInSeconds: 600,
        instruction: `Send this exact message in signed public Minecraft chat: link ${linkCode}`,
      });
    },
  );

  app.get('/v1/auth/link/status', async (request) => {
    const query = parseWith(challengeStatusSchema, request.query);
    const browserToken = readLinkCookie(request, config);
    const result = await db.query<ChallengeRow>(
      `SELECT id, method, requested_username, pay_amount, confirmed_identity,
              confirmed_username, confirmed_at, completed_at, attempts,
              expires_at <= now() AS expired
         FROM auth_link_challenges WHERE id = $1 AND browser_token_hash = $2`,
      [query.challengeId, sha256(browserToken)],
    );
    const challenge = result.rows[0];
    if (!challenge) throw new AppError(404, 'CHALLENGE_NOT_FOUND', 'Link challenge was not found');
    return {
      status: challenge.completed_at
        ? 'completed'
        : challenge.attempts >= MAX_ADMIN_MFA_ATTEMPTS
          ? 'locked'
          : challenge.expired
            ? 'expired'
            : challenge.confirmed_at
              ? 'confirmed'
              : 'waiting',
      minecraftUsername: challenge.requested_username,
    };
  });

  app.post(
    '/v1/auth/link/complete',
    {
      preHandler: requireWebsiteOrigin,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const body = parseWith(challengeCompletionSchema, request.body);
      const browserToken = readLinkCookie(request, config);
      const sessionToken = randomToken();
      const csrfToken = randomToken();
      const sessionId = randomUUID();

      const completion = await db.transaction<LinkCompletion>(async (client) => {
        const result = await client.query<ChallengeRow>(
          `SELECT id, method, requested_username, pay_amount, confirmed_identity,
                  confirmed_username, confirmed_at, completed_at, attempts, referral_code,
                  expires_at <= now() AS expired
             FROM auth_link_challenges
            WHERE id = $1 AND browser_token_hash = $2 FOR UPDATE`,
          [body.challengeId, sha256(browserToken)],
        );
        const challenge = result.rows[0];
        if (!challenge)
          throw new AppError(404, 'CHALLENGE_NOT_FOUND', 'Link challenge was not found');
        if (challenge.completed_at) conflict('CHALLENGE_USED', 'Link challenge was already used');
        if (challenge.attempts >= MAX_ADMIN_MFA_ATTEMPTS) {
          return { ok: false, error: adminMfaChallengeLocked() };
        }
        // A confirmed payment is money already received. It must remain redeemable if the
        // browser's completion request is delayed or an earlier deployment returned a 500.
        if (challenge.expired && !(challenge.method === 'payment' && challenge.confirmed_at))
          throw new AppError(410, 'CHALLENGE_EXPIRED', 'Link challenge expired');
        if (
          !challenge.confirmed_at ||
          !challenge.confirmed_identity ||
          !challenge.confirmed_username
        ) {
          conflict('CHALLENGE_NOT_CONFIRMED', 'Confirm the link from Minecraft first');
        }
        const userId = randomUUID();
        const minecraftIdentity = challenge.confirmed_identity.toLowerCase();
        const desiredRole = config.adminMinecraftIds.has(minecraftIdentity) ? 'admin' : 'player';

        // Keep one lock order for identity and recycled-username ownership. The advisory lock
        // itself has no persistent side effect and is released when this transaction commits.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('minecraft-username-ownership', 0))",
        );
        const existing = await client.query<{
          id: string;
          role: 'player' | 'admin';
          admin_totp_last_counter: string | null;
        }>(
          `SELECT id, role, admin_totp_last_counter
             FROM users WHERE minecraft_identity = $1 FOR UPDATE`,
          [minecraftIdentity],
        );
        let acceptedTotpCounter: bigint | null = null;
        let adminMfaKeyFingerprint: string | null = null;
        if (desiredRole === 'admin') {
          const totpSecret = config.adminTotpSecrets.get(minecraftIdentity);
          if (totpSecret && body.adminTotpCode) {
            acceptedTotpCounter =
              verifyAdminTotp(
                totpSecret,
                body.adminTotpCode,
                existing.rows[0]?.admin_totp_last_counter === null ||
                  existing.rows[0]?.admin_totp_last_counter === undefined
                  ? null
                  : BigInt(existing.rows[0].admin_totp_last_counter),
              ) ?? null;
          }
          if (acceptedTotpCounter === null) {
            const nextAttempts = challenge.attempts + 1;
            await client.query(
              `UPDATE auth_link_challenges
                  SET attempts = attempts + 1,
                      expires_at = CASE WHEN attempts + 1 >= $2
                        THEN LEAST(expires_at, now()) ELSE expires_at END
                WHERE id = $1`,
              [challenge.id, MAX_ADMIN_MFA_ATTEMPTS],
            );
            return {
              ok: false,
              error:
                nextAttempts >= MAX_ADMIN_MFA_ATTEMPTS
                  ? adminMfaChallengeLocked()
                  : !totpSecret || !body.adminTotpCode
                    ? new AppError(
                        401,
                        'ADMIN_MFA_REQUIRED',
                        'A valid administrator MFA code is required',
                      )
                    : new AppError(
                        401,
                        'INVALID_ADMIN_MFA',
                        'The administrator MFA code is invalid',
                      ),
            };
          }
          // totpSecret must be present whenever verification succeeded.
          if (!totpSecret) throw new Error('Administrator TOTP verification invariant failed');
          adminMfaKeyFingerprint = sha256Hex(totpSecret);
        }

        // Minecraft usernames can be reassigned by Mojang. Serialize ownership changes and
        // invalidate the former owner's sessions so a stale username can never be used as a
        // withdrawal destination. This must remain after MFA validation: a failed MFA attempt
        // may only mutate the challenge attempt budget.
        const displaced = await client.query<{ id: string; minecraft_identity: string }>(
          `SELECT id, minecraft_identity FROM users
            WHERE normalized_username = lower($1) AND minecraft_identity <> $2
            FOR UPDATE`,
          [challenge.confirmed_username, minecraftIdentity],
        );
        const displacedUser = displaced.rows[0];
        if (displacedUser) {
          const placeholder = await unusedRelinkPlaceholder(client, displacedUser);
          await client.query(
            `UPDATE users SET minecraft_username = $2, normalized_username = $2,
                    updated_at = now()
              WHERE id = $1`,
            [displacedUser.id, placeholder],
          );
          await client.query(
            'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [displacedUser.id],
          );
        }
        const inserted = await client.query<{
          id: string;
          minecraft_identity: string;
          minecraft_username: string;
          role: 'player' | 'admin';
          status: string;
        }>(
          /* `status` is named rather than left to the column default, and that is not tidiness.
           * Migration 036 narrowed the status CHECK and left the default from migration 001
           * pointing at a value it had just removed, so this insert -- the only path that relied
           * on the default -- failed for every first-time signup, after they had paid. Naming it
           * means a future change to the default cannot break account creation again. */
          `INSERT INTO users
             (id, minecraft_identity, minecraft_username, normalized_username, role, status,
              last_login_at)
           VALUES ($1, $2, $3::varchar(16), lower($3::varchar(16)), $4, 'active', now())
           ON CONFLICT (minecraft_identity) DO UPDATE
             SET minecraft_username = EXCLUDED.minecraft_username,
                 normalized_username = EXCLUDED.normalized_username,
                 role = EXCLUDED.role,
                 last_login_at = now(), updated_at = now()
           RETURNING id, minecraft_identity, minecraft_username, role, status`,
          [userId, minecraftIdentity, challenge.confirmed_username, desiredRole],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('User upsert returned no row');

        /* The invite code is redeemed HERE, and only here.
         *
         * `existing.rows[0]` is the lookup taken under the ownership lock a few statements up: it
         * is non-null exactly when this Minecraft identity already had an account, which makes
         * `!existing.rows[0]` the only unambiguous "this player is signing up right now" this
         * codebase has. A referral attached anywhere else would be attachable by an account the
         * site had already acquired and paid nothing for.
         *
         * Everything below is best-effort by design. A code that is mistyped, retired or owned by
         * nobody resolves to no rows and the login continues — the player has already paid for this
         * challenge, and failing it over an optional field would be an extraordinary way to lose
         * somebody's money and their signup at once.
         */
        if (!existing.rows[0] && config.referralsEnabled && challenge.referral_code) {
          const referrer = await client.query<{ user_id: string }>(
            'SELECT user_id FROM referral_codes WHERE code = $1',
            [challenge.referral_code],
          );
          const referrerId = referrer.rows[0]?.user_id;
          /* The self-check cannot fire for a row created a moment ago — a brand-new account owns no
           * code. It is here because that is a property of today's insert order rather than a rule
           * anybody stated, and the cost of asserting it is one comparison. */
          if (referrerId && referrerId !== row.id) {
            await client.query(
              `INSERT INTO referrals (referee_id, referrer_id, code)
               VALUES ($1, $2, $3) ON CONFLICT (referee_id) DO NOTHING`,
              [row.id, referrerId, challenge.referral_code],
            );
          }
        }
        /* The signup bonus, decided by the same `!existing.rows[0]` as the invite above: the only
         * moment this codebase knows for certain that an account is new. Referenced by the account's
         * own id, so the ledger's unique (kind, reference_id) index is what makes a second one
         * impossible. Playable at once; withdrawable once its requirement has been wagered. */
        if (!existing.rows[0] && config.signupBonusMinor > 0n) {
          await creditWallet(client, row.id, config.signupBonusMinor, 'signup_bonus', row.id);
          await addWagerRequirement(
            client,
            row.id,
            requirementFor(config.signupBonusMinor, config.signupBonusWagerMultiplier),
          );
        }
        if (acceptedTotpCounter !== null) {
          await client.query('UPDATE users SET admin_totp_last_counter = $2 WHERE id = $1', [
            row.id,
            acceptedTotpCounter.toString(),
          ]);
        }
        if (existing.rows[0] && existing.rows[0].role !== desiredRole) {
          await client.query(
            'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [row.id],
          );
        }
        if (challenge.method === 'payment') {
          // A user may have paid more than one challenge after an earlier completion returned a
          // 500. Reconcile every confirmed payment for the same immutable Minecraft identity;
          // each challenge ID is its own ledger idempotency key.
          const payments = await client.query<{ id: string; pay_amount: number | null }>(
            `SELECT id, pay_amount FROM auth_link_challenges
              WHERE method = 'payment' AND confirmed_identity = $1
                AND confirmed_at IS NOT NULL AND completed_at IS NULL
              ORDER BY confirmed_at, id FOR UPDATE`,
            [minecraftIdentity],
          );
          if (!payments.rows.some((payment) => payment.id === challenge.id)) {
            throw new AppError(
              500,
              'CHALLENGE_INVALID',
              'Login challenge is missing payment details',
            );
          }
          for (const payment of payments.rows) {
            if (!Number.isInteger(payment.pay_amount) || (payment.pay_amount ?? 0) <= 0) {
              throw new AppError(
                500,
                'CHALLENGE_INVALID',
                'Login challenge is missing payment details',
              );
            }
            /* Credited one for one. Despite the `_minor` column names, this wallet counts whole
             * DonutSMP dollars: a $1M arena entry is MIN_ENTRY_MINOR = 1_000_000n, not
             * 100_000_000n. Scaling by a hundred here paid a $930 login nonce out as $93,000. */
            await creditWallet(
              client,
              row.id,
              BigInt(payment.pay_amount!),
              'pay_login_deposit',
              payment.id,
            );
            // Money in from Minecraft like any deposit, so it carries the same requirement.
            await addDepositRequirement(client, config, row.id, BigInt(payment.pay_amount!));
          }
          await client.query(
            `UPDATE auth_link_challenges SET completed_at = now()
              WHERE id = ANY($1::uuid[])`,
            [payments.rows.map((payment) => payment.id)],
          );
        }
        await client.query(
          `INSERT INTO sessions
             (id, user_id, token_hash, csrf_hash, ip_hash, user_agent, expires_at,
              admin_mfa_verified_at, admin_mfa_key_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 hour'),
                   CASE WHEN $8::boolean THEN now() ELSE NULL END, $9)`,
          [
            sessionId,
            row.id,
            sha256(sessionToken),
            sha256(csrfToken),
            Buffer.from(hmacHex(config.ipHashKey, request.ip), 'hex'),
            request.headers['user-agent']?.slice(0, 512) ?? null,
            config.sessionTtlHours,
            desiredRole === 'admin',
            adminMfaKeyFingerprint,
          ],
        );
        await client.query('UPDATE auth_link_challenges SET completed_at = now() WHERE id = $1', [
          challenge.id,
        ]);
        return { ok: true, user: row };
      });

      // MFA failures are represented as a committed transaction result. Throwing inside the
      // transaction would roll back the attempt increment and make the cap ineffective.
      if (!completion.ok) throw completion.error;
      const user = completion.user;

      reply.setCookie(sessionCookieName(config), sessionToken, sessionCookieOptions(config));
      reply.setCookie(csrfCookieName(config), csrfToken, {
        path: '/',
        httpOnly: false,
        secure: config.secureCookies,
        sameSite: 'strict',
        maxAge: config.sessionTtlHours * 60 * 60,
      });
      reply.clearCookie(linkCookieName(config), { path: '/' });
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

  app.get('/v1/auth/me', { preHandler: guards.authenticate }, async (request) => {
    const auth = request.authUser;
    if (!auth) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    return {
      id: auth.id,
      minecraftIdentity: auth.minecraftIdentity,
      minecraftUsername: auth.minecraftUsername,
      role: auth.role,
      status: auth.status,
    };
  });

  app.post('/v1/auth/logout', { preHandler: guards.requireCsrf }, async (request, reply) => {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [
      request.authUser?.sessionId,
    ]);
    guards.clearSession(reply);
    return reply.code(204).send();
  });

  app.post('/v1/auth/logout-all', { preHandler: guards.requireCsrf }, async (request, reply) => {
    await db.query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [request.authUser?.id],
    );
    guards.clearSession(reply);
    return reply.code(204).send();
  });
}

function adminMfaChallengeLocked(): AppError {
  return new AppError(
    423,
    'ADMIN_MFA_CHALLENGE_LOCKED',
    'Administrator MFA attempts exhausted; start a new link challenge',
  );
}

interface UsernameOwner {
  id: string;
  minecraft_identity: string;
}

async function unusedRelinkPlaceholder(client: DbClient, owner: UsernameOwner): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // A leading '~' is deliberately outside Minecraft's username alphabet, so only this
    // ownership-recovery path can create these temporary values.
    const placeholder = `~${sha256Hex(`${owner.id}:${owner.minecraft_identity}:${attempt}`).slice(0, 15)}`;
    const collision = await client.query(
      'SELECT 1 FROM users WHERE normalized_username = $1 AND id <> $2 LIMIT 1',
      [placeholder, owner.id],
    );
    if (!collision.rows[0]) return placeholder;
  }
  throw new Error('Could not allocate a temporary Minecraft username');
}

function readLinkCookie(request: FastifyRequest, config: AppConfig): string {
  const signed = request.cookies[linkCookieName(config)];
  if (!signed)
    throw new AppError(401, 'LINK_COOKIE_REQUIRED', 'The link browser cookie is missing');
  const unsigned = request.unsignCookie(signed);
  if (!unsigned.valid || !unsigned.value)
    throw new AppError(401, 'INVALID_LINK_COOKIE', 'Invalid link cookie');
  return unsigned.value;
}
