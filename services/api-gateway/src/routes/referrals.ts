import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import {
  claimReferralRewards,
  ensureReferralCode,
  revshareMinor,
} from '../lib/referrals.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith } from '../lib/validation.js';
import { containsMarkup, containsUnsafeCharacters } from '../lib/sanitize.js';

/**
 * Invite & Earn.
 *
 * Two payouts hang off one relationship. The revenue share accrues silently on every wager the
 * referee makes and is collected here by the referrer; the milestone bonus still pays
 * automatically. This file also owns the dashboard, the code a player chooses, and the Discord
 * OAuth round trip — which is no longer part of any payout gate and is kept because an account may
 * still want to be linked.
 *
 * It does NOT own redemption. A code is spent in the transaction that creates an account, in
 * auth.ts, because "has this person signed up yet" is a question only that transaction can answer
 * without arguing about thresholds.
 *
 * The dashboard reads from `referrals` rather than summing `referral_earnings`, because the row is
 * what the payout gate actually consults. A progress bar computed from a different source than the
 * gate is a progress bar that can reach 100% while the gate stays shut.
 */

/* The alphabet has to match the one auth.ts accepts on a login, or a player could set a code that
 * nobody is able to redeem. */
const renameSchema = z.object({ code: z.string().regex(/^[A-Z0-9]{6,16}$/) }).strict();
/* Typed or pasted, so it is trimmed and uppercased before it is judged: `abc123 ` is the code. */
const attachSchema = z
  .object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,16}$/) })
  .strict();
const DAY_MS = 86_400_000;

/* An inviter can be swapped only while the relationship has produced nothing: no unlocked bonus, no
 * revenue share paid or waiting, and not voided by an operator. After that the money is the old
 * inviter's, and moving the row to a new one would hand it over. */
function referralIsLocked(row: {
  bonus_unlocked_at: Date | null;
  revshare_paid_minor: string;
  revshare_claimable_minor: string;
  voided_at: Date | null;
}): boolean {
  return (
    !!row.bonus_unlocked_at ||
    !!row.voided_at ||
    BigInt(row.revshare_paid_minor) > 0n ||
    BigInt(row.revshare_claimable_minor) > 0n
  );
}

/**
 * Words a player may not build a code out of.
 *
 * An invite code is pasted into public chat beside a link to this site, so a code reading
 * DONUTLUXESUPPORT is not a vanity code, it is a costume. The check is on CONTAINMENT rather than
 * equality — XADMINX impersonates exactly as well as ADMIN, and a rule that only caught the exact
 * word would be a rule that advertised its own workaround.
 *
 * Short and specific on purpose. This is not a profanity filter; the site's own identity and its
 * staff are what a stranger could be fooled by, and a list that tries to police taste as well ends
 * up refusing ordinary names for reasons nobody can explain to the player it refused.
 */
