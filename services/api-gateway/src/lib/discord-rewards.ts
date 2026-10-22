import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database, DbClient } from './db.js';
import { linkAccountToDiscord, linkedAccounts, mainAccount } from './discord-accounts.js';
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
 * tied together first. There is one way: the signed-in player presses Link Discord on the site and
 * authorizes the app on Discord (routes/discord-link.ts, linkDiscord below). The session proves the
 * site account and Discord proves the Discord account, with nobody in between.
 *
 * It replaced a link code (the site showed a code, the member typed it into the bot's `/link`),
 * which trusted the community bot to report the interaction truthfully. `/link` in the server now
 * points at the site, and for a member already linked it collects the join reward
 * (claimJoinReward below): being in the server is what that reward is for.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE REWARDS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   join    once per site account and once per Discord account, for a Discord that is in the
 *           community server: paid at the link when Discord says it is a member, or later by
 *           `/link` in the server.
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

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** When a Discord account was created, from its snowflake. */
export function snowflakeCreatedAt(snowflake: string): Date {
  return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS));
}

export function oldEnough(config: AppConfig, discordUserId: string, now = Date.now()): boolean {
  const ageMs = now - snowflakeCreatedAt(discordUserId).getTime();
  return ageMs >= config.discordRewardMinAccountAgeDays * 86_400_000;
}

export interface RewardLine {
  readonly kind: 'join' | 'tag';
  readonly amountMinor: string;
  readonly to: 'you';
}

export type LinkResult =
  | {
      readonly outcome: 'linked';
      /** The join reward paid with the link, if it was. */
      readonly joinPaidMinor: string | null;
      /** Why it was not, when it was not and could have been. */
      readonly joinSkipped: string | null;
      /** Linked, but Discord says the player is not in the server: the join reward waits for them. */
      readonly joinWaiting: boolean;
      /** Whether this account is the Discord's main one (the bot's rewards go to the main account). */
      readonly main: boolean;
      readonly accounts: number;
      readonly maxAccounts: number;
    }
  | { readonly outcome: 'limit' | 'taken' | 'inactive' };

/**
 * Links a signed-in account to the Discord that authorized the app, and pays the join reward when
 * Discord said the player is in the server. Idempotent for the same pair: linking an account to the
 * Discord it is already on is not an error, and the join reward is once per Discord and per account.
 *
 * The refusals are outcomes, not errors, because they are told to the player on the page Discord
 * sends them back to: a Discord already carrying the most accounts allowed (`limit`), an account
 * already on a different Discord (`taken`), an account that is suspended or closed (`inactive`).
 */
export async function linkDiscord(
  db: Database,
  config: AppConfig,
  input: { userId: string; discordUserId: string; discordUsername: string; member: boolean | null },
): Promise<LinkResult> {
  const { result, paid } = await db.transaction(
    async (client): Promise<{ result: LinkResult; paid: boolean }> => {
      const account = await client.query<{ status: string }>(
        'SELECT status FROM users WHERE id = $1 FOR UPDATE',
        [input.userId],
      );
      if (account.rows[0]?.status !== 'active') return { result: { outcome: 'inactive' }, paid: false };

      let link: Awaited<ReturnType<typeof linkAccountToDiscord>>;
      try {
        /* A Discord may carry several accounts (a main and its alts, migration 075); the limit, the
         * other-Discord refusal and which one is main are decided in lib/discord-accounts.ts. */
        link = await linkAccountToDiscord(client, config, input);
      } catch (error) {
        if (error instanceof AppError && error.code === 'DISCORD_ACCOUNT_LIMIT') {
          return { result: { outcome: 'limit' }, paid: false };
        }
        if (error instanceof AppError && error.code === 'ACCOUNT_ALREADY_LINKED') {
          return { result: { outcome: 'taken' }, paid: false };
        }
        throw error;
      }

      const join =
        input.member === true
          ? await payJoinReward(client, config, input.userId, input.discordUserId)
          : { paid: null, skipped: null };
      const joinable = config.discordRewardsEnabled && config.discordJoinRewardMinor > 0n;
      return {
        result: {
          outcome: 'linked',
          joinPaidMinor: join.paid?.toString() ?? null,
          joinSkipped: join.skipped,
          joinWaiting:
            joinable && input.member !== true && !(await joinRewardCollected(client, input)),
          main: link.main,
          accounts: link.accounts,
          maxAccounts: config.discordMaxAccounts,
        },
        paid: join.paid !== null,
      };
    },
  );
  if (paid) liveEvents.publish('balance', [input.userId]);
  return result;
}

