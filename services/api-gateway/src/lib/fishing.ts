import { createHmac } from 'node:crypto';

/**
 * Fishing — a deep dive on a fishing line. A cast is staked, the lure sinks, and as it goes deeper
 * the multiplier climbs: through the shallows, the coral reef, the kelp forest, a shipwreck, an
 * ocean monument, the abyss and an ancient city. Reel up at any moment for the stake times the
 * multiplier and whatever was on the hook at that depth; go too deep and something down there cuts
 * the line, and the stake is gone.
 *
 * ── the snap ──
 * The line's breaking point S is drawn when the cast is made, so that for every multiplier x on
 * the 0.01 grid
 *
 *     P(S ≥ x) = (1 − edge) / x,
 *
 * Crash's own curve (lib/crash.ts). Landing at x pays x when x < S, and so returns at most
 * (1 − edge) of the stake on average, whatever x is: the edge does not depend on when the player
 * lands, and no strategy -- a target set in advance, a click, a target picked at random -- does
 * better. One cast in about 9.2 snaps on the bite (S = 1.00x).
 *
 * ── the climb ──
 * m(t) = e^(k · t), t in seconds since the lure went under, floored to 0.01. The sinker is the speed:
 * k is Crash's 0.07 with a feather (2x at 9.9 s), faster with iron, fastest with an anvil. Every
 * sinker has the same odds; only the time to each multiplier changes. A landing is paid the
 * multiplier the line had reached when the server received it, as Crash pays a cash-out: latency can
 * only move a landing later, never earlier. The line holds at most to 1000x, where it is cut.
 *
 * ── the catch ──
 * What comes up is the depth's: the deeper the lure went, the rarer the catch, from a raw cod in
 * the shallows to an enchanted golden apple from an ancient city at 100x. It is what the catch is
 * called, not what it pays: the pay is the multiplier.
 *
 * ── provably fair ──
 * h = the first 52 bits of HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`) (the message every
 * seeded game here signs), and S = floor((10000 − edgeBps) · 2^52 / (100 · (2^52 − h))) / 100,
 * at least 1.00 and at most 1000.00: lib/crash.ts's formula on the player's own seed. The seed is
 * spent when the cast is made and revealed when it ends.
 */

export const FISHING_HOUSE_EDGE_BPS = 1000;
export const FISHING_SINKERS = ['feather', 'iron', 'anvil'] as const;
export type FishingSinker = (typeof FISHING_SINKERS)[number];

/** The climb's e-folding rate per second, by sinker. The feather is Crash's own curve. */
export const FISHING_GROWTH: Readonly<Record<FishingSinker, number>> = { feather: 0.07, iron: 0.09, anvil: 0.12 };
/** From the cast to the lure going under: the climb starts there. */
export const FISHING_HOOK_MS = 1800;
/** The lowest landing, and the lowest auto-land target: at 1.00x a landing only returns the stake. */
export const FISHING_MIN_LAND_X100 = 101;
/** The most the line ever holds: a drawn breaking point above it snaps here instead. */
export const FISHING_MAX_X100 = 100_000;

export type FishingKind = 'fish' | 'treasure';

/** Every catch, by the item it is in the game. */
export const FISHING_CATCHES: Readonly<Record<string, { name: string; kind: FishingKind }>> = {
  cod: { name: 'Raw Cod', kind: 'fish' },
  tropical_fish: { name: 'Tropical Fish', kind: 'fish' },
  pufferfish: { name: 'Pufferfish', kind: 'fish' },
  nautilus_shell: { name: 'Nautilus Shell', kind: 'treasure' },
  emerald: { name: 'Emerald', kind: 'treasure' },
  diamond: { name: 'Diamond', kind: 'treasure' },
  trident: { name: 'Trident', kind: 'treasure' },
  heart_of_the_sea: { name: 'Heart of the Sea', kind: 'treasure' },
  echo_shard: { name: 'Echo Shard', kind: 'treasure' },
  enchanted_golden_apple: { name: 'Enchanted Golden Apple', kind: 'treasure' },
};

