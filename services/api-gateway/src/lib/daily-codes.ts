import { randomInt } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database } from './db.js';
import { oldEnough } from './discord-rewards.js';
import { wageredFrom } from './cash-settlement.js';
import { liveEvents } from './live-events.js';
import { creditWallet } from './wallet.js';
import { addWagerRequirement, requirementFor } from './wager-requirements.js';

/**
 * daily-codes.ts — what a daily code is worth, and paying it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SHAPE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The community bot gives each opted-in member one personal code a day (a DM, once per UTC day).
 * Redeeming happens on the SITE, in a window, by a signed-in player: the route
 * (routes/discord-rewards.ts) passes the Discord account linked to that session, so the bot never
 * sees a balance and never picks a prize, and a code can only be spent by the site account whose
 * linked Discord it was sent to.
 *
 * A code is personal (only the Discord account it was sent to can redeem it), single-use, and good
 * for a day. It opens once the player has WAGERED a day's bar on the site (2M by default, counted
 * from 00:00 UTC of the day the code was sent): the code is the reason to come and play, not a
 * balance to collect. Below the bar the answer is `locked`, with how far they have got, and the
 * code is not touched. A site account can redeem one code a UTC day however many Discord accounts it has, and
 * the Discord account has to be old enough, like every other reward the server pays.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PRIZE, AND WHAT IT CAN COST
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * From nothing up to `dailyCodeMaxPrizeMinor`. The table below is fractions of that ceiling, so
 * moving the ceiling in the dashboard moves every prize with it and the odds stay the same. Over
 * half of all codes are worth nothing and the top prize is one in two thousand; the average is
 * about 0.58% of the ceiling (a little over half a million when the ceiling is 100M), and what
 * keeps that honest is not the table but three limits that do not depend on luck:
 *
 *   - a DAILY BUDGET: the day's prizes together never pass `dailyCodeBudgetMinor`. A prize that
 *     would is clipped to what is left, and once nothing is left a code is not spent -- it waits,
 *     still valid, until the pool refills at midnight UTC or it expires, whichever comes first;
 *   - the same WAGER REQUIREMENT every Discord reward carries: a prize is playable at once and
 *     withdrawable only after it has been wagered, so most of its face value comes back as house
 *     edge, and farming codes with alts pays nothing out;
 *   - one code per person per day, and a person is a verified Minecraft account.
 *
 * The one exception to "from nothing" is the WELCOME PRIZE: the first code a site account ever
 * redeems pays at least `dailyCodeFirstPrizeMinor` (5M by default), so turning codes on is worth
 * something on day one. "First" means neither that site account nor that Discord account has ever
 * redeemed a code, a code that won nothing included, so players who were already redeeming do not
 * get it and one Discord cannot collect it for a string of Minecraft accounts. It is never clipped
 * below the floor: if the day's pool cannot cover it, the code waits like any other, and because
 * nothing was redeemed the next code is still the first.
 *
 * Every draw uses the operating system's CSPRNG, and the prize is stored on the code row in the
 * same transaction that credits it, so the row is the whole record of what was won.
 */

/** Weights add up to 10_000, so each is a hundredth of a percent. */
export const PRIZE_TIERS: readonly { readonly fractionBps: number; readonly weight: number }[] = [
  { fractionBps: 0, weight: 5_500 }, //      nothing
  { fractionBps: 10, weight: 2_500 }, //     0.1% of the ceiling
  { fractionBps: 50, weight: 1_100 }, //     0.5%
  { fractionBps: 100, weight: 500 }, //      1%
  { fractionBps: 500, weight: 250 }, //      5%
  { fractionBps: 1_000, weight: 100 }, //    10%
  { fractionBps: 2_500, weight: 30 }, //     25%
  { fractionBps: 5_000, weight: 15 }, //     50%
  { fractionBps: 10_000, weight: 5 }, //     the ceiling
];
export const TOTAL_WEIGHT = PRIZE_TIERS.reduce((sum, tier) => sum + tier.weight, 0);

/** The long-run average prize as a fraction of the ceiling. */
export function expectedPrizeFraction(): number {
  return PRIZE_TIERS.reduce(
    (sum, tier) => sum + (tier.weight / TOTAL_WEIGHT) * (tier.fractionBps / 10_000),
    0,
  );
}

