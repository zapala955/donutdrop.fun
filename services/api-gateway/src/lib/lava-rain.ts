import { randomInt } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { depositedWithin } from './code-drops.js';
import { serverTagState, type TagState } from './discord-tag.js';
import { AppError } from './errors.js';
import { compactMoney } from './win-card.js';

/**
 * lava-rain.ts — how big a drop is, who may claim one, and what the community bot is told about it.
 *
 * The owner, 2026-11-14: "i want the rains to be a random amount from 300m to 1.5b, 20x wager req
 * and send messages to the discord channel ... and make sure they have to wear the server tag, have
 * 25m deposited in the last 3 days to enter". The 20x is the rain lock (lib/wager-requirements.ts,
 * RAIN MONEY); the rest is here. The routes are in routes/social.ts and routes/community-bot.ts.
 */

type Queryable = Pick<DbClient, 'query'>;

const MILLION = 1_000_000n;
/* crypto.randomInt takes a range under 2^48. */
const RANDOM_SPAN = 2n ** 47n;

/**
 * A drop's pool, drawn at random between lavaRainPoolMinMinor and lavaRainPoolMaxMinor: in whole
 * millions whenever the range holds one ("$742M", never "$741,903,118"), to the unit otherwise.
 * Uniform over the range, from the system's CSPRNG: nobody can tell a big drop from a small one in
 * advance. `pick` is crypto.randomInt's signature, replaceable in tests.
 */
export function drawRainPool(
  config: Pick<AppConfig, 'lavaRainPoolMinMinor' | 'lavaRainPoolMaxMinor'>,
  pick: (min: number, max: number) => number = randomInt,
): bigint {
  let lo = config.lavaRainPoolMinMinor;
  let hi = config.lavaRainPoolMaxMinor;
  if (hi < lo) [lo, hi] = [hi, lo];
  const loM = (lo + MILLION - 1n) / MILLION;
  const hiM = hi / MILLION;
  if (hiM >= loM && hiM - loM < RANDOM_SPAN) {
    return (loM + BigInt(pick(0, Number(hiM - loM) + 1))) * MILLION;
  }
  if (hi - lo < RANDOM_SPAN) return lo + BigInt(pick(0, Number(hi - lo) + 1));
  return lo;
}

/* ═════════════════════ who may claim ═════════════════════ */

export interface RainEntry {
  /** Real deposits over the window, against the rule. Always met when the rule is 0. */
  readonly deposit: { requiredMinor: string; depositedMinor: string; windowHours: number; met: boolean };
  /** The server tag: whether it is asked, whether Discord is linked, and what Discord last said. */
  readonly tag: { required: boolean; linked: boolean; wearing: boolean | null; met: boolean };
}

/* A tag seen off is believed for this long by the card (never by a claim, which always asks):
 * every open card polls while a drop falls, and each poll would otherwise be a call to Discord. A
 * tag seen worn is remembered by lib/discord-tag.ts itself. */
const OFF_REMEMBERED_MS = 15_000;
const MAX_REMEMBERED = 5_000;
const seenOff = new Map<string, number>();

async function tagStateFor(
  config: AppConfig,
  discordUserId: string,
  how: 'fresh' | 'cached',
): Promise<TagState> {
  if (how === 'cached') {
    const at = seenOff.get(discordUserId);
    if (at !== undefined && Date.now() - at < OFF_REMEMBERED_MS) return 'not-wearing';
  }
  const state = await serverTagState(config, discordUserId, { fresh: how === 'fresh' });
  if (state === 'not-wearing') {
    if (seenOff.size >= MAX_REMEMBERED) seenOff.clear();
    seenOff.set(discordUserId, Date.now());
  } else {
    seenOff.delete(discordUserId);
  }
  return state;
}

/**
 * Where `userId` stands on the two entry rules. `tag` says how hard to look: 'skip' asks Discord
 * nothing (wearing is null), 'cached' lets a recent answer stand, 'fresh' always asks.
 */
