import { createHmac } from 'node:crypto';

/**
 * Mines — a 5x5 field with a chosen number of TNT. Every safe tile turned over raises the
 * multiplier; turning TNT loses the stake; the player may cash out after any safe tile.
 *
 * ── the edge ──
 * With n tiles, m of them TNT, the chance of turning k safe tiles in a row is
 *
 *     P(k) = C(n − m, k) / C(n, k) = ∏_{i<k} (n − m − i) / (n − i),
 *
 * and the multiplier paid for cashing out after those k tiles is (1 − edge) / P(k). Cashing out
 * after k tiles therefore returns (1 − edge) of the stake on average, for every k and every m.
 * A player's whole strategy is when to stop, and the only thing a stopping rule can depend on is
 * how many tiles have survived so far -- so every strategy returns the same 90%. Multipliers and
 * payouts are floored, which can only widen that edge, never narrow it.
 *
 * ── provably fair ──
 * The TNT is placed when the game starts, from the player's committed server seed, their client
 * seed and the seed's nonce: a Fisher–Yates shuffle of the 25 tiles in which step i draws
 * HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${i}`), first 52 bits, and the first m tiles of
 * the shuffle are the TNT. The seed is revealed when the game ends, and not before: it is the
 * whole field.
 */

export const MINES_TILES = 25;
export const MINES_HOUSE_EDGE_BPS = 1000;
export const MINES_MIN_COUNT = 1;
export const MINES_MAX_COUNT = 24;

const TWO_POW_52 = 2 ** 52;

/** The TNT tiles, 0-24 in reading order, sorted. */
export function minePositions(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  mineCount: number,
): number[] {
  assertMineCount(mineCount);
  const tiles = Array.from({ length: MINES_TILES }, (_, index) => index);
  for (let i = 0; i < mineCount; i += 1) {
    const digest = createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${i}`, 'utf8')
      .digest('hex');
    const sample = Number.parseInt(digest.slice(0, 13), 16) / TWO_POW_52;
    const j = i + Math.floor(sample * (MINES_TILES - i));
    [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
  }
  return tiles.slice(0, mineCount).sort((a, b) => a - b);
}

/**
 * The exact odds against surviving `revealed` tiles, as a fraction: numerator over denominator,
 * so that numerator / denominator = 1 / P(revealed).
 */
export function oddsAgainst(mineCount: number, revealed: number): { num: bigint; den: bigint } {
  assertMineCount(mineCount);
  const safe = MINES_TILES - mineCount;
  if (!Number.isInteger(revealed) || revealed < 0 || revealed > safe) {
    throw new RangeError('revealed must be between 0 and the number of safe tiles');
  }
  let num = 1n;
  let den = 1n;
  for (let i = 0; i < revealed; i += 1) {
    num *= BigInt(MINES_TILES - i);
    den *= BigInt(safe - i);
  }
  return { num, den };
}

/** The multiplier for cashing out after `revealed` safe tiles, in basis points, floored. */
export function multiplierBps(mineCount: number, revealed: number): number {
  const { num, den } = oddsAgainst(mineCount, revealed);
  return Number((BigInt(10_000 - MINES_HOUSE_EDGE_BPS) * num) / den);
}

/** What cashing out after `revealed` safe tiles pays on this stake, floored, before any cap. */
export function payoutFor(stakeMinor: bigint, mineCount: number, revealed: number): bigint {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  const { num, den } = oddsAgainst(mineCount, revealed);
  return (stakeMinor * BigInt(10_000 - MINES_HOUSE_EDGE_BPS) * num) / (10_000n * den);
}

/** The chance, in basis points, that the next tile turned is safe. */
export function nextSafeChanceBps(mineCount: number, revealed: number): number {
  assertMineCount(mineCount);
  const hidden = MINES_TILES - revealed;
  const safeLeft = MINES_TILES - mineCount - revealed;
  if (hidden <= 0 || safeLeft <= 0) return 0;
  return Math.floor((safeLeft * 10_000) / hidden);
}

function assertMineCount(mineCount: number): void {
  if (!Number.isInteger(mineCount) || mineCount < MINES_MIN_COUNT || mineCount > MINES_MAX_COUNT) {
    throw new RangeError(`mine count must be between ${MINES_MIN_COUNT} and ${MINES_MAX_COUNT}`);
  }
}
