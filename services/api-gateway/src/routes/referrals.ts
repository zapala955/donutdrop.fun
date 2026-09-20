import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { ensureReferralCode, revshareMinor } from '../lib/referrals.js';
import { parseWith } from '../lib/validation.js';
import { containsMarkup, containsUnsafeCharacters } from '../lib/sanitize.js';

/**
 * Invite & Earn, and the Discord verification that gates half of it.
 *
 * Two payouts hang off one relationship. The revenue share accrues silently on every wager the
 * referee makes and is settled by the game routes themselves; nothing here pays it. What this
 * file owns is the relationship — who invited whom, and whether the two milestone conditions have
 * been met — plus the OAuth round trip that proves the Discord half.
 *
 * The dashboard reads from `referrals` rather than summing `referral_earnings`, because the row
 * is what the payout gate actually consults. A progress bar computed from a different source than
 * the gate is a progress bar that can reach 100% while the gate stays shut.
 */

const attachSchema = z.object({ code: z.string().regex(/^[A-Z0-9]{6,16}$/) }).strict();

/* Renaming takes the same alphabet as claiming, because the two have to agree: a code a player can
 * set but nobody can type into the attach endpoint is a link that never works. */
const renameSchema = z.object({ code: z.string().regex(/^[A-Z0-9]{6,16}$/) }).strict();

/**
 * Words a player may not build a code out of.
 *
 * An invite code is pasted into public chat beside a link to this site, so a code reading
 * DONUTDROPSUPPORT is not a vanity code, it is a costume. The check is on CONTAINMENT rather than
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
  bonus_unlocked_at: Date | null;
  bonus_paid_minor: string | null;
  discord_verified_at: Date | null;
  created_at: Date;
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
              r.bonus_unlocked_at, r.bonus_paid_minor, u.discord_verified_at, r.created_at
         FROM referrals r JOIN users u ON u.id = r.referee_id
        WHERE r.referrer_id = $1
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [userId],
    );

    /* The caller's own side of the relationship: whether THEY were referred, and whether their
     * own verification is still holding up somebody else's bonus. A referee who cannot see this
     * has no way to know that the person who invited them is waiting on one button. */
    const inbound = await db.query<{
      referrer_username: string;
      wagered_minor: string;
      bonus_unlocked_at: Date | null;
    }>(
      `SELECT u.minecraft_username AS referrer_username, r.wagered_minor, r.bonus_unlocked_at
         FROM referrals r JOIN users u ON u.id = r.referrer_id
        WHERE r.referee_id = $1`,
      [userId],
    );

    const self = await db.query<{
      discord_username: string | null;
      discord_verified_at: Date | null;
    }>('SELECT discord_username, discord_verified_at FROM users WHERE id = $1', [userId]);

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
        revshareEarnedMinor: row.revshare_paid_minor,
        bonusUnlocked: !!row.bonus_unlocked_at,
        bonusPaidMinor: row.bonus_paid_minor,
        joinedAt: row.created_at,
      };
    });

    const totalRevshare = invites.rows.reduce(
      (sum, row) => sum + BigInt(row.revshare_paid_minor),
      0n,
    );
    const totalBonus = invites.rows.reduce(
      (sum, row) => sum + BigInt(row.bonus_paid_minor ?? '0'),
      0n,
    );

    return {
      code,
      // Built here rather than in the browser so one origin is authoritative for the link that
      // gets pasted into public chat.
      link: `${config.appOrigin}/#/?ref=${code}`,
      terms: {
        bonusMinor: config.referralBonusMinor.toString(),
        bonusWagerMinor: milestone.toString(),
        revshareBps: config.referralRevshareBps,
        houseEdgeBps: config.houseEdgeBps,
        // What a referrer actually keeps per unit wagered, so the page never has to multiply two
        // rates together and get it wrong.
        revsharePerMillionMinor: revshareMinor(config, 1_000_000n).toString(),
      },
      self: {
        discordVerified: !!self.rows[0]?.discord_verified_at,
        discordUsername: self.rows[0]?.discord_username ?? null,
        referredBy: inbound.rows[0]?.referrer_username ?? null,
        ownWagerMinor: inbound.rows[0]?.wagered_minor ?? null,
        unlockedForReferrer: !!inbound.rows[0]?.bonus_unlocked_at,
      },
      totals: {
        invites: rows.length,
        verified: rows.filter((row) => row.discordVerified).length,
        unlocked: rows.filter((row) => row.bonusUnlocked).length,
        revshareMinor: totalRevshare.toString(),
        bonusMinor: totalBonus.toString(),
        earnedMinor: (totalRevshare + totalBonus).toString(),
      },
      invites: rows,
    };
  });

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
        return { code, link: `${config.appOrigin}/#/?ref=${code}` };
      });
    },
  );

  // ── claiming an invite ────────────────────────────────────────────────────

  app.post(
    '/v1/referrals/attach',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      requireProgramme();
      const body = parseWith(attachSchema, request.body);
      const userId = requireUserId(request.authUser?.id);

      return db.transaction(async (client) => {
        const owner = await client.query<{ user_id: string }>(
          'SELECT user_id FROM referral_codes WHERE code = $1',
          [body.code],
        );
        const referrerId = owner.rows[0]?.user_id;
        if (!referrerId) throw new AppError(404, 'REFERRAL_CODE_UNKNOWN', 'No such invite code');
        if (referrerId === userId) {
          throw new AppError(400, 'REFERRAL_SELF', 'You cannot use your own invite code');
        }

        /* One referrer per account, forever. ON CONFLICT DO NOTHING rather than an upsert: being
         * able to re-point an existing referral would let a player shop their own wager history
         * around to whoever paid them the most for it. */
        const inserted = await client.query(
          `INSERT INTO referrals (referee_id, referrer_id, code)
           VALUES ($1, $2, $3) ON CONFLICT (referee_id) DO NOTHING`,
          [userId, referrerId, body.code],
        );
        if (!inserted.rowCount) {
          conflict('REFERRAL_ALREADY_SET', 'This account already has a referrer');
        }

        /* The milestone gate is deliberately NOT tested here. A new row starts at zero wagered, so
         * only play that happens after the code is attached counts toward the threshold — a player
         * cannot wager their way to $25M first and then go shopping for a referrer to sell the
         * completed milestone to. The normal flow attaches the code on arrival, long before any of
         * it is wagered, so nobody legitimate loses anything to this. */
        return { attached: true };
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
        return reply.redirect(`${config.appOrigin}/#/referrals?discord=expired`);
      }

      let identity: { id: string; username: string };
      try {
        identity = await exchangeDiscordCode(config, query.code);
      } catch {
        // Never surface Discord's own error text: it echoes back request parameters, and one of
        // those is the client secret's counterpart.
        return reply.redirect(`${config.appOrigin}/#/referrals?discord=failed`);
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

      return reply.redirect(`${config.appOrigin}/#/referrals?discord=${outcome}`);
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
