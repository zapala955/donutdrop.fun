import { createHmac } from 'node:crypto';

/**
 * Dice — a roll from 0.00 to 99.99, and a line the player draws through it.
 *
 * ── the roll ──
 * d = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`), the same message every seeded game here
 * signs. Its first 52 bits, read big-endian, divided by 2^52, give a fraction f in [0, 1) with the
 * full precision a double holds exactly; the roll is floor(f * 10000), held as hundredths 0..9999.
 * A player holding the revealed server seed can recompute any roll with a few lines of code.
 *
 * ── the bet ──
 * The player draws a line and picks a side: UNDER wins when the roll is below the line, OVER when
 * it is at or above it. The chance of winning is the width of the winning side; the multiplier is
 * 90% divided by that chance, floored to the basis point.
 *
 * ── the edge ──
 * 10%, like Crash, Mines and Plinko. Every line returns 90% on average before flooring, and payouts
 * are floored, which can only widen the edge. There is no decision after the roll, so no strategy
 * does better than the table. The chance runs from 1% to 89%: past 89% a win would pay less than
 * 1.01x the stake, which is a bet nobody should be offered.
 */

export const DICE_HOUSE_EDGE_BPS = 1000;
export const DICE_DIRECTIONS = ['under', 'over'] as const;
export type DiceDirection = (typeof DICE_DIRECTIONS)[number];
export const DICE_SPAN = 10_000;
export const DICE_MIN_CHANCE = 100;
export const DICE_MAX_CHANCE = 8_900;

/** f in [0, 1): the first 52 bits of the bet's HMAC. */
export function drawFraction(serverSeed: string, clientSeed: string, nonce: number): number {
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`, 'utf8').digest();
  // 48 bits from the first six bytes, then the high nibble of the seventh: 52 bits, exact in a double.
  const high = digest.readUIntBE(0, 6);
  const low = digest[6]! >> 4;
  return (high * 16 + low) / 2 ** 52;
}

/** The roll, 0..9999 (shown as 0.00..99.99). */
export function diceRoll(serverSeed: string, clientSeed: string, nonce: number): number {
  return Math.floor(drawFraction(serverSeed, clientSeed, nonce) * DICE_SPAN);
}

/** How many of the 10,000 rolls win, for a line `target` (hundredths) and a side. */
export function diceChance(direction: DiceDirection, target: number): number {
  if (!Number.isInteger(target) || target < 1 || target >= DICE_SPAN) {
    throw new RangeError('target must be a whole number of hundredths between 0.01 and 99.99');
  }
  return direction === 'under' ? target : DICE_SPAN - target;
}

export function diceWins(direction: DiceDirection, target: number, roll: number): boolean {
  return direction === 'under' ? roll < target : roll >= target;
}

/** The multiplier a win pays, in basis points, floored: 90% over the chance. */
export function diceMultiplierBps(chance: number): number {
  if (!Number.isInteger(chance) || chance < DICE_MIN_CHANCE || chance > DICE_MAX_CHANCE) {
    throw new RangeError(`chance must be between ${DICE_MIN_CHANCE} and ${DICE_MAX_CHANCE}`);
  }
  return Math.floor((10_000 * (10_000 - DICE_HOUSE_EDGE_BPS)) / chance);
}

/** What a winning stake pays at `multiplierBps`, floored. */
export function payoutAt(stakeMinor: bigint, multiplierBps: number): bigint {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  return (stakeMinor * BigInt(multiplierBps)) / 10_000n;
}

/** The largest stake whose win still pays within `maxPayoutMinor` at `multiplierBps`. */
export function maxStakeAt(multiplierBps: number, maxPayoutMinor: bigint): bigint {
  return (maxPayoutMinor * 10_000n) / BigInt(multiplierBps);
}
