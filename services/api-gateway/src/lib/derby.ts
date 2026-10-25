import { createHmac } from 'node:crypto';

/**
 * Mob Derby — six of the game's farm mobs race down a track, and the player backs one. Each racer
 * has fixed odds and pays 90% over its chance: a pig wins often and pays little, a black sheep
 * rarely and pays 19.2x.
 *
 * ── the draw ──
 * d = HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`), the message every seeded game here signs.
 * Its first byte, 0..255, picks the winner: the racers' weights laid end to end cover exactly 256, so
 * each racer wins exactly its weight in 256 races, with no rounding anywhere. The next sixteen bytes
 * are the race's track seed: how the field runs on the way there, which the page draws. They decide
 * nothing; the winner is the first byte's.
 *
 * ── the edge ──
 * 10%, like Crash, Dice and Fishing. A racer with weight w pays 0.9 x 256 / w, which is a whole
 * number of hundredths for every weight below, so every bet returns exactly 90% of its stake on
 * average whichever racer it backs. Payouts are floored, which can only widen the edge.
 */

export const DERBY_HOUSE_EDGE_BPS = 1000;
export const DERBY_SPAN = 256;

export interface DerbyRacer {
  id: string;
  name: string;
  weight: number;
}

/** The field, in lane order: the favourite on the inside. */
export const DERBY_RACERS: readonly DerbyRacer[] = [
  { id: 'pig', name: 'Pig', weight: 80 },
  { id: 'cow', name: 'Cow', weight: 64 },
  { id: 'sheep', name: 'Sheep', weight: 48 },
  { id: 'chicken', name: 'Chicken', weight: 32 },
  { id: 'mooshroom', name: 'Mooshroom', weight: 20 },
  { id: 'black_sheep', name: 'Black Sheep', weight: 12 },
];
export const DERBY_PICKS = DERBY_RACERS.map((racer) => racer.id) as [string, ...string[]];

/** What a win on a racer pays, in hundredths: 90% over its chance, exact. */
export function oddsX100(racerId: string): number {
  const racer = DERBY_RACERS.find((r) => r.id === racerId);
  if (!racer) throw new RangeError('no such racer');
  const x100 = ((DERBY_SPAN * (10_000 - DERBY_HOUSE_EDGE_BPS)) / 100) / racer.weight;
  if (!Number.isInteger(x100)) throw new Error('odds are not a whole number of hundredths');
  return x100;
}

/** The winner a byte picks: the weights laid end to end over 0..255. */
export function winnerOf(roll: number): DerbyRacer {
  if (!Number.isInteger(roll) || roll < 0 || roll >= DERBY_SPAN) throw new RangeError('roll must be 0..255');
  let at = roll;
  for (const racer of DERBY_RACERS) {
    if (at < racer.weight) return racer;
    at -= racer.weight;
  }
  throw new Error('the weights do not cover 256');
}

/** The race a seed, a client seed and a nonce decide: the winner's roll and the track seed. */
export function drawRace(serverSeed: string, clientSeed: string, nonce: number): { roll: number; winner: string; trackSeed: string } {
  const digest = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`, 'utf8').digest();
  const roll = digest[0]!;
  return { roll, winner: winnerOf(roll).id, trackSeed: digest.subarray(1, 17).toString('hex') };
}

/** What a bet pays, floored: its racer's odds if it won, nothing if not. */
export function payoutFor(stakeMinor: bigint, pick: string, winner: string): { x100: number; payoutMinor: bigint } {
  if (pick !== winner) return { x100: 0, payoutMinor: 0n };
  const x100 = oddsX100(pick);
  return { x100, payoutMinor: (stakeMinor * BigInt(x100)) / 100n };
}

/** The largest stake on a racer whose win still pays within `maxPayoutMinor`. */
export function maxStakeFor(pick: string, maxPayoutMinor: bigint): bigint {
  return (maxPayoutMinor * 100n) / BigInt(oddsX100(pick));
}
