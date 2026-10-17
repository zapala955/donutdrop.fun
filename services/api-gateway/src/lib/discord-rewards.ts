import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { sha256Hex } from './crypto.js';
import type { Database, DbClient } from './db.js';
import { AppError } from './errors.js';
import { liveEvents } from './live-events.js';
import { creditWallet } from './wallet.js';
import { addWagerRequirement, requirementFor } from './wager-requirements.js';

/**
 * discord-rewards.ts — what the Discord server pays, and the link that decides who gets it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE LINK
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A reward is paid to a site account for something a Discord account did, so the two have to be
 * tied together first. The OAuth flow in referrals.ts does that when the deployment has a Discord
 * client secret. This is the second way, for when it does not:
 *
 *   1. the signed-in site shows the player a short code (the session proves the site account);
 *   2. they type `/link <code>` in the server (Discord proves the snowflake on the interaction);
 *   3. the community bot passes both to the gateway over its signed channel.
 *
 * The code is minted for a session, never by the bot, so the bot cannot choose which site account
 * a Discord account lands on -- it can only report who typed a code the site handed out. The
 * honest limit: this path trusts the community bot to report the interaction truthfully, where
 * OAuth trusts nobody in between. Everything it can unlock is bounded below.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE REWARDS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   join    once per site account and once per Discord account, paid when the link is made.
 *   tag     for wearing the server's tag; the bot reports the tag. The first is paid the moment the
 *           tag is on. Every one after it needs the tag worn for 24 hours straight, counted from the
 *           later of the last tag reward and the moment the tag last went back on.
 *
 * There was an invite reward too, paid to whoever's invite brought a member in. It was removed on
 * 2026-10-08 at the operator's request; the rows it would have written stay readable in
 * discord_rewards and the ledger, and invite TRACKING (the leaderboard) is untouched.
 *
 * The join reward needs a Discord account older than the configured age. The age is read
 * from the snowflake itself, which encodes its creation time, so it does not rest on the bot's
 * word. Every reward adds to the wager requirement at the sign-up bonus's multiplier: playable at
 * once, withdrawable after it has been wagered, so farming them with alts pays nothing out.
 * The unique indexes on discord_rewards are the rules; these functions only decide what to try.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MINUTES = 10;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** When a Discord account was created, from its snowflake. */
export function snowflakeCreatedAt(snowflake: string): Date {
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS));
}

export function oldEnough(config: AppConfig, discordUserId: string, now = Date.now()): boolean {
  const ageMs = now - snowflakeCreatedAt(discordUserId).getTime();
  return ageMs >= config.discordRewardMinAccountAgeDays * 86_400_000;
}

/** Codes are typed by hand: upper case, no 0/O or 1/I/L, and spaces or dashes forgiven. */
export function normalizeLinkCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