export async function rainEntry(
  client: Queryable,
  config: AppConfig,
  userId: string,
  tag: 'skip' | 'cached' | 'fresh',
): Promise<RainEntry & { tagState: TagState | null }> {
  const required = config.lavaRainMinDepositMinor;
  const deposited = required > 0n ? await depositedWithin(client, userId, config.lavaRainDepositWindowHours) : 0n;
  const deposit = {
    requiredMinor: required.toString(),
    depositedMinor: deposited.toString(),
    windowHours: config.lavaRainDepositWindowHours,
    met: deposited >= required,
  };
  if (!config.lavaRainTagRequired) {
    return { deposit, tag: { required: false, linked: false, wearing: null, met: true }, tagState: null };
  }
  const found = await client.query<{ discord_user_id: string | null }>(
    'SELECT discord_user_id FROM users WHERE id = $1',
    [userId],
  );
  const discordUserId = found.rows[0]?.discord_user_id ?? null;
  if (!discordUserId) {
    return { deposit, tag: { required: true, linked: false, wearing: false, met: false }, tagState: null };
  }
  if (tag === 'skip') {
    return { deposit, tag: { required: true, linked: true, wearing: null, met: false }, tagState: null };
  }
  const state = await tagStateFor(config, discordUserId, tag);
  return {
    deposit,
    tag: { required: true, linked: true, wearing: state === 'unknown' ? null : state === 'wearing', met: state === 'wearing' },
    tagState: state,
  };
}

