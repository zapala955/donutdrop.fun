import { createHmac } from 'node:crypto';

/**
 * Plinko — a ball dropped through `rows` rows of pegs, bouncing left or right at each one, and
 * paid the multiplier of the slot it lands in.
 *
 * ── the edge ──
 * The ball lands in slot k (k rights out of n rows) with probability C(n, k) / 2^n. Every table
 * below is built so that Σ C(n, k) · multiplier(k) / 2^n is at most 90%, and the tests hold each one
 * to between 89.7% and 90% in exact integers. There is no decision after the drop, so no strategy
 * can do better than the table: every rows-and-risk choice returns at most 90% on average. Payouts
 * are floored, which can only widen that edge.
 *
 * A bet whose best slot would pay more than the table's payout ceiling is refused rather than
 * capped: a cap would quietly turn the top slot into a worse bet than the table advertises.
 *
 * ── provably fair ──
 * The path comes from the player's committed server seed, their client seed and the seed's nonce:
 * d = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`), and at row i (from the top, 0-based) the
 * ball goes right when bit i of d is set, reading d's bytes in order and each byte from its highest
 * bit. The slot is the number of rights.
 */

export const PLINKO_HOUSE_EDGE_BPS = 1000;
export const PLINKO_MIN_ROWS = 8;
export const PLINKO_MAX_ROWS = 16;
export const PLINKO_RISKS = ['low', 'medium', 'high'] as const;
export type PlinkoRisk = (typeof PLINKO_RISKS)[number];

/** Multipliers in basis points (10_000 = 1x), slot 0 (all lefts) to slot `rows` (all rights). */
export const PLINKO_MULTIPLIERS_BPS: Readonly<Record<number, Readonly<Record<PlinkoRisk, readonly number[]>>>> = {
  8: {
    low: [51_000, 19_000, 10_000, 9_000, 4_700, 9_000, 10_000, 19_000, 51_000],
    medium: [120_000, 28_000, 11_000, 6_500, 3_800, 6_500, 11_000, 28_000, 120_000],
    high: [265_000, 37_000, 13_000, 2_800, 2_000, 2_800, 13_000, 37_000, 265_000],
  },
  9: {
    low: [58_000, 19_000, 14_000, 9_100, 6_400, 6_400, 9_100, 14_000, 19_000, 58_000],
    medium: [160_000, 37_000, 15_000, 8_200, 4_600, 4_600, 8_200, 15_000, 37_000, 160_000],
    high: [395_000, 63_000, 18_000, 5_400, 1_900, 1_900, 5_400, 18_000, 63_000, 395_000],
  },
  10: {
    low: [90_000, 28_000, 14_000, 9_200, 9_100, 4_700, 9_100, 9_200, 14_000, 28_000, 90_000],
    medium: [205_000, 47_000, 19_000, 12_000, 5_500, 3_800, 5_500, 12_000, 19_000, 47_000, 205_000],
    high: [690_000, 90_000, 27_000, 8_100, 2_800, 1_900, 2_800, 8_100, 27_000, 90_000, 690_000],
  },
  11: {
    low: [86_000, 29_000, 18_000, 11_000, 9_100, 6_500, 6_500, 9_100, 11_000, 18_000, 29_000, 86_000],
    medium: [225_000, 57_000, 27_000, 16_000, 6_400, 4_600, 4_600, 6_400, 16_000, 27_000, 57_000, 225_000],
    high: [1_120_000, 125_000, 48_000, 12_000, 3_700, 1_900, 1_900, 3_700, 12_000, 48_000, 125_000, 1_120_000],
  },
  12: {
    low: [100_000, 31_000, 15_000, 12_000, 10_000, 9_100, 4_700, 9_100, 10_000, 12_000, 15_000, 31_000, 100_000],
    medium: [305_000, 100_000, 37_000, 18_000, 10_000, 5_400, 2_800, 5_400, 10_000, 18_000, 37_000, 100_000, 305_000],
    high: [1_560_000, 215_000, 73_000, 18_000, 6_400, 1_900, 1_800, 1_900, 6_400, 18_000, 73_000, 215_000, 1_560_000],
  },
  13: {
    low: [76_000, 40_000, 29_000, 18_000, 10_000, 8_200, 6_500, 6_500, 8_200, 10_000, 18_000, 29_000, 40_000, 76_000],
    medium: [425_000, 120_000, 55_000, 28_000, 11_000, 6_500, 3_700, 3_700, 6_500, 11_000, 28_000, 55_000, 120_000, 425_000],
    high: [2_390_000, 335_000, 96_000, 37_000, 9_100, 1_900, 1_800, 1_800, 1_900, 9_100, 37_000, 96_000, 335_000, 2_390_000],
  },
  14: {
    low: [76_000, 38_000, 19_000, 14_000, 12_000, 9_200, 9_200, 4_800, 9_200, 9_200, 12_000, 14_000, 19_000, 38_000, 76_000],
    medium: [530_000, 140_000, 64_000, 36_000, 17_000, 9_100, 4_600, 1_900, 4_600, 9_100, 17_000, 36_000, 64_000, 140_000, 530_000],
    high: [3_860_000, 510_000, 160_000, 46_000, 17_000, 2_800, 1_900, 1_800, 1_900, 2_800, 17_000, 46_000, 160_000, 510_000, 3_860_000],
  },
  15: {
    low: [165_000, 76_000, 28_000, 20_000, 14_000, 9_200, 9_100, 6_500, 6_500, 9_100, 9_200, 14_000, 20_000, 28_000, 76_000, 165_000],
    medium: [805_000, 160_000, 105_000, 46_000, 28_000, 11_000, 4_600, 2_800, 2_800, 4_600, 11_000, 28_000, 46_000, 105_000, 160_000, 805_000],
    high: [5_730_000, 765_000, 245_000, 72_000, 27_000, 4_600, 1_900, 1_800, 1_800, 1_900, 4_600, 27_000, 72_000, 245_000, 765_000, 5_730_000],
  },
  16: {
    low: [180_000, 86_000, 20_000, 13_000, 12_000, 11_000, 10_000, 9_100, 4_600, 9_100, 10_000, 11_000, 12_000, 13_000, 20_000, 86_000, 180_000],
    medium: [1_050_000, 370_000, 91_000, 46_000, 28_000, 13_000, 9_100, 4_600, 2_800, 4_600, 9_100, 13_000, 28_000, 46_000, 91_000, 370_000, 1_050_000],
    high: [9_110_000, 1_180_000, 235_000, 81_000, 37_000, 18_000, 1_900, 1_800, 1_800, 1_800, 1_900, 18_000, 37_000, 81_000, 235_000, 1_180_000, 9_110_000],
  },
};