/** Mints a code for a signed-in account, replacing any it had not used yet. */
export async function createLinkCode(
  db: Database,
  userId: string,
): Promise<{ code: string; expiresAt: string }> {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expires = await db.transaction(async (client) => {
    await client.query(
      'DELETE FROM discord_link_codes WHERE user_id = $1 AND consumed_at IS NULL',
      [userId],
    );
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO discord_link_codes (code_hash, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))
       RETURNING expires_at`,
      [sha256Hex(code), userId, CODE_TTL_MINUTES],
    );
    return inserted.rows[0]!.expires_at;
  });
  return { code, expiresAt: new Date(expires).toISOString() };
}

export interface RewardLine {
  readonly kind: 'join' | 'tag';
  readonly amountMinor: string;
  readonly to: 'you';
}

export interface LinkOutcome {
  readonly username: string;
  readonly rewards: RewardLine[];
  /** Why the join reward was not paid, when it was not. */
  readonly joinSkipped: string | null;
}

/**
 * Consumes a code and links the Discord account to the site account it was minted for, then pays
 * what the link unlocks. Idempotent for the same pair: linking an account to the Discord account it
 * is already linked to is not an error.
 */
export async function linkWithCode(
  db: Database,
  config: AppConfig,
  input: { code: string; discordUserId: string; discordUsername: string; guildId: string },
): Promise<LinkOutcome> {
  const outcome = await db.transaction(async (client) => {
    const claimed = await client.query<{ user_id: string }>(
      `UPDATE discord_link_codes SET consumed_at = now()
        WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [sha256Hex(normalizeLinkCode(input.code))],
    );
    const userId = claimed.rows[0]?.user_id;
    if (!userId) {
      throw new AppError(404, 'LINK_CODE_INVALID', 'That code is wrong or has expired');
    }

    const owner = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE discord_user_id = $1 AND id <> $2',
      [input.discordUserId, userId],
    );
    if (owner.rows[0]) {
      throw new AppError(
        409,
        'DISCORD_ALREADY_LINKED',
        'This Discord account is already linked to another site account',
      );
    }
    const account = await client.query<{
      minecraft_username: string;
      status: string;
      discord_user_id: string | null;
    }>('SELECT minecraft_username, status, discord_user_id FROM users WHERE id = $1 FOR UPDATE', [
      userId,
    ]);
    const row = account.rows[0];
    if (!row || row.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'That site account cannot be linked');
    }
    if (row.discord_user_id && row.discord_user_id !== input.discordUserId) {
      throw new AppError(
        409,
        'ACCOUNT_ALREADY_LINKED',
        'That site account is already linked to a different Discord account',
      );
    }
    if (!row.discord_user_id) {
      await client.query(
        `UPDATE users
            SET discord_user_id = $2, discord_username = $3, discord_verified_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [userId, input.discordUserId, input.discordUsername.slice(0, 64)],
      );
    }

    const rewards: RewardLine[] = [];
    const credited: string[] = [];
    const join = await payJoinReward(client, config, userId, input.discordUserId);
    if (join.paid) {
      rewards.push({ kind: 'join', amountMinor: join.paid.toString(), to: 'you' });
      credited.push(userId);
    }
    return { username: row.minecraft_username, rewards, joinSkipped: join.skipped, credited };
  });
  if (outcome.credited.length) liveEvents.publish('balance', [...new Set(outcome.credited)]);
  return { username: outcome.username, rewards: outcome.rewards, joinSkipped: outcome.joinSkipped };
}

async function credit(
  client: DbClient,
  config: AppConfig,
  userId: string,
  amount: bigint,
  kind: 'discord_join_reward' | 'discord_tag_reward',
  rewardId: string,
): Promise<void> {
  await creditWallet(client, userId, amount, kind, rewardId);
  await addWagerRequirement(
    client,
    userId,
    requirementFor(amount, config.signupBonusWagerMultiplier),
  );
}

async function payJoinReward(
  client: DbClient,
  config: AppConfig,
  userId: string,
  discordUserId: string,
): Promise<{ paid: bigint | null; skipped: string | null }> {
  const amount = config.discordJoinRewardMinor;
  if (!config.discordRewardsEnabled || amount <= 0n) return { paid: null, skipped: null };
  if (!oldEnough(config, discordUserId)) {
    return {
      paid: null,
      skipped: `Discord accounts younger than ${config.discordRewardMinAccountAgeDays} days get no join reward`,
    };
  }
  const id = randomUUID();
  const inserted = await client.query(
    `INSERT INTO discord_rewards (id, user_id, discord_user_id, kind, amount_minor)
     VALUES ($1, $2, $3, 'join', $4)
     ON CONFLICT DO NOTHING`,
    [id, userId, discordUserId, amount.toString()],
  );
  if (!inserted.rowCount) return { paid: null, skipped: 'The join reward was already paid' };
  await credit(client, config, userId, amount, 'discord_join_reward', id);
  return { paid: amount, skipped: null };
}

/** How long the tag must stay on, without a break, before each tag reward after the first. */
export const TAG_STREAK_HOURS = 24;
const TAG_STREAK_MS = TAG_STREAK_HOURS * 3_600_000;
/**
 * A sighting this long after the one before it starts a new streak, because nothing was watching in
 * between. The bot looks every ten minutes, so this only bites when it was down for hours.
 */
const SIGHTING_GAP_MINUTES = 120;
/** Who the bot keeps looking at: everybody who has collected a tag reward this recently. */
const TAG_WATCH_DAYS = 30;

export interface TagSighting {
  readonly discordUserId: string;
  readonly wearing: boolean;
}

/**
 * Records what the bot saw on some profiles, and returns since when each one has worn the tag
 * without a break (null while it is off).
 *
 * A streak survives a sighting only if the tag is still on and the last sighting was recent; the tag
 * coming off, or a long silence, ends it, and the next sighting of the tag on starts a new one.
 */
export async function recordTagSightings(
  client: DbClient,
  sightings: readonly TagSighting[],
): Promise<Map<string, Date | null>> {
  // Last word per account: one statement cannot update the same row twice.
  const latest = new Map(sightings.map((s) => [s.discordUserId, s.wearing]));
  if (!latest.size) return new Map();
  const result = await client.query<{ discord_user_id: string; wearing_since: Date | null }>(
    `INSERT INTO discord_tag_wear AS w (discord_user_id, wearing_since, observed_at)
     SELECT s.id, CASE WHEN s.wearing THEN now() END, now()
       FROM unnest($1::varchar[], $2::boolean[]) AS s(id, wearing)
     ON CONFLICT (discord_user_id) DO UPDATE SET
       wearing_since = CASE
         WHEN EXCLUDED.wearing_since IS NULL THEN NULL
         WHEN w.wearing_since IS NOT NULL
          AND w.observed_at >= now() - make_interval(mins => $3) THEN w.wearing_since
         ELSE now()
       END,
       observed_at = now()
     RETURNING discord_user_id, wearing_since`,
    [[...latest.keys()], [...latest.values()], SIGHTING_GAP_MINUTES],
  );
  return new Map(result.rows.map((row) => [row.discord_user_id, row.wearing_since]));
}

/** The Discord accounts the bot should keep checking: linked, and tag rewards collected lately. */
export async function tagWatchList(db: Database): Promise<string[]> {
  const result = await db.query<{ discord_user_id: string }>(
    `SELECT DISTINCT r.discord_user_id
       FROM discord_rewards r
       JOIN users u ON u.id = r.user_id AND u.discord_user_id = r.discord_user_id
      WHERE r.kind = 'tag' AND u.status = 'active'
        AND r.created_at > now() - make_interval(days => $1)
      LIMIT 5000`,
    [TAG_WATCH_DAYS],
  );
  return result.rows.map((row) => row.discord_user_id);
}

/** When the next tag reward opens: 24 hours on from the later of the last one and the streak's start. */
function tagDueAt(wearingSince: Date, lastClaim: Date): Date {
  return new Date(Math.max(wearingSince.getTime(), lastClaim.getTime()) + TAG_STREAK_MS);
}

/**
 * The reward for wearing the server's tag. The bot reports whether the member wears it -- the
 * gateway has no way to see a Discord profile -- and this decides whether it is paid now.
 *
 * The first is paid the moment the tag is on. After that the tag has to have been on for 24 hours
 * straight, which the sightings in discord_tag_wear vouch for.
 */
export async function claimTagReward(
  db: Database,
  config: AppConfig,
  input: { discordUserId: string; wearingTag: boolean },
): Promise<
  | { paid: true; amountMinor: string; username: string }
  | { paid: false; reason: string; nextAt?: string }
> {
  const amount = config.discordTagRewardMinor;
  if (!config.discordRewardsEnabled || amount <= 0n) {
    return { paid: false, reason: 'The tag reward is switched off' };
  }
  const result = await db.transaction(async (client) => {
    // What the bot just saw counts whatever is decided below: a claim with the tag off ends a streak.
    const sightings = await recordTagSightings(client, [
      { discordUserId: input.discordUserId, wearing: input.wearingTag },
    ]);
    const linked = await client.query<{ id: string; minecraft_username: string; status: string }>(
      'SELECT id, minecraft_username, status FROM users WHERE discord_user_id = $1',
      [input.discordUserId],
    );
    const user = linked.rows[0];
    if (!user || user.status !== 'active') return { outcome: 'unlinked' as const };
    /* Either side of the link counts as having claimed: relinking the Discord account to another
     * site account, or the site account to another Discord account, is not a new first time. */
    const previous = await client.query<{ last: Date | null; now: Date }>(
      `SELECT max(created_at) AS last, now() AS now FROM discord_rewards
        WHERE kind = 'tag' AND (user_id = $1 OR discord_user_id = $2)`,
      [user.id, input.discordUserId],
    );
    const lastClaim = previous.rows[0]?.last ?? null;
    const now = previous.rows[0]!.now;
    if (!input.wearingTag) return { outcome: 'not-wearing' as const, claimedBefore: lastClaim !== null };
    const since = sightings.get(input.discordUserId) ?? now;
    if (lastClaim) {
      const due = tagDueAt(since, lastClaim);
      if (due > now) {
        return { outcome: 'waiting' as const, due, restarted: since > lastClaim };
      }
    }
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO discord_rewards
         (id, user_id, discord_user_id, kind, reward_day, amount_minor)
       VALUES ($1, $2, $3, 'tag', (now() AT TIME ZONE 'UTC')::date, $4)
       ON CONFLICT DO NOTHING`,
      [id, user.id, input.discordUserId, amount.toString()],
    );
    // Another claim got in first; it is the one that counts.
    if (!inserted.rowCount) return { outcome: 'waiting' as const, due: new Date(now.getTime() + TAG_STREAK_MS), restarted: false };
    await credit(client, config, user.id, amount, 'discord_tag_reward', id);
    return { outcome: 'paid' as const, user };
  });
  switch (result.outcome) {
    case 'unlinked':
      return { paid: false, reason: 'Link your site account first with /link' };
    case 'not-wearing':
      return {
        paid: false,
        reason: result.claimedBefore
          ? 'Put the server tag back on your profile. Every reward after the first needs it worn for 24 hours straight'
          : 'Wear the server tag on your profile, then try again',
      };
    case 'waiting':
      return {
        paid: false,
        reason: result.restarted
          ? 'The 24 hours started again: the tag was not seen on the whole time since your last reward'
          : 'Every reward after the first needs the tag worn for 24 hours straight',
        nextAt: result.due.toISOString(),
      };
    case 'paid':
      liveEvents.publish('balance', [result.user.id]);
      return { paid: true, amountMinor: amount.toString(), username: result.user.minecraft_username };
  }
}