/** Whether this Discord or this account has had its join reward already. */
async function joinRewardCollected(
  client: DbClient,
  input: { userId: string; discordUserId: string },
): Promise<boolean> {
  const found = await client.query(
    `SELECT 1 FROM discord_rewards
      WHERE kind = 'join' AND (user_id = $1 OR discord_user_id = $2) LIMIT 1`,
    [input.userId, input.discordUserId],
  );
  return (found.rowCount ?? 0) > 0;
}

export type JoinRewardResult =
  | { readonly linked: false }
  | {
      readonly linked: true;
      readonly username: string;
      readonly paidMinor: string | null;
      /** Why nothing was paid: already collected, too young a Discord, or rewards off. */
      readonly skipped: string | null;
    };

/**
 * `/link` in the server, for a member whose Discord is linked: the join reward, if it is still due.
 * Running a command in the server is the proof of membership the reward asks for. Paid to the
 * Discord's main account, as every reward the bot pays is.
 */
export async function claimJoinReward(
  db: Database,
  config: AppConfig,
  discordUserId: string,
): Promise<JoinRewardResult> {
  const result = await db.transaction(async (client) => {
    const main = await mainAccount(client, discordUserId);
    if (!main || main.status !== 'active') return { linked: false as const };
    const join = await payJoinReward(client, config, main.id, discordUserId);
    return {
      linked: true as const,
      userId: main.id,
      username: main.minecraft_username,
      paidMinor: join.paid?.toString() ?? null,
      skipped:
        join.skipped ??
        (join.paid ? null : 'Discord rewards are switched off at the moment'),
    };
  });
  if (!result.linked) return result;
  if (result.paidMinor) liveEvents.publish('balance', [result.userId]);
  return {
    linked: true,
    username: result.username,
    paidMinor: result.paidMinor,
    skipped: result.skipped,
  };
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
  if (!inserted.rowCount) {
    return { paid: null, skipped: 'The join reward was already paid to this Discord or this account' };
  }
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
    // Paid to the Discord's main account: /tag has a Discord in hand and no other way to choose.
    const user = await mainAccount(client, input.discordUserId);
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

/** What the site shows a signed-in player on the Discord page, and the bot shows for /rewards. */
export async function rewardStatus(db: Database, config: AppConfig, userId: string) {
  const account = await db.query<{
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
  );
  const linkedId = account.rows[0]?.discord_user_id ?? null;
  /* The Discord's rewards as well as the account's: they are once per Discord, so an alt linked to a
   * Discord that already collected the join reward must not be told it is still waiting. */
  const [rewards, accounts] = await Promise.all([
    db.query<{ kind: string; n: string; total: string; today: boolean; last: Date }>(
      `SELECT kind, count(*)::text AS n, sum(amount_minor)::text AS total,
              bool_or(kind = 'tag' AND reward_day = (now() AT TIME ZONE 'UTC')::date) AS today,
              max(created_at) AS last
         FROM discord_rewards WHERE user_id = $1 OR discord_user_id = $2 GROUP BY kind`,
      [userId, linkedId],
    ),
    linkedId ? linkedAccounts(db, linkedId) : Promise.resolve([]),
  ]);
  const by = new Map(rewards.rows.map((row) => [row.kind, row]));
  /* When the next tag reward opens, if it can be said: after a first reward, and while the tag is
   * seen to be on. Before the first there is nothing to wait for; with the tag off, nothing to count. */
  const lastTag = by.get('tag')?.last ?? null;
  const since = account.rows[0]?.wear_fresh ? (account.rows[0]?.wearing_since ?? null) : null;
  const tagNextAt = lastTag && since ? tagDueAt(since, lastTag).toISOString() : null;
  const main = accounts.find((linked) => linked.main) ?? accounts[0] ?? null;
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
    /* The accounts on this Discord (migration 075): whether this one is the main account the bot
     * pays /tag to, which one is, and how many more may be linked. */
    accounts: {
      count: accounts.length,
      max: config.discordMaxAccounts,
      main: Boolean(main && main.id === userId),
      mainUsername: main?.minecraftUsername ?? null,
    },
  };
}
