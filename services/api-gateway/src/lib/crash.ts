import { createFairRoll } from '@donut/provably-fair';

/**
 * Crash — one shared multiplier that climbs from 1.00x until it busts.
 *
 * ── the edge ──
 * The crash point C is drawn so that, for every multiplier x on the 0.01 grid,
 *
 *     P(C ≥ x) = (1 − edge) / x.
 *
 * A bet that cashes out at x therefore returns x · (1 − edge) / x = 1 − edge of the stake on
 * average, whatever x is. That is the whole design: the edge does not depend on the player's
 * strategy, because every strategy — an auto target, a manual click, a target drawn at random — is
 * some choice of x made before the bust is known, and every x returns the same 90%.
 *
 * With a 10% edge, 1 round in about 9.2 busts at 1.00x (P = 1 − 0.9/1.01). Those rounds are where
 * the edge lives; nothing on the payout side is skimmed.
 *
 * ── what a manual cash-out is paid ──
 * The multiplier at the moment the server receives the request, floored to 0.01, and always below
 * the crash point. Latency can only move a click later on the curve, never earlier, so it can only
 * cost the player, never the house.
 *
 * ── the curve ──
 * m(t) = e^(GROWTH · t), t in seconds since the round started: 2x at 9.9s, 10x at 33s, 100x at 66s.
 * Deterministic, so every browser draws the same curve from the round's start time alone.
 *
 * ── provably fair ──
 * The server seed is committed (its SHA-256) before any bet is placed and revealed when the round
 * busts. C comes from HMAC-SHA256(serverSeed, `${roundId}:0`), the same construction roulette uses:
 * the first 52 bits as h, and C = floor((10000 − edgeBps) · 2^52 / (100 · (2^52 − h))) / 100.
 */

export const CRASH_HOUSE_EDGE_BPS = 1000;
/** e-folding rate of the curve, per second. */
export const CRASH_GROWTH_PER_SECOND = 0.07;
/** The lowest multiplier an auto cash-out may aim at. At 1.00x a "win" would only return the stake. */
export const CRASH_MIN_TARGET_X100 = 101;
/** The curve's ceiling. A drawn crash point above it busts here instead; P(C ≥ 1000x) = 0.09%. */
export const CRASH_MAX_MULTIPLIER_X100 = 100_000;

const TWO_POW_52 = 2n ** 52n;

export interface CrashOutcome {
  crashPointX100: number;
  digest: string;
}

/** The crash point for one round, in hundredths: 100 is an instant bust at 1.00x. */
export function crashPoint(
  serverSeed: string,
  roundId: string,
  houseEdgeBps = CRASH_HOUSE_EDGE_BPS,
): CrashOutcome {
  if (!Number.isInteger(houseEdgeBps) || houseEdgeBps < 0 || houseEdgeBps >= 10_000) {
    throw new RangeError('houseEdgeBps must be an integer between 0 and 9999');
  }
  const { digest } = createFairRoll(serverSeed, roundId, 0);
  const h = BigInt(`0x${digest.slice(0, 13)}`);
  return { crashPointX100: crashPointFromSample(h, houseEdgeBps), digest };
}

/** The same formula, from the raw 52-bit sample. Exported so the tests can walk the distribution. */
export function crashPointFromSample(h: bigint, houseEdgeBps = CRASH_HOUSE_EDGE_BPS): number {
  if (h < 0n || h >= TWO_POW_52) throw new RangeError('sample must be a 52-bit integer');
  const raw = (BigInt(10_000 - houseEdgeBps) * TWO_POW_52) / (100n * (TWO_POW_52 - h));
  if (raw < 100n) return 100;
  if (raw > BigInt(CRASH_MAX_MULTIPLIER_X100)) return CRASH_MAX_MULTIPLIER_X100;
  return Number(raw);
}

/** Seconds from the start of a round until the curve reaches `multiplierX100`. */
export function secondsToReach(multiplierX100: number): number {
  if (!Number.isInteger(multiplierX100) || multiplierX100 < 100) {
    throw new RangeError('multiplier must be an integer of at least 100 hundredths');
  }
  return Math.log(multiplierX100 / 100) / CRASH_GROWTH_PER_SECOND;
}

/** The multiplier, in hundredths and floored, `seconds` into a round. */
export function multiplierAt(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 100;
  const value = Math.floor(100 * Math.exp(CRASH_GROWTH_PER_SECOND * seconds) + 1e-9);
  return Math.min(Math.max(value, 100), CRASH_MAX_MULTIPLIER_X100);
}

/**
 * The highest multiplier a bet of this size may ride to: the curve's ceiling, or the multiplier at
 * which the payout would reach the configured maximum, whichever is lower. Null when even 1.01x
 * would pay more than the maximum -- a stake the configuration cannot honour.
 */
export function limitFor(stakeMinor: bigint, maxPayoutMinor: bigint): number | null {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  const byPayout = (maxPayoutMinor * 100n) / stakeMinor;
  const limit = byPayout < BigInt(CRASH_MAX_MULTIPLIER_X100)
    ? Number(byPayout)
    : CRASH_MAX_MULTIPLIER_X100;
  return limit >= CRASH_MIN_TARGET_X100 ? limit : null;
}

/** Where a bet cashes out on its own: the player's target, never above the bet's limit. */
export function effectiveTarget(autoCashoutX100: number | null, limitX100: number): number {
  return autoCashoutX100 === null ? limitX100 : Math.min(autoCashoutX100, limitX100);
}

/** Stake times multiplier, rounded down to the whole unit. */
export function payoutAt(stakeMinor: bigint, multiplierX100: number): bigint {
  if (!Number.isInteger(multiplierX100) || multiplierX100 < 100) {
    throw new RangeError('multiplier must be an integer of at least 100 hundredths');
  }
  return (stakeMinor * BigInt(multiplierX100)) / 100n;
}