/** What the site shows a signed-in player on the Discord page. */
export async function rewardStatus(db: Database, config: AppConfig, userId: string) {
  const [account, rewards] = await Promise.all([
    db.query<{
      discord_user_id: string | null;
      discord_username: string | null;
      wearing_since: Date | null;
      wear_fresh: boolean | null;
    }>(
      `SELECT u.discord_user_id, u.discord_username, w.wearing_since,
              w.observed_at >= now() - make_interval(mins => $2) AS wear_fresh
         FROM users u
         LEFT JOIN discord_tag_wear w ON w.discord_user_id = u.discord_user_id
        WHERE u.id = $1`,
      [userId, SIGHTING_GAP_MINUTES],
    ),
    db.query<{ kind: string; n: string; total: string; today: boolean; last: Date }>(
      `SELECT kind, count(*)::text AS n, sum(amount_minor)::text AS total,
              bool_or(kind = 'tag' AND reward_day = (now() AT TIME ZONE 'UTC')::date) AS today,
              max(created_at) AS last
         FROM discord_rewards WHERE user_id = $1 GROUP BY kind`,
      [userId],
    ),
  ]);
  const by = new Map(rewards.rows.map((row) => [row.kind, row]));
  const linkedId = account.rows[0]?.discord_user_id ?? null;
  /* When the next tag reward opens, if it can be said: after a first reward, and while the tag is
   * seen to be on. Before the first there is nothing to wait for; with the tag off, nothing to count. */
  const lastTag = by.get('tag')?.last ?? null;
  const since = account.rows[0]?.wear_fresh ? (account.rows[0]?.wearing_since ?? null) : null;
  const tagNextAt = lastTag && since ? tagDueAt(since, lastTag).toISOString() : null;
  return {
    enabled: config.discordRewardsEnabled,
    linked: linkedId !== null,
    discordUsername: account.rows[0]?.discord_username ?? null,
    oauthAvailable: Boolean(config.discordClientId && config.discordRedirectUri),
    amounts: {
      joinMinor: config.discordJoinRewardMinor.toString(),
      tagMinor: config.discordTagRewardMinor.toString(),
    },
    minAccountAgeDays: config.discordRewardMinAccountAgeDays,
    join: { claimed: by.has('join') },
    tag: {
      claimedToday: by.get('tag')?.today === true,
      days: Number(by.get('tag')?.n ?? 0),
      streakHours: TAG_STREAK_HOURS,
      nextAt: tagNextAt,
    },
  };
}