/** One draw. `roll` is injectable so the table can be tested exactly; production passes nothing. */
export function pickPrize(maxMinor: bigint, roll: number = randomInt(0, TOTAL_WEIGHT)): bigint {
  if (maxMinor <= 0n) return 0n;
  let cursor = 0;
  for (const tier of PRIZE_TIERS) {
    cursor += tier.weight;
    if (roll < cursor) return (maxMinor * BigInt(tier.fractionBps)) / 10_000n;
  }
  return 0n;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** What somebody typed or pasted, reduced to the code it names, or null if it is not one. */
export function normalizeDailyCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{8}$`).test(code) ? code : null;
}

export type RedeemResult =
  | { status: 'paid'; prizeMinor: string; username: string; wagerMinor: string; welcome: boolean }
  | { status: 'nothing'; username: string }
  | { status: 'locked'; wageredMinor: string; requiredMinor: string }
  | { status: 'refused'; reason: string; keepCode: boolean };

const refused = (reason: string, keepCode = false): RedeemResult => ({
  status: 'refused',
  reason,
  keepCode,
});

/** What a transaction hands back: the answer, and whose balance moved (if anybody's did). */
interface Settled {
  readonly result: RedeemResult;
  readonly userId: string | null;
}
const settled = (result: RedeemResult, userId: string | null = null): Settled => ({
  result,
  userId,
});

const UTC_DAY_START = `((now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC')`;

/**
 * Redeems a code for the Discord account that typed it.
 *
 * One transaction. The budget is read under an advisory lock so two redemptions at the same instant
 * cannot both spend the last of it, and the code row is locked FOR UPDATE so the same code cannot
 * be redeemed twice. The ledger credit is keyed on the code's own id, so even a replay of this
 * whole function could not pay it twice.
 */
export async function redeemDailyCode(
  db: Database,
  config: AppConfig,
  input: { discordUserId: string; code: string },
  /** For tests only: forces the draw (0 to TOTAL_WEIGHT - 1). Production never passes it. */
  roll?: number,
): Promise<RedeemResult> {
  if (!config.dailyCodesEnabled) return refused('Daily codes are switched off');
  const code = normalizeDailyCode(input.code);
  // The same words for "no such code" and "somebody else's code", so a guess learns nothing.
  if (!code) return refused('That is not a daily code. A code is eight letters and numbers.');

  const { result, userId } = await db.transaction(async (client): Promise<Settled> => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('daily-code-budget', 0))");

    const found = await client.query<{
      id: string;
      discord_user_id: string;
      redeemed_at: Date | null;
      expired: boolean;
      day_start: Date;
    }>(
      `SELECT id, discord_user_id, redeemed_at, (expires_at <= now()) AS expired,
              (issued_on::timestamp AT TIME ZONE 'UTC') AS day_start
         FROM discord_daily_codes WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const row = found.rows[0];
    if (!row || row.discord_user_id !== input.discordUserId) {
      return settled(refused('That code is not valid for you'));
    }
    if (row.redeemed_at) return settled(refused('That code has already been used'));
    if (row.expired) {
      return settled(refused('That code has expired. Today’s code is in your DMs'));
    }

    const linked = await client.query<{ id: string; minecraft_username: string; status: string }>(
      'SELECT id, minecraft_username, status FROM users WHERE discord_user_id = $1',
      [input.discordUserId],
    );
    const user = linked.rows[0];
    if (!user) {
      return settled(
        refused(
          'Link your Discord account to your site account first (the Discord page, then /link in the server). Your code is kept',
          true,
        ),
      );
    }
    if (user.status !== 'active') {
      return settled(
        refused('This account cannot redeem codes right now. Your code is kept', true),
      );
    }
    if (!oldEnough(config, input.discordUserId)) {
      return settled(
        refused(
          `Discord accounts younger than ${config.discordRewardMinAccountAgeDays} days cannot redeem daily codes`,
        ),
      );
    }
    const already = await client.query(
      `SELECT 1 FROM discord_daily_codes WHERE user_id = $1 AND redeemed_at >= ${UTC_DAY_START}`,
      [user.id],
    );
    if (already.rows[0]) {
      return settled(
        refused('This account has already redeemed a code today. Come back tomorrow', true),
      );
    }

    /* The bar. Below it nothing is drawn and the code is not touched: it waits, still valid. */
    if (config.dailyCodeMinWagerMinor > 0n) {
      const wagered = await wageredFrom(client, config, user.id, row.day_start);
      if (wagered < config.dailyCodeMinWagerMinor) {
        return settled({
          status: 'locked',
          wageredMinor: wagered.toString(),
          requiredMinor: config.dailyCodeMinWagerMinor.toString(),
        });
      }
    }

    /* The welcome prize's floor, for an account and a Discord that have never redeemed a code.
     * Capped at the budget, so a floor set above it live cannot hold every first code forever. */
    let floor = 0n;
    if (config.dailyCodeFirstPrizeMinor > 0n) {
      const before = await client.query(
        `SELECT 1 FROM discord_daily_codes
          WHERE redeemed_at IS NOT NULL AND (user_id = $1 OR discord_user_id = $2) LIMIT 1`,
        [user.id, input.discordUserId],
      );
      if (!before.rows[0]) {
        floor =
          config.dailyCodeFirstPrizeMinor < config.dailyCodeBudgetMinor
            ? config.dailyCodeFirstPrizeMinor
            : config.dailyCodeBudgetMinor;
      }
    }

    const spent = await client.query<{ spent: string }>(
      `SELECT COALESCE(SUM(prize_minor), 0)::text AS spent
         FROM discord_daily_codes WHERE redeemed_at >= ${UTC_DAY_START}`,
    );
    const remaining = config.dailyCodeBudgetMinor - BigInt(spent.rows[0]?.spent ?? '0');
    if (remaining <= 0n || remaining < floor) {
      return settled(
        refused('Today’s prize pool is used up. Your code stays valid until it expires', true),
      );
    }

    const drawn = pickPrize(config.dailyCodeMaxPrizeMinor, roll);
    const floored = drawn < floor ? floor : drawn;
    const prize = floored > remaining ? remaining : floored;

    const marked = await client.query(
      `UPDATE discord_daily_codes
          SET redeemed_at = now(), user_id = $2, prize_minor = $3
        WHERE id = $1 AND redeemed_at IS NULL`,
      [row.id, user.id, prize.toString()],
    );
    if (!marked.rowCount) return settled(refused('That code has already been used'));

    if (prize <= 0n) {
      return settled({ status: 'nothing', username: user.minecraft_username });
    }

    await creditWallet(client, user.id, prize, 'daily_code_reward', row.id);
    const owed = requirementFor(prize, config.signupBonusWagerMultiplier);
    await addWagerRequirement(client, user.id, owed);
    return settled(
      {
        status: 'paid',
        prizeMinor: prize.toString(),
        username: user.minecraft_username,
        wagerMinor: owed.toString(),
        welcome: floor > 0n,
      },
      user.id,
    );
  });

  // After the commit, so a card that refetches its balance sees the prize.
  if (result.status === 'paid' && userId) liveEvents.publish('balance', [userId]);
  return result;
}

/**
 * How far a player is towards the bar, for the redeem window to show before they try.
 *
 * Counted from 00:00 UTC of the day of their oldest code that is still good, or of today when they
 * have none: the same starting point `redeemDailyCode` uses for that code, so the window and the
 * answer cannot disagree.
 */
export async function dailyCodeProgress(
  client: Pick<Database, 'query'>,
  config: AppConfig,
  userId: string,
  discordUserId: string | null,
): Promise<{ requiredMinor: string; wageredMinor: string; hasCode: boolean }> {
  const required = config.dailyCodeMinWagerMinor;
  const code = discordUserId
    ? await client.query<{ day_start: Date }>(
        `SELECT (issued_on::timestamp AT TIME ZONE 'UTC') AS day_start
           FROM discord_daily_codes
          WHERE discord_user_id = $1 AND redeemed_at IS NULL AND expires_at > now()
          ORDER BY issued_on LIMIT 1`,
        [discordUserId],
      )
    : null;
  const now = new Date();
  const since =
    code?.rows[0]?.day_start ??
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const wagered = required > 0n ? await wageredFrom(client, config, userId, since) : 0n;
  return {
    requiredMinor: required.toString(),
    wageredMinor: wagered.toString(),
    hasCode: Boolean(code?.rows[0]),
  };
}
