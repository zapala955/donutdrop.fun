/**
 * Vault yield: what the site owes a player for leaving a lot alone.
 *
 * Accrual is a pure function of the lot's baseline value, the whole days it has sat since its
 * anchor, the daily rate, and the cap. Nothing is written by a scheduled job, so there is no tick
 * to miss, no retry to double-credit, and no drift between what the database holds and what a
 * reader computes. Two callers on two machines get the same number for the same lot.
 *
 * The money never touches catalog_items.unit_value_minor. Item prices are fixed and shared; this
 * is a cash entitlement that rides alongside the lot and settles out of the wallet.
 */

const BPS = 10_000n;
const MILLISECONDS_PER_DAY = 86_400_000;

export interface YieldTerms {
  /** Daily growth in basis points. 100 = +1% per day. */
  ratePerDayBps: number;
  /** Hard ceiling on total accrual, in basis points of the baseline. 3000 = +30%, ever. */
  capBps: number;
}

export interface YieldInput extends YieldTerms {
  /** Unit price of the item, in minor units. Fixed, server-priced, never derived from the lot. */
  baselineValueMinor: bigint;
  quantity: number;
  anchorAt: Date;
  now: Date;
  /** Yield already paid out on this lot, which counts against the same cap. */
  claimedMinor: bigint;
}

export interface YieldResult {
  /** Whole days credited by this accrual. Zero means nothing is owed yet. */
  elapsedDays: number;
  /** Total accrual the lot has earned since its anchor, before subtracting what was paid. */
  grossMinor: bigint;
  /** What is claimable right now: gross, less anything already paid, less anything over the cap. */
  claimableMinor: bigint;
  /** The ceiling this lot can ever reach, across all claims. */
  capMinor: bigint;
  /** True once claimed + claimable has reached the cap: this lot is done earning. */
  capped: boolean;
}

/**
 * Whole days only. A lot that has sat for 23 hours has earned nothing, and a lot that has sat for
 * 47 hours has earned one day. Partial days would make the number move every time it is read,
 * which turns a balance into a ticker and invites a player to reload for a better one.
 */
export function elapsedWholeDays(anchorAt: Date, now: Date): number {
  const elapsed = now.getTime() - anchorAt.getTime();
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.floor(elapsed / MILLISECONDS_PER_DAY);
}

/**
 * Compounds daily on the baseline, in integer basis points, one day at a time.
 *
 * The loop is deliberate. A closed form would need floating point, and floating point in a money
 * path is how a payout ends in .9999999 and a CHECK constraint rejects a legitimate claim. The
 * iteration count is bounded hard by the cap: at +1% a day a 30% ceiling is reached in 27 days,
 * so this runs a few dozen times at most and stops the moment it is pointless to continue.
 */
export function accrualFactorBps(ratePerDayBps: number, capBps: number, days: number): bigint {
  const rate = BigInt(Math.trunc(ratePerDayBps));
  const cap = BigInt(Math.trunc(capBps));
  if (rate <= 0n || cap <= 0n || days <= 0) return 0n;

  let growthBps = 0n;
  for (let day = 0; day < days; day += 1) {
    // each day earns the rate on the baseline plus on everything earned so far
    growthBps += ((BPS + growthBps) * rate) / BPS;
    if (growthBps >= cap) return cap;
  }
  return growthBps;
}

export function computeYield(input: YieldInput): YieldResult {
  const { baselineValueMinor, quantity, anchorAt, now, claimedMinor, ratePerDayBps, capBps } =
    input;

  const lotValue = baselineValueMinor * BigInt(Math.trunc(quantity));
  const capMinor = (lotValue * BigInt(Math.trunc(capBps))) / BPS;
  const elapsedDays = elapsedWholeDays(anchorAt, now);

  if (lotValue <= 0n || capMinor <= 0n || elapsedDays <= 0) {
    return {
      elapsedDays: 0,
      grossMinor: 0n,
      claimableMinor: 0n,
      capMinor,
      capped: capMinor > 0n && claimedMinor >= capMinor,
    };
  }

  const grossMinor = (lotValue * accrualFactorBps(ratePerDayBps, capBps, elapsedDays)) / BPS;

  // The cap is on the lot's lifetime earnings, not on any single claim, so what was already paid
  // is subtracted before the ceiling is applied rather than after.
  const headroom = capMinor > claimedMinor ? capMinor - claimedMinor : 0n;
  const unpaid = grossMinor > claimedMinor ? grossMinor - claimedMinor : 0n;
  const claimableMinor = unpaid > headroom ? headroom : unpaid;

  return {
    elapsedDays,
    grossMinor,
    claimableMinor,
    capMinor,
    capped: claimedMinor + claimableMinor >= capMinor,
  };
}