/** "3 days", "1 day", "36 hours". */
export function windowText(hours: number): string {
  if (hours % 24 !== 0) return `${hours} hours`;
  const days = hours / 24;
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Refuses a claim that breaks an entry rule, saying which and what to do about it. Asks Discord
 * afresh, so a tag put on a second ago counts; call it BEFORE the drop's row is locked, since every
 * other claimer waits on that lock.
 */
export async function assertRainEntry(client: Queryable, config: AppConfig, userId: string): Promise<void> {
  const entry = await rainEntry(client, config, userId, 'skip');
  if (!entry.deposit.met) {
    throw new AppError(
      403,
      'RAIN_NEEDS_DEPOSIT',
      `Lava Rain is for players who deposited ${compactMoney(config.lavaRainMinDepositMinor)} in the last ` +
        `${windowText(config.lavaRainDepositWindowHours)}. You have deposited ` +
        `${compactMoney(BigInt(entry.deposit.depositedMinor))}`,
      { requiredMinor: entry.deposit.requiredMinor, depositedMinor: entry.deposit.depositedMinor },
    );
  }
  if (!entry.tag.required) return;
  if (!entry.tag.linked) {
    throw new AppError(
      403,
      'RAIN_NEEDS_DISCORD',
      'Lava Rain is for players wearing the DonutLuxe server tag. Link your Discord first: /link in our Discord server',
    );
  }
  const checked = await rainEntry(client, config, userId, 'fresh');
  if (checked.tagState === 'wearing') return;
  if (checked.tagState === 'unknown') {
    throw new AppError(503, 'RAIN_TAG_UNKNOWN', 'Your Discord server tag could not be checked just now. Try again in a moment');
  }
  throw new AppError(
    403,
    'RAIN_NEEDS_TAG',
    'Lava Rain is for players wearing the DonutLuxe server tag. In Discord, open User Settings, then Profiles, ' +
      'then Server Tag, and pick DonutLuxe. Then claim again',
  );
}

/* ═════════════════════ what the community bot is told ═════════════════════ */

export interface RainPost {
  readonly id: string;
  readonly poolMinor: string;
  readonly status: 'open' | 'settled' | 'expired';
  readonly closesAt: string;
  readonly claimMinutes: number;
  readonly claimants: number;
  readonly perClaimMinor: string | null;
  readonly channelId: string | null;
  readonly messageId: string | null;
}

interface PostRow {
  id: string;
  pool_minor: string;
  status: 'open' | 'settled' | 'expired';
  opens_at: Date;
  closes_at: Date;
  claimant_count: number | null;
  per_claim_minor: string | null;
  discord_channel_id: string | null;
  discord_message_id: string | null;
  claims: string;
}

const POST_COLUMNS = `e.id, e.pool_minor::text AS pool_minor, e.status, e.opens_at, e.closes_at, e.claimant_count,
  e.per_claim_minor::text AS per_claim_minor, e.discord_channel_id, e.discord_message_id,
  (SELECT count(*) FROM lava_rain_claims c WHERE c.event_id = e.id)::text AS claims`;

function postView(row: PostRow): RainPost {
  return {
    id: row.id,
    poolMinor: row.pool_minor,
    status: row.status,
    closesAt: row.closes_at.toISOString(),
    claimMinutes: Math.max(1, Math.round((row.closes_at.getTime() - row.opens_at.getTime()) / 60_000)),
    claimants: row.status === 'open' ? Number(row.claims) : (row.claimant_count ?? 0),
    perClaimMinor: row.per_claim_minor,
    channelId: row.discord_channel_id,
    messageId: row.discord_message_id,
  };
}

/** The rules a post states, from the live settings. */
export function rainRules(config: AppConfig) {
  return {
    tagRequired: config.lavaRainTagRequired,
    minDepositMinor: config.lavaRainMinDepositMinor.toString(),
    depositWindowHours: config.lavaRainDepositWindowHours,
    minWageredMinor: config.lavaRainMinWageredMinor.toString(),
    wagerWindowMinutes: config.lavaRainWindowMinutes,
  };
}

/**
 * The bot's ask, every few seconds: the drop to post, if one is falling and no bot has taken it,
 * otherwise the latest drop of the last hour, so its post can be edited when it pays out. The first
 * ask that finds a drop unannounced takes it, and no other ask can.
 */
export async function rainPostTick(
  client: Queryable,
  config: AppConfig,
): Promise<{ readonly enabled: boolean; readonly rain: RainPost | null; readonly announce: boolean; readonly rules: ReturnType<typeof rainRules> }> {
  const rules = rainRules(config);
  if (!config.lavaRainEnabled) return { enabled: false, rain: null, announce: false, rules };
  const taken = await client.query<PostRow>(
    `UPDATE lava_rain_events e SET discord_announced_at = now()
      WHERE e.id = (SELECT id FROM lava_rain_events
                     WHERE status = 'open' AND closes_at > now() AND discord_announced_at IS NULL
                     ORDER BY opens_at LIMIT 1)
        AND e.discord_announced_at IS NULL
      RETURNING ${POST_COLUMNS}`,
  );
  if (taken.rows[0]) return { enabled: true, rain: postView(taken.rows[0]), announce: true, rules };
  const latest = await client.query<PostRow>(
    `SELECT ${POST_COLUMNS} FROM lava_rain_events e
      WHERE e.created_at > now() - interval '1 hour'
      ORDER BY e.opens_at DESC LIMIT 1`,
  );
  return { enabled: true, rain: latest.rows[0] ? postView(latest.rows[0]) : null, announce: false, rules };
}

/**
 * The bot's report on a drop it took: where its post is, or that posting failed, which hands the drop
 * back so a later ask tries again (only while nothing is recorded as posted).
 */
export async function recordRainPost(
  client: Queryable,
  input: { rainId: string } & ({ channelId: string; messageId: string } | { failed: true }),
): Promise<void> {
  if ('failed' in input) {
    await client.query(
      'UPDATE lava_rain_events SET discord_announced_at = NULL WHERE id = $1 AND discord_message_id IS NULL',
      [input.rainId],
    );
    return;
  }
  await client.query(
    'UPDATE lava_rain_events SET discord_channel_id = $2, discord_message_id = $3 WHERE id = $1',
    [input.rainId, input.channelId, input.messageId],
  );
}
