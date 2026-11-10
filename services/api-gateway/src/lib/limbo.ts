/**
 * Limbo — pick a target multiplier; the server draws a multiplier, and the bet wins if the draw
 * reaches the target.
 *
 * ── the draw ──
 * d = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`), the message every seeded game here signs.
 * Its first 52 bits, read big-endian, are n in [0, 2^52) (lib/dice.ts drawFraction, the same bits).
 * The multiplier, in hundredths, is
 *
 *     result = floor( 90 * 2^52 / (2^52 - n) )
 *
 * computed in integers, so it is exact and anyone holding the revealed seed reproduces it. It runs
 * from 90 (0.90x) upward, capped at LIMBO_MAX_RESULT_X100. Shown, a result under 1.00x reads 1.00x;
 * every target is at least 1.01x, so it loses either way.
 *
 * ── the bet ──
 * A target T (hundredths, 1.01x to LIMBO_MAX_TARGET_X100) wins when result >= T, and pays the stake
 * times T, floored. The chance of that is exactly 90 / T: result >= T exactly when
 * 2^52 - n <= 90 * 2^52 / T, which holds for 90/T of all n.
 *
 * ── the edge ──
 * 10%, like Dice, Crash, Mines and Plinko: every target returns 90% on average, and the floors only
 * widen it. There is no decision after the draw.
 */

import { drawFraction } from './dice.js';

export const LIMBO_HOUSE_EDGE_BPS = 1000;
/** The smallest target, 1.01x, and the largest, 1,000,000x, in hundredths. */
export const LIMBO_MIN_TARGET_X100 = 101;
export const LIMBO_MAX_TARGET_X100 = 100_000_000;
/** The draw is capped here, in hundredths: no target can ask for more. */
export const LIMBO_MAX_RESULT_X100 = 100_000_000;
const TWO_52 = 2n ** 52n;

/** n in [0, 2^52): the first 52 bits of the bet's HMAC, as an exact integer. */
export function drawBits(serverSeed: string, clientSeed: string, nonce: number): bigint {
  return BigInt(Math.round(drawFraction(serverSeed, clientSeed, nonce) * 2 ** 52));
}

/** The drawn multiplier, in hundredths: floor(90 * 2^52 / (2^52 - n)), capped. */
export function limboResult(serverSeed: string, clientSeed: string, nonce: number): number {
  const n = drawBits(serverSeed, clientSeed, nonce);
  const raw = (90n * TWO_52) / (TWO_52 - n);
  return Number(raw > BigInt(LIMBO_MAX_RESULT_X100) ? BigInt(LIMBO_MAX_RESULT_X100) : raw);
}

export function assertTarget(targetX100: number): void {
  if (!Number.isInteger(targetX100) || targetX100 < LIMBO_MIN_TARGET_X100 || targetX100 > LIMBO_MAX_TARGET_X100) {
    throw new RangeError(`target must be between ${LIMBO_MIN_TARGET_X100} and ${LIMBO_MAX_TARGET_X100} hundredths`);
  }
}

export function limboWins(targetX100: number, resultX100: number): boolean {
  return resultX100 >= targetX100;
}

/** The chance a target wins, in parts per million, floored: 90 / T. */
export function limboChancePpm(targetX100: number): number {
  assertTarget(targetX100);
  return Math.floor(90_000_000 / targetX100);
}

/** What a winning stake pays at a target, floored. */
export function payoutAt(stakeMinor: bigint, targetX100: number): bigint {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  return (stakeMinor * BigInt(targetX100)) / 100n;
}

/** The largest stake whose win still pays within `maxPayoutMinor` at a target. */
export function maxStakeAt(targetX100: number, maxPayoutMinor: bigint): bigint {
  return (maxPayoutMinor * 100n) / BigInt(targetX100);
}
