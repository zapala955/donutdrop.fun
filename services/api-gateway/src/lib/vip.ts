import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';

/**
 * The 30-level VIP ladder.
 *
 * Six major tiers of five sub-levels each. A player's level is a pure function of one number —
 * lifetime wagered volume — and the only thing a level grants is a rakeback rate. No other perk
 * hangs off it, deliberately: every additional reward type is another claim on the same house
 * margin, and a ladder that grants several of them cannot be reasoned about at a glance.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RATE IS A PERCENTAGE OF WAGER, NOT OF MARGIN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This is the single most important line in the file, because the OTHER rakeback system on this
 * platform — the four instant/daily/weekly/monthly tiers in rewards.ts — is a percentage of the
 * house MARGIN. The two are not the same base and must never be confused.
 *
 *   VIP rakeback   2.00% of WAGER   = 20% of a 10% crate margin
 *   tier rakeback  2.00% of MARGIN  =  0.2% of wager
 *
 * The VIP scale is specified against the house edge it has to leave intact — "2.0% max, to
 * preserve the 10% house edge" — and that sentence only constrains anything if the rate shares a
 * base with the edge. So: percentage of wager, capped at 2%, leaving 8 points of a 10-point crate
 * margin before anything else is taken.
 *
 * The upgrader runs a 5% edge, not 10%. At the cap, VIP rakeback alone returns 40% of an upgrader
 * round's margin. That is solvent but it is not roomy, and it is why assertVipSolvency below runs
 * at boot against the WORST edge on the platform rather than the best.
 */

export const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'high_roller'] as const;
export type VipTierName = (typeof TIERS)[number];

export const SUB_LEVELS = ['I', 'II', 'III', 'IV', 'V'] as const;

export interface VipLevel {
  /** 1-30, ascending. The canonical identifier for a level. */
  readonly level: number;
  readonly tier: VipTierName;
  readonly tierLabel: string;
  readonly sub: (typeof SUB_LEVELS)[number];
  /** "Gold III" — what the badge renders. */
  readonly label: string;
  /** Lifetime wager at which this level is reached, in minor units. */
  readonly thresholdMinor: bigint;
  /** Rakeback in basis points OF WAGER. 10 = 0.10%, 200 = 2.00%. */
  readonly rakebackBps: number;
}

/**
 * Thresholds are spaced geometrically inside each tier's wager band and then rounded to figures a
 * human can read, rather than being computed from a formula at runtime.
 *
 * Hard-coding the resulting table is deliberate. A player's level, and therefore the rate they are
 * paid, must be reproducible from the source alone — if the ladder were derived from exponents at
 * call time then a rounding change anywhere in that expression would silently move thirty
 * thresholds and reprice every VIP on the platform. Thirty explicit numbers can be diffed.
 *
 * Bronze starts at zero, which no geometric series can, so its five steps are spaced by hand to
 * reach the 50,000,000 handover at Silver I.
 *
 * Rates follow the specified per-tier increments exactly:
 *   bronze      +0.040% per sub-level   0.10% -> 0.26%
 *   silver      +0.050%                 0.30% -> 0.50%
 *   gold        +0.075%                 0.55% -> 0.85%
 *   platinum    +0.075%                 0.90% -> 1.20%
 *   diamond     +0.0875%                1.25% -> 1.60%
 *   high_roller +0.0875%                1.65% -> 2.00%
 */

/**
 * Rates are held as hundredths of a basis point so every value on the ladder is an exact integer.
 *
 * The increments the ladder is specified with — 0.075% and 0.0875% per sub-level — are not whole
 * basis points. Storing basis points would force a rounding decision on twenty of the thirty
 * levels, and rounding a rate that multiplies every wager a player ever makes is not a rounding
 * anybody should do implicitly. At this scale 2.00% is 20000 and 0.0875% is 875, both exact.
 */
export const RATE_SCALE = 1_000_000n;

interface TierSpec {
  readonly tier: VipTierName;
  readonly label: string;
  /** Entry thresholds for sub-levels I..V, in minor units. */
  readonly thresholds: readonly [bigint, bigint, bigint, bigint, bigint];
  /** Rate at sub-level I, in hundredths of a basis point. */
  readonly baseRate: number;
  /** Increment per sub-level, in hundredths of a basis point. */
  readonly step: number;
}

const M = 1_000_000n;
const B = 1_000_000_000n;

