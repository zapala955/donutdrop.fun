import { createHmac } from 'node:crypto';

/**
 * Chicken — a chicken crosses twenty minecart rails, one lane at a time. A lane it crosses safely
 * raises the multiplier; a minecart coming down the lane it steps into ends the run and loses the
 * stake; the player may cash out after any lane crossed.
 *
 * ── the modes ──
 * A mode is the chance that a lane has a minecart on it, the same for every lane:
 *
 *     easy      1 in 6
 *     medium    1 in 4
 *     hard      1 in 3
 *     hardcore  1 in 2
 *
 * ── the edge ──
 * Lanes are independent, so the chance of crossing k of them is ((of − hit) / of)^k, and the
 * multiplier for cashing out after k lanes is (1 − edge) · (of / (of − hit))^k. Cashing out after k
 * lanes returns (1 − edge) of the stake on average, for every k and every mode: a player's only
 * choice is when to stop, so every strategy returns the same 90%, the edge of Mines and Tower.
 * Multipliers and payouts are floored, which can only widen it. Every mode's first lane pays more
 * than the stake: a mode safe enough to pay under 1x for its first step is not offered.
 *
 * ── provably fair ──
 * The lane the minecart comes down is fixed when the run starts, from the player's committed server
 * seed, their client seed and the seed's nonce. Lane i draws HMAC-SHA256(serverSeed,
 * `${clientSeed}:${nonce}:${i}`), first 52 bits, as u in [0, 1); the lane has a minecart when
 * floor(u · of) < hit. The run ends at the first such lane, or crosses all twenty if there is none.
 * The seed is revealed when the run ends, and not before: it is the whole road.
 */

export const CHICKEN_LANES = 20;
export const CHICKEN_HOUSE_EDGE_BPS = 1000;

export const CHICKEN_MODES = {
  easy: { hit: 1, of: 6 },
  medium: { hit: 1, of: 4 },
  hard: { hit: 1, of: 3 },
  hardcore: { hit: 1, of: 2 },
} as const;

export type ChickenMode = keyof typeof CHICKEN_MODES;
export const CHICKEN_MODE_NAMES = Object.keys(CHICKEN_MODES) as ChickenMode[];

const TWO_POW_52 = 2 ** 52;

/** Whether lane `lane` has a minecart on it, as the published recipe draws it. */
export function laneHasCart(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  mode: ChickenMode,
  lane: number,
): boolean {
  const { hit, of } = modeOf(mode);
  const digest = createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}:${lane}`, 'utf8')
    .digest('hex');
  const sample = Number.parseInt(digest.slice(0, 13), 16) / TWO_POW_52;
  return Math.floor(sample * of) < hit;
}

/** The first lane (0-based) with a minecart on it, or null when the whole road is clear. */
export function cartLane(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  mode: ChickenMode,
): number | null {
  for (let lane = 0; lane < CHICKEN_LANES; lane += 1) {
    if (laneHasCart(serverSeed, clientSeed, nonce, mode, lane)) return lane;
  }
  return null;
}

/**
 * The exact odds against crossing `crossed` lanes, as a fraction: numerator over denominator, so
 * that numerator / denominator = 1 / P(crossed).
 */
export function oddsAgainst(mode: ChickenMode, crossed: number): { num: bigint; den: bigint } {
  const { hit, of } = modeOf(mode);
  if (!Number.isInteger(crossed) || crossed < 0 || crossed > CHICKEN_LANES) {
    throw new RangeError(`crossed must be between 0 and ${CHICKEN_LANES}`);
  }
  return { num: BigInt(of) ** BigInt(crossed), den: BigInt(of - hit) ** BigInt(crossed) };
}

/** The multiplier for cashing out after `crossed` lanes, in basis points, floored. */
export function multiplierBps(mode: ChickenMode, crossed: number): number {
  const { num, den } = oddsAgainst(mode, crossed);
  return Number((BigInt(10_000 - CHICKEN_HOUSE_EDGE_BPS) * num) / den);
}

/** What cashing out after `crossed` lanes pays on this stake, floored, before any cap. */
export function payoutFor(stakeMinor: bigint, mode: ChickenMode, crossed: number): bigint {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  const { num, den } = oddsAgainst(mode, crossed);
  return (stakeMinor * BigInt(10_000 - CHICKEN_HOUSE_EDGE_BPS) * num) / (10_000n * den);
}

/** The chance, in basis points, that any one lane is clear. */
export function safeChanceBps(mode: ChickenMode): number {
  const { hit, of } = modeOf(mode);
  return Math.floor(((of - hit) * 10_000) / of);
}

export function isChickenMode(value: unknown): value is ChickenMode {
  return typeof value === 'string' && Object.hasOwn(CHICKEN_MODES, value);
}

export function modeOf(mode: ChickenMode): { hit: number; of: number } {
  if (!isChickenMode(mode)) throw new RangeError(`unknown chicken mode ${String(mode)}`);
  return CHICKEN_MODES[mode];
}
