import {
  MINES_HOUSE_EDGE_BPS,
  MINES_MAX_COUNT,
  MINES_MIN_COUNT,
  MINES_TILES,
  minePositions,
  multiplierBps,
  nextSafeChanceBps,
  oddsAgainst,
  payoutFor,
} from './mines.js';

/**
 * Ice Fishing — a frozen lake, twenty-five places to drill through it, and somewhere under the snow
 * the ice is thin. Every hole that comes up with a fish raises the multiplier; drilling through thin
 * ice loses the stake; the player may pull out after any fish.
 *
 * It is Mines on the ice, and deliberately so: the same maths, the same draw, so the same proof.
 *
 * ── the edge ──
 * With 25 holes, t of them thin ice, the chance of drilling k fish in a row is
 * C(25 − t, k) / C(25, k), and pulling out after them pays (1 − edge) over that chance: 90% of the
 * stake on average for every k and every t, so no way of choosing when to stop does better.
 * Multipliers and payouts are floored, which can only widen the edge.
 *
 * ── provably fair ──
 * The thin ice is laid when the game starts, from the player's committed seed: the Fisher–Yates
 * shuffle of lib/mines.ts, step i drawing HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${i}`),
 * and the first t holes of the shuffle are thin. The seed is revealed when the game ends.
 *
 * ── the catch ──
 * What a hole brings up is named by the multiplier it takes the game to, from a raw cod to a heart
 * of the sea; it is what the fish is called, not what it pays.
 */

export const ICE_FISHING_HOUSE_EDGE_BPS = MINES_HOUSE_EDGE_BPS;
export const ICE_FISHING_HOLES = MINES_TILES;
export const ICE_FISHING_MIN_THIN = MINES_MIN_COUNT;
export const ICE_FISHING_MAX_THIN = MINES_MAX_COUNT;

/** The thin-ice holes, 0-24 in reading order, sorted: Mines' own draw. */
export const thinHoles = minePositions;
/** The multiplier for pulling out after `drilled` fish, in basis points, floored. */
export const multiplierAfter = multiplierBps;
/** What pulling out after `drilled` fish pays on this stake, floored, before any cap. */
export const payoutAfter = payoutFor;
/** The chance, in basis points, that the next hole drilled has a fish. */
export const nextFishChanceBps = nextSafeChanceBps;
export { oddsAgainst };

/** What a hole brings up, by the multiplier (in basis points) it takes the game to. */
export const ICE_FISHING_CATCHES: readonly (readonly [number, string, string])[] = [
  [0, 'cod', 'Raw Cod'],
  [15_000, 'salmon', 'Raw Salmon'],
  [20_000, 'tropical_fish', 'Tropical Fish'],
  [30_000, 'pufferfish', 'Pufferfish'],
  [50_000, 'nautilus_shell', 'Nautilus Shell'],
  [100_000, 'heart_of_the_sea', 'Heart of the Sea'],
];

/** The catch a hole brings up when the game reaches `multiplierBps` with it. */
export function catchAt(bps: number): { id: string; name: string } {
  let at = ICE_FISHING_CATCHES[0]!;
  for (const entry of ICE_FISHING_CATCHES) if (bps >= entry[0]) at = entry;
  return { id: at[1], name: at[2] };
}