const TIER_SPECS: readonly TierSpec[] = [
  {
    tier: 'bronze',
    label: 'Bronze',
    thresholds: [0n, 1n * M, 5n * M, 15n * M, 30n * M],
    baseRate: 1_000, // 0.10%
    step: 400, // +0.04%
  },
  {
    tier: 'silver',
    label: 'Silver',
    thresholds: [50n * M, 70n * M, 95n * M, 130n * M, 180n * M],
    baseRate: 3_000, // 0.30%
    step: 500, // +0.05%
  },
  {
    tier: 'gold',
    label: 'Gold',
    thresholds: [250n * M, 345n * M, 475n * M, 655n * M, 905n * M],
    baseRate: 5_500, // 0.55%
    step: 750, // +0.075%
  },
  {
    tier: 'platinum',
    label: 'Platinum',
    thresholds: [1_250n * M, 1_650n * M, 2_175n * M, 2_875n * M, 3_800n * M],
    baseRate: 9_000, // 0.90%
    step: 750, // +0.075%
  },
  {
    tier: 'diamond',
    label: 'Diamond',
    thresholds: [5n * B, 6_900n * M, 9_500n * M, 13_100n * M, 18_100n * M],
    baseRate: 12_500, // 1.25%
    step: 875, // +0.0875%
  },
  {
    tier: 'high_roller',
    label: 'High Roller',
    thresholds: [25n * B, 33n * B, 43_500n * M, 57_500n * M, 76n * B],
    baseRate: 16_500, // 1.65%
    step: 875, // +0.0875%
  },
];

/** The ladder, built once at module load. Ascending by level and by threshold. */
export const LADDER: readonly VipLevel[] = TIER_SPECS.flatMap((spec, tierIndex) =>
  SUB_LEVELS.map((sub, subIndex) => ({
    level: tierIndex * SUB_LEVELS.length + subIndex + 1,
    tier: spec.tier,
    tierLabel: spec.label,
    sub,
    label: `${spec.label} ${sub}`,
    thresholdMinor: spec.thresholds[subIndex]!,
    rakebackBps: spec.baseRate + spec.step * subIndex,
  })),
);

/** The ceiling the whole ladder is designed around: High Roller V. */
export const MAX_RATE = LADDER[LADDER.length - 1]!.rakebackBps;

/**
 * The level a given lifetime wager has earned.
 *
 * Walks down from the top so that the first threshold at or below the total wins; a player
 * between two thresholds keeps the lower level, which is what "reached" means. Never returns
 * undefined: Bronze I sits at zero, so every possible total lands somewhere on the ladder.
 */
export function levelFor(wageredMinor: bigint): VipLevel {
  for (let index = LADDER.length - 1; index >= 0; index -= 1) {
    const level = LADDER[index]!;
    if (wageredMinor >= level.thresholdMinor) return level;
  }
  return LADDER[0]!;
}

/** The next level up, or null at the top of the ladder. */
export function nextLevelFor(wageredMinor: bigint): VipLevel | null {
  const current = levelFor(wageredMinor);
  return LADDER[current.level] ?? null;
}

/**
 * What one wager earns its player in VIP rakeback, at their current rate.
 *
 * Integer division truncates, so a wager too small to produce a whole unit earns nothing. That is
 * correct and it is the same choice every other rate on this platform makes: the alternative
 * rounds a fraction of a unit up on every round, several million times a day, and every one of
 * those roundings is the house paying for arithmetic.
 */
export function vipRakebackMinor(rakebackBps: number, wagerMinor: bigint): bigint {
  if (wagerMinor <= 0n || rakebackBps <= 0) return 0n;
  return (wagerMinor * BigInt(rakebackBps)) / RATE_SCALE;
}

/**
 * What one wager did to a player's standing.
 *
 * `before` and `after` are equal on the overwhelming majority of wagers; they differ only on the
 * one that crosses a threshold, which is the wager worth announcing.
 */
export interface VipProgressEvent {
  readonly before: VipLevel;
  readonly after: VipLevel;
  readonly totalMinor: bigint;
}

/** Progress through the current level toward the next, as a 0-1 ratio and the gap remaining. */
export function progressFor(wageredMinor: bigint): {
  current: VipLevel;
  next: VipLevel | null;
  ratio: number;
  remainingMinor: bigint;
} {
  const current = levelFor(wageredMinor);
  const next = nextLevelFor(wageredMinor);
  if (!next) return { current, next: null, ratio: 1, remainingMinor: 0n };

  const span = next.thresholdMinor - current.thresholdMinor;
  const done = wageredMinor - current.thresholdMinor;
  /* Guard the span rather than trusting the table: a zero span would be a duplicated threshold,
   * and dividing by it would render NaN into a progress bar instead of failing where it can be
   * seen. The ladder test asserts thresholds are strictly ascending, so this is belt and braces. */
  const ratio = span > 0n ? Math.min(1, Math.max(0, Number(done) / Number(span))) : 0;
  return { current, next, ratio, remainingMinor: next.thresholdMinor - wageredMinor };
}

/**
 * Refuses a configuration whose combined giveback could exceed the margin it is drawn from.
 *
 * Run at boot rather than discovered in a ledger. Every rate below is converted to a share of the
 * WAGER so they can be added at all — the VIP ladder is priced off the wager and the tier
 * rakeback and referral share are priced off the margin, and adding those two numbers directly
 * would be meaningless.
 *
 * Checked against the SMALLEST edge on the platform, not the largest. The crate edge is 10% and
 * the upgrader's is 5%; a giveback that is comfortable against the first is twice as expensive
 * against the second, and it is the second that decides whether the platform is solvent.
 */