const RESERVED_FRAGMENTS = [
  'ADMIN',
  'DONUT',
  'MOD',
  'OFFICIAL',
  'OWNER',
  'STAFF',
  'SUPPORT',
  'SYSTEM',
];
const callbackSchema = z
  .object({
    code: z.string().min(8).max(512),
    state: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

interface InviteRow {
  referee_id: string;
  minecraft_username: string;
  wagered_minor: string;
  revshare_paid_minor: string;
  revshare_claimable_minor: string;
  bonus_unlocked_at: Date | null;
  bonus_paid_minor: string | null;
  discord_verified_at: Date | null;
  created_at: Date;
}

interface ReferralTotalsRow {
  invites: string;
  verified: string;
  unlocked: string;
  revshare_paid_minor: string;
  revshare_claimable_minor: string;
  bonus_paid_minor: string;
}

export async function registerReferralRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  /** Every route here is dead weight when the programme is off, so say so once. */
  function requireProgramme(): void {
    if (!config.referralsEnabled) {
      throw new AppError(404, 'REFERRALS_DISABLED', 'The referral programme is not enabled');
    }
  }

  // ── the dashboard ─────────────────────────────────────────────────────────

  app.get('/v1/referrals', { preHandler: guards.authenticate }, async (request) => {
    requireProgramme();
    const userId = requireUserId(request.authUser?.id);

    const code = await db.transaction((client) => ensureReferralCode(client, userId));

    const invites = await db.query<InviteRow>(
      `SELECT r.referee_id, u.minecraft_username, r.wagered_minor, r.revshare_paid_minor,
              r.revshare_claimable_minor,
              r.bonus_unlocked_at, r.bonus_paid_minor, u.discord_verified_at, r.created_at
         FROM referrals r JOIN users u ON u.id = r.referee_id
        WHERE r.referrer_id = $1
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [userId],
    );

    /* The caller's own side of the relationship: whether THEY were referred and how far their
     * wagering has moved the invite that brought them here. */
    const inbound = await db.query<{
      referrer_username: string;
      wagered_minor: string;
      bonus_unlocked_at: Date | null;
      revshare_paid_minor: string;
      revshare_claimable_minor: string;
      voided_at: Date | null;
    }>(
      `SELECT u.minecraft_username AS referrer_username, r.wagered_minor, r.bonus_unlocked_at,
              r.revshare_paid_minor, r.revshare_claimable_minor, r.voided_at
         FROM referrals r JOIN users u ON u.id = r.referrer_id
        WHERE r.referee_id = $1`,
      [userId],
    );

    const self = await db.query<{
      discord_username: string | null;
      discord_verified_at: Date | null;
      created_at: Date;
      referral_entry_used_at: Date | null;
    }>(
      `SELECT discord_username, discord_verified_at, created_at, referral_entry_used_at
         FROM users WHERE id = $1`,
      [userId],
    );

    /* What Settings may offer: the one invite-code entry. It is there when the entry has not been
     * used, the account is inside the age the operator allows, and either there is no inviter yet
     * ("enter") or the current one has not earned anything from this player ("change"). */
    const entryUsed = !!self.rows[0]?.referral_entry_used_at;
    const windowMs = config.referralLateEntryDays * DAY_MS;
    const accountAgeMs = Date.now() - (self.rows[0]?.created_at.getTime() ?? 0);
    const inboundRow = inbound.rows[0];
    const entryLocked = inboundRow ? referralIsLocked(inboundRow) : false;
    const entryAvailable =
      !entryUsed && windowMs > 0 && accountAgeMs >= 0 && accountAgeMs < windowMs && !entryLocked;

    const claims = await db.query<{ amount_minor: string; created_at: Date }>(
      `SELECT amount_minor, created_at
         FROM referral_claims
        WHERE referrer_id = $1
        ORDER BY created_at DESC
        LIMIT 25`,
      [userId],
    );

    /* The invite list is deliberately capped for the browser, but money totals must cover every
     * relationship: somebody with more than 200 referrals must see the same claimable amount the
     * claim endpoint will actually collect. */
    const totals = await db.query<ReferralTotalsRow>(
      `SELECT count(*)::text AS invites,
              count(*) FILTER (WHERE u.discord_verified_at IS NOT NULL)::text AS verified,
              count(*) FILTER (WHERE r.bonus_unlocked_at IS NOT NULL)::text AS unlocked,
              coalesce(sum(r.revshare_paid_minor), 0)::text AS revshare_paid_minor,
              /* Voided referrals are excluded from the CLAIMABLE total only. A figure the claim
                 endpoint will refuse to pay is not a balance, and showing one produces a button
                 that fails. The paid totals keep counting them, because that money really was
                 paid and erasing it would make the player's own history disagree with the
                 ledger. */
              coalesce(sum(r.revshare_claimable_minor)
                       FILTER (WHERE r.voided_at IS NULL), 0)::text AS revshare_claimable_minor,
              coalesce(sum(r.bonus_paid_minor), 0)::text AS bonus_paid_minor
         FROM referrals r JOIN users u ON u.id = r.referee_id
        WHERE r.referrer_id = $1`,
      [userId],
    );

    const milestone = config.referralBonusWagerMinor;
    const rows = invites.rows.map((row) => {
      const wagered = BigInt(row.wagered_minor);
      return {
        refereeId: row.referee_id,
        username: row.minecraft_username,
        discordVerified: !!row.discord_verified_at,
        wageredMinor: row.wagered_minor,
        // Clamped, so a referee past the threshold cannot render a bar beyond full.
        wagerRatio: milestone > 0n ? Math.min(1, Number(wagered) / Number(milestone)) : 1,
        revsharePaidMinor: row.revshare_paid_minor,
        revshareClaimableMinor: row.revshare_claimable_minor,
        revshareEarnedMinor: (
          BigInt(row.revshare_paid_minor) + BigInt(row.revshare_claimable_minor)
        ).toString(),
        bonusUnlocked: !!row.bonus_unlocked_at,
        bonusPaidMinor: row.bonus_paid_minor,
        joinedAt: row.created_at,
      };
    });

    const aggregate = totals.rows[0];
    const totalRevsharePaid = BigInt(aggregate?.revshare_paid_minor ?? '0');
    const totalRevshareClaimable = BigInt(aggregate?.revshare_claimable_minor ?? '0');
    const totalRevshare = totalRevsharePaid + totalRevshareClaimable;
    const totalBonus = BigInt(aggregate?.bonus_paid_minor ?? '0');

    const revsharePerMillion = revshareMinor(config, 1_000_000n);

    return {
      code,
      // Built here rather than in the browser so one origin is authoritative for the link that
      // gets pasted into public chat.
      link: `${config.appOrigin}/?ref=${code}`,
      terms: {
        bonusMinor: config.referralBonusMinor.toString(),
        bonusWagerMinor: milestone.toString(),
        revshareBps: config.referralRevshareBps,
        houseEdgeBps: config.houseEdgeBps,
        // What a referrer actually keeps per unit wagered, so the page never has to multiply two
        // rates together and get it wrong.
        revsharePerMillionMinor: revsharePerMillion.toString(),
        revshareWagerBps: Number((revsharePerMillion * 10_000n) / 1_000_000n),
      },
      self: {
        discordVerified: !!self.rows[0]?.discord_verified_at,
        discordUsername: self.rows[0]?.discord_username ?? null,
        referredBy: inbound.rows[0]?.referrer_username ?? null,
        codeEntry: {
          available: entryAvailable,
          mode: entryAvailable ? (inboundRow ? 'change' : 'enter') : null,
          used: entryUsed,
          locked: entryLocked,
        },
        ownWagerMinor: inbound.rows[0]?.wagered_minor ?? null,
        unlockedForReferrer: !!inbound.rows[0]?.bonus_unlocked_at,
      },
      totals: {
        invites: Number(aggregate?.invites ?? '0'),
        verified: Number(aggregate?.verified ?? '0'),
        unlocked: Number(aggregate?.unlocked ?? '0'),
        revshareMinor: totalRevshare.toString(),
        revsharePaidMinor: totalRevsharePaid.toString(),
        revshareClaimableMinor: totalRevshareClaimable.toString(),
        claimableMinor: totalRevshareClaimable.toString(),
        bonusMinor: totalBonus.toString(),
        earnedMinor: (totalRevshare + totalBonus).toString(),
      },
      claims: claims.rows.map((row) => ({
        amountMinor: row.amount_minor,
        createdAt: row.created_at,
      })),
      invites: rows,
    };
  });

  app.post(
    '/v1/referrals/claim',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      requireProgramme();
      const userId = requireUserId(request.authUser?.id);
      return db.transaction((client) => claimReferralRewards(client, userId));
    },
  );

  // ── choosing your own code ────────────────────────────────────────────────

  app.put(
    '/v1/referrals/code',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (request) => {
      requireProgramme();
      const body = parseWith(renameSchema, request.body);
      const userId = requireUserId(request.authUser?.id);
      const code = body.code.toUpperCase();

      const reserved = RESERVED_FRAGMENTS.find((word) => code.includes(word));
      if (reserved) {
        throw new AppError(
          400,
          'REFERRAL_CODE_RESERVED',
          `An invite code cannot contain "${reserved}"`,
        );
      }

      return db.transaction(async (client) => {
        /* The row is created if it does not exist yet. A player who has never opened the invite
         * page has no code row, and making them load one page before another would be a sequence
         * only the schema cares about. */
        await ensureReferralCode(client, userId);

        /* One statement decides it, rather than a SELECT followed by an UPDATE. Two players racing
         * for the same code leave a window between a check and a write that is exactly wide enough
         * for both of them to win it; a conditional UPDATE has no such window, and the unique index
         * is the backstop if one is ever introduced. */
        const renamed = await client.query<{ code: string }>(
          `UPDATE referral_codes SET code = $2
            WHERE user_id = $1
              AND NOT EXISTS (SELECT 1 FROM referral_codes WHERE code = $2 AND user_id <> $1)
            RETURNING code`,
          [userId, code],
        );
        if (!renamed.rows[0]) {
          conflict('REFERRAL_CODE_TAKEN', 'Somebody already has that code');
        }

        /* Existing referrals follow the rename through ON UPDATE CASCADE on referrals_code_fkey.
         * Nobody who already used the old link loses their referrer, and nobody has to be told to
         * re-send anything. */
        return { code, link: `${config.appOrigin}/?ref=${code}` };
      });
    },
  );

  /* ── the one invite-code entry for a registered player ──
   *
   * An invite LINK only counts for somebody who is signing up (auth.ts spends the code in the
   * transaction that creates the account). A player who already has an account may enter a code
   * ONCE, here, from Settings. The entry sets the inviter they never had, or swaps one that has not
   * earned anything yet; it is used up for good by `users.referral_entry_used_at`, written in the
   * same transaction.
   *
   * The age limit (REFERRAL_LATE_ENTRY_DAYS, default any age, 0 closes the entry) is a threshold
   * and a threshold has an edge. What keeps the entry cheap is everything else: it happens once,
   * nothing is back-dated (the referral counts wagers from the moment of entry), an inviter that
   * has already earned from the player is never swapped out from under the money, you cannot enter
   * your own code or one from somebody you invited, and staff can void a referral as before.
   */
  app.post(
    '/v1/referrals/attach',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request) => {
      requireProgramme();
      const body = parseWith(attachSchema, request.body);
      const userId = requireUserId(request.authUser?.id);
      const windowDays = config.referralLateEntryDays;
      if (windowDays <= 0) {
        throw new AppError(
          403,
          'REFERRAL_ENTRY_CLOSED',
          'An invite code can only be used while creating an account',
        );
      }

      return db.transaction(async (client) => {
        const account = await client.query<{
          status: string;
          created_at: Date;
          referral_entry_used_at: Date | null;
        }>(
          'SELECT status, created_at, referral_entry_used_at FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        const row = account.rows[0];
        if (!row || row.status !== 'active') {
          throw new AppError(403, 'ACCOUNT_RESTRICTED', 'This account cannot use an invite code');
        }
        if (row.referral_entry_used_at) {
          conflict('REFERRAL_ENTRY_USED', 'You have already used your one invite-code entry');
        }
        if (Date.now() - row.created_at.getTime() >= windowDays * DAY_MS) {
          throw new AppError(
            403,
            'REFERRAL_WINDOW_PASSED',
            'This account is too old to enter an invite code',
          );
        }

        const current = await client.query<{
          code: string;
          bonus_unlocked_at: Date | null;
          revshare_paid_minor: string;
          revshare_claimable_minor: string;
          voided_at: Date | null;
        }>(
          `SELECT code, bonus_unlocked_at, revshare_paid_minor, revshare_claimable_minor, voided_at
             FROM referrals WHERE referee_id = $1 FOR UPDATE`,
          [userId],
        );
        const existing = current.rows[0];
        if (existing && referralIsLocked(existing)) {
          conflict(
            'REFERRAL_LOCKED',
            'Your inviter has already earned from you, so the code can no longer be changed',
          );
        }
        if (existing && existing.code === body.code) {
          conflict('REFERRAL_SAME_CODE', 'That is already your inviter\u0027s code');
        }

        const owner = await client.query<{ user_id: string; name: string }>(
          `SELECT c.user_id, ${maskedName('u.minecraft_username')} AS name
             FROM referral_codes c JOIN users u ON u.id = c.user_id
            WHERE c.code = $1`,
          [body.code],
        );
        const inviter = owner.rows[0];
        if (!inviter) throw new AppError(404, 'REFERRAL_CODE_UNKNOWN', 'No invite code like that');
        if (inviter.user_id === userId) {
          throw new AppError(400, 'REFERRAL_OWN_CODE', 'That is your own invite code');
        }
        const loop = await client.query(
          'SELECT 1 FROM referrals WHERE referee_id = $1 AND referrer_id = $2',
          [inviter.user_id, userId],
        );
        if (loop.rows[0]) {
          conflict('REFERRAL_LOOP', 'That player was invited by you');
        }

        if (existing) {
          /* Progress toward the old inviter's bonus does not carry over: the new one starts at zero,
           * exactly as an entry made today would. */
          await client.query(
            `UPDATE referrals
                SET referrer_id = $2, code = $3, wagered_minor = 0, updated_at = now()
              WHERE referee_id = $1`,
            [userId, inviter.user_id, body.code],
          );
        } else {
          const inserted = await client.query(
            `INSERT INTO referrals (referee_id, referrer_id, code)
             VALUES ($1, $2, $3) ON CONFLICT (referee_id) DO NOTHING
             RETURNING referee_id`,
            [userId, inviter.user_id, body.code],
          );
          if (!inserted.rows[0]) {
            conflict('REFERRAL_ALREADY_SET', 'This account already has an inviter');
          }
        }
        await client.query(
          'UPDATE users SET referral_entry_used_at = now(), updated_at = now() WHERE id = $1',
          [userId],
        );
        return { attached: true, changed: !!existing, code: body.code, inviter: inviter.name };
      });
    },
  );

  // ── Discord verification ──────────────────────────────────────────────────

  app.post(
    '/v1/referrals/discord/start',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      requireProgramme();
      const userId = requireUserId(request.authUser?.id);

      const existing = await db.query<{ discord_verified_at: Date | null }>(
        'SELECT discord_verified_at FROM users WHERE id = $1',
        [userId],
      );
      if (existing.rows[0]?.discord_verified_at) {
        conflict('DISCORD_ALREADY_VERIFIED', 'This account already has a verified Discord');
      }

      /* The raw state goes to the browser; only its hash is stored. The value travels in a URL
       * that lands in browser history and in Discord's referer, so a database holding the raw
       * string would turn a log leak into a usable callback. */
      const state = randomToken(32);
      await db.query(
        `INSERT INTO discord_oauth_states (state_hash, user_id, expires_at)
         VALUES ($1, $2, now() + ($3::int * interval '1 millisecond'))`,
        [sha256Hex(state), userId, OAUTH_STATE_TTL_MS],
      );

      const authorize = new URL(DISCORD_AUTHORIZE_URL);
      authorize.searchParams.set('client_id', config.discordClientId);
      authorize.searchParams.set('redirect_uri', config.discordRedirectUri);
      authorize.searchParams.set('response_type', 'code');
      // identify alone. The programme needs to know the account is real and unique; it has no
      // business reading an email address or a guild list to do that.
      authorize.searchParams.set('scope', 'identify');
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('prompt', 'consent');
      return { authorizeUrl: authorize.toString(), expiresInMs: OAUTH_STATE_TTL_MS };
    },
  );

  /**
   * The callback Discord redirects the browser to.
   *
   * A GET with no CSRF header, because it is a top-level navigation the site did not issue. The
   * state parameter is the whole defence: it was minted for one session, it is single-use, and it
   * expires. Everything else — including which account gets verified — is read from the stored
   * row rather than from the request.
   */
  app.get(
    '/v1/referrals/discord/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      requireProgramme();
      const query = parseWith(callbackSchema, request.query);

      const claimed = await db.transaction(async (client) => {
        const state = await client.query<{ user_id: string }>(
          `UPDATE discord_oauth_states
              SET consumed_at = now()
            WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
            RETURNING user_id`,
          [sha256Hex(query.state)],
        );
        return state.rows[0]?.user_id;
      });
      if (!claimed) {
        return reply.redirect(`${config.appOrigin}/referrals?discord=expired`);
      }

      let identity: { id: string; username: string };
      try {
        identity = await exchangeDiscordCode(config, query.code);
      } catch {
        // Never surface Discord's own error text: it echoes back request parameters, and one of
        // those is the client secret's counterpart.
        return reply.redirect(`${config.appOrigin}/referrals?discord=failed`);
      }

      const outcome = await db.transaction(async (client) => {
        /* A Discord account already bound elsewhere is the abuse case the whole unique index
         * exists for, and it is checked explicitly so the player gets told rather than watching a
         * constraint violation become a 500. */
        const taken = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE discord_user_id = $1 AND id <> $2',
          [identity.id, claimed],
        );
        if (taken.rowCount) return 'taken' as const;

        await client.query(
          `UPDATE users
              SET discord_user_id = $2, discord_username = $3, discord_verified_at = now(),
                  updated_at = now()
            WHERE id = $1 AND discord_verified_at IS NULL`,
          [claimed, identity.id, identity.username],
        );

        /* No longer retests the milestone. Verifying Discord cannot complete the gate any more
           because the gate is the wager alone, so a call here could only ever return false — and a
           call that can only return false reads as a condition somebody forgot to remove. */
        return 'verified' as const;
      });

      return reply.redirect(`${config.appOrigin}/referrals?discord=${outcome}`);
    },
  );
}

/**
 * Trades the authorization code for a token, then reads the account behind it.
 *
 * The token is used once and dropped on the floor — the programme needs an identifier, not
 * ongoing access — so nothing is persisted and there is no refresh to manage.
 */
async function exchangeDiscordCode(
  config: AppConfig,
  code: string,
): Promise<{ id: string; username: string }> {
  const tokenResponse = await fetch(DISCORD_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.discordRedirectUri,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!tokenResponse.ok) throw new Error('Discord rejected the authorization code');
  const token = (await tokenResponse.json()) as { access_token?: unknown; token_type?: unknown };
  if (typeof token.access_token !== 'string' || typeof token.token_type !== 'string') {
    throw new Error('Discord returned an unusable token');
  }

  const userResponse = await fetch(DISCORD_USER_URL, {
    headers: { Authorization: `${token.token_type} ${token.access_token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!userResponse.ok) throw new Error('Discord refused the identity lookup');
  const user = (await userResponse.json()) as { id?: unknown; username?: unknown };
  if (typeof user.id !== 'string' || !/^[0-9]{5,32}$/.test(user.id)) {
    throw new Error('Discord returned an unusable account id');
  }
  /* The display name is cosmetic, attacker-chosen, and rendered on the referrals dashboard —
   * three properties that together mean it cannot be stored as it arrives. A Discord username is
   * whatever its owner typed, so truncation alone let control characters, bidi overrides and
   * tag-shaped text into a column that is read back into other people's pages.
   *
   * Rejecting is wrong here, unlike everywhere else this platform validates text: the user did not
   * type this into our form and cannot fix it without renaming themselves on another service, so a
   * refusal would strand a legitimate account mid-verification. The identifier is what the
   * programme actually needs; the label is decoration, so decoration that cannot be displayed
   * safely is replaced rather than allowed to block a verification. */
  const raw = typeof user.username === 'string' ? user.username.normalize('NFC').trim() : '';
  const username =
    raw.length > 0 && raw.length <= 64 && !containsUnsafeCharacters(raw) && !containsMarkup(raw)
      ? raw
      : 'discord user';
  return { id: user.id, username };
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