export function multipliersFor(rows: number, risk: PlinkoRisk): readonly number[] {
  assertRows(rows);
  const table = PLINKO_MULTIPLIERS_BPS[rows]?.[risk];
  if (!table) throw new RangeError('unknown risk');
  return table;
}

/** The best slot's multiplier, the one the payout ceiling has to cover. */
export function maxMultiplierBps(rows: number, risk: PlinkoRisk): number {
  return Math.max(...multipliersFor(rows, risk));
}

/** The largest stake whose best slot still pays within `maxPayoutMinor`. */
export function maxStakeFor(rows: number, risk: PlinkoRisk, maxPayoutMinor: bigint): bigint {
  return (maxPayoutMinor * 10_000n) / BigInt(maxMultiplierBps(rows, risk));
}

/** The ball's path, one 0 (left) or 1 (right) per row from the top. */
export function plinkoPath(serverSeed: string, clientSeed: string, nonce: number, rows: number): number[] {
  assertRows(rows);
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`, 'utf8').digest();
  const path: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    path.push((digest[row >> 3]! >> (7 - (row & 7))) & 1);
  }
  return path;
}

/** The slot a path lands in: how many times it went right. */
export function slotOf(path: readonly number[]): number {
  return path.reduce((sum, step) => sum + step, 0);
}

/** What landing in `slot` pays on this stake, floored. */
export function payoutFor(stakeMinor: bigint, rows: number, risk: PlinkoRisk, slot: number): bigint {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  const table = multipliersFor(rows, risk);
  const bps = table[slot];
  if (bps === undefined) throw new RangeError('slot out of range');
  return (stakeMinor * BigInt(bps)) / 10_000n;
}

function assertRows(rows: number): void {
  if (!Number.isInteger(rows) || rows < PLINKO_MIN_ROWS || rows > PLINKO_MAX_ROWS) {
    throw new RangeError(`rows must be between ${PLINKO_MIN_ROWS} and ${PLINKO_MAX_ROWS}`);
  }
}