export function assertVipSolvency(config: AppConfig): void {
  if (!config.vipEnabled) return;

  /* The upgrader's edge, as a fraction of wager in hundredths of a basis point.
   *
   * This is the platform's SMALLEST edge and therefore the one that decides solvency. Crates run a
   * 10% edge, but that figure is a constant inside the seed script rather than configuration, so
   * it cannot move at runtime and cannot be the binding constraint here. The configured 5% can
   * move, it is half the crate edge, and a giveback that survives it survives everything. */
  const worstEdge = BigInt(config.houseEdgeBps) * 100n;

  const vipShare = BigInt(MAX_RATE);

  // The four tier rakebacks are shares of the margin, so their cost in wager terms scales with
  // the edge they are drawn from.
  const tierBps = config.rakebackEnabled
    ? Object.values(config.rakebackTierBps).reduce((sum, bps) => sum + bps, 0)
    : 0;
  /* An approved creator can replace the default referral rate with the programme ceiling. Size
   * the platform against that ceiling, not today's ordinary rate, or the admin panel could approve
   * a perfectly valid creator application that makes the combined giveback insolvent. */
  const referralBps = config.referralsEnabled
    ? Math.max(
        config.referralRevshareBps,
        config.creatorProgrammeEnabled ? config.creatorMaxRevshareBps : 0,
      )
    : 0;
  const marginShare = ((BigInt(tierBps) + BigInt(referralBps)) * worstEdge) / 10_000n;

  /* The vault jackpot is a share of WAGER, like the VIP rate and unlike the four tiers, so it adds
   * to the total in wager terms directly. It is money the house sets aside out of its own margin on
   * every round; a jackpot nobody counted here is exactly how a promotion bankrupts a house six
   * months after it launches.
   *
   * Lava rain is deliberately absent: it is an operator-funded discretionary drop with no automatic
   * per-wager accrual, so there is no rate to be solvent about. Its exposure is bounded by
   * LAVA_RAIN_MAX_POOL_MINOR instead. */
  const jackpotShare = config.vaultJackpotEnabled
    ? BigInt(config.vaultJackpotContributionBps) * 100n
    : 0n;

  const total = vipShare + marginShare + jackpotShare;
  if (total >= worstEdge) {
    throw new Error(
      `VIP rakeback is not solvent: combined giveback of ${Number(total) / 10_000}% of wager ` +
        `meets or exceeds the ${Number(worstEdge) / 10_000}% house edge it is paid from. ` +
        'Lower the VIP ceiling, the tier rakeback rates, or the referral share.',
    );
  }
}

/**
 * Adds a wager to the player's lifetime total and returns the new total plus whether the wager
 * crossed a level boundary.
 *
 * The running total is a row rather than an aggregate over the round history, for the same reason
 * the referral and race counters are: this runs inside the settlement of every case open and every
 * upgrader pull, and a scan over all history would grow without bound.
 *
 * Returns the level BEFORE and AFTER so the caller can tell a player they levelled up. Nothing in
 * here decides to announce it — that is a route's job — but only this function is positioned to
 * know it happened.
 */
export async function recordVipWager(
  client: DbClient,
  config: AppConfig,
  userId: string,
  wagerMinor: bigint,
): Promise<VipProgressEvent | null> {
  if (!config.vipEnabled || wagerMinor <= 0n) return null;

  /* One statement: insert the row if this is the player's first wager, otherwise add to it, and
   * return the total both before and after so the level comparison needs no second read. */
  const result = await client.query<{ before_minor: string; after_minor: string }>(
    `INSERT INTO user_wager_totals (user_id, wagered_minor)
     VALUES ($1, $2::bigint)
     ON CONFLICT (user_id) DO UPDATE
       SET wagered_minor = user_wager_totals.wagered_minor + EXCLUDED.wagered_minor,
           updated_at = now()
     RETURNING (user_wager_totals.wagered_minor - $2::bigint)::text AS before_minor,
               user_wager_totals.wagered_minor::text AS after_minor`,
    [userId, wagerMinor.toString()],
  );
  const row = result.rows[0];
  if (!row) return null;

  const totalMinor = BigInt(row.after_minor);
  const before = levelFor(BigInt(row.before_minor));
  const after = levelFor(totalMinor);

  /* The rate is read from the level the wager LANDED on, so a wager that crosses a boundary is
   * itself paid at the new rate. Paying the old rate on the crossing wager would be defensible
   * too, but it makes the first round after a level-up quietly worth less than the next one, and
   * that is the round the player is watching. */
  const earned = vipRakebackMinor(after.rakebackBps, wagerMinor);
  if (earned > 0n) {
    await client.query(
      `INSERT INTO rakeback_accruals (user_id, tier, accrued_minor)
       VALUES ($1, 'vip', $2::bigint)
       ON CONFLICT (user_id, tier) DO UPDATE
         SET accrued_minor = rakeback_accruals.accrued_minor + EXCLUDED.accrued_minor,
             updated_at = now()`,
      [userId, earned.toString()],
    );
  }

  return { before, after, totalMinor };
}