/** The catch ladder: from each multiplier (in hundredths) down, what is on the hook -- each depth's
 * own loot, from the shallows' cod to the ancient city's enchanted golden apple. */
export const FISHING_LADDER: readonly (readonly [number, string])[] = [
  [101, 'cod'],
  [150, 'tropical_fish'],
  [200, 'pufferfish'],
  [300, 'nautilus_shell'],
  [500, 'emerald'],
  [700, 'diamond'],
  [1000, 'trident'],
  [2500, 'heart_of_the_sea'],
  [6000, 'echo_shard'],
  [10000, 'enchanted_golden_apple'],
];

const TWO_POW_52 = 2n ** 52n;

/** What is on the line at a multiplier (in hundredths). */
export function catchAt(x100: number): string {
  let caught = FISHING_LADDER[0]![1];
  for (const [from, id] of FISHING_LADDER) if (x100 >= from) caught = id;
  return caught;
}

/** The breaking point from the raw 52-bit sample, in hundredths: 100 snaps on the bite. */
export function snapFromSample(h: bigint, houseEdgeBps = FISHING_HOUSE_EDGE_BPS): number {
  if (h < 0n || h >= TWO_POW_52) throw new RangeError('sample must be a 52-bit integer');
  const raw = (BigInt(10_000 - houseEdgeBps) * TWO_POW_52) / (100n * (TWO_POW_52 - h));
  if (raw < 100n) return 100;
  if (raw > BigInt(FISHING_MAX_X100)) return FISHING_MAX_X100;
  return Number(raw);
}

/** The breaking point a seed, a client seed and a nonce decide. */
export function snapPoint(serverSeed: string, clientSeed: string, nonce: number): { snapX100: number; sample: string } {
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`, 'utf8').digest('hex');
  const sample = digest.slice(0, 13);
  return { snapX100: snapFromSample(BigInt(`0x${sample}`)), sample };
}

/** The multiplier, in hundredths and floored, `seconds` after the lure went under with this sinker. */
export function multiplierAt(sinker: FishingSinker, seconds: number): number {
  if (!(seconds > 0)) return 100;
  const x100 = Math.floor(100 * Math.exp(FISHING_GROWTH[sinker] * seconds) + 1e-9);
  return Math.min(FISHING_MAX_X100, Math.max(100, x100));
}

/** Seconds from the lure going under until the line reaches `x100` with this sinker. */
export function secondsToReach(sinker: FishingSinker, x100: number): number {
  if (!Number.isInteger(x100) || x100 < 100) throw new RangeError('multiplier must be an integer of at least 100 hundredths');
  return Math.log(x100 / 100) / FISHING_GROWTH[sinker];
}

/** What a landing at `x100` pays, floored. */
export function payoutAt(stakeMinor: bigint, x100: number): bigint {
  return (stakeMinor * BigInt(x100)) / 100n;
}

/** The largest stake whose best landing still pays within `maxPayoutMinor`. */
export function maxStakeFor(maxPayoutMinor: bigint): bigint {
  return (maxPayoutMinor * 100n) / BigInt(FISHING_MAX_X100);
}

/**
 * Where an open cast stands at `reachedX100`: still climbing, landed by its auto-land target, or
 * snapped. A landing asked for by hand is `landNow`, judged at the multiplier reached.
 */
export function judge(
  snapX100: number,
  reachedX100: number,
  autoLandX100: number | null,
  landNow = false,
): { outcome: 'open' } | { outcome: 'landed'; landedX100: number } | { outcome: 'snapped' } {
  // The auto-land target was passed first: it landed there, whatever happened after.
  if (autoLandX100 !== null && autoLandX100 < snapX100 && reachedX100 >= autoLandX100) {
    return { outcome: 'landed', landedX100: autoLandX100 };
  }
  if (reachedX100 >= snapX100) return { outcome: 'snapped' };
  if (landNow && reachedX100 >= FISHING_MIN_LAND_X100) return { outcome: 'landed', landedX100: reachedX100 };
  return { outcome: 'open' };
}
