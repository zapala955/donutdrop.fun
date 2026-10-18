import { createHmac } from 'node:crypto';

/**
 * Slots — five reels, three rows, ten fixed lines, a wild and a scatter that opens a round of free
 * spins. Two machines run on the same rules and differ in their strips, pays and wild:
 *
 *   Ore Rush        Minecraft ore. The Totem is a plain wild; the Enchanted Book opens free spins.
 *   Ocean Monument  The guardians' temple. Every Guardian a line runs through doubles that line
 *                   (two ×4, three ×8); the Elder Guardian opens free spins.
 *
 * ── the machine ──
 * Each reel is a fixed strip of symbols. A spin stops every reel at one strip index; the three rows
 * showing are that index and the two after it, wrapping. A line pays when its symbols, read from
 * reel 1, match three, four or five in a row; the wild stands in for any symbol but the scatter and
 * only sits on reels 2-4, so a line always starts on a real symbol. Line pays are multiples of the
 * line bet (the stake / 10). Three or more scatters anywhere pay a multiple of the stake and start
 * free spins at the same stake, paid double, which can retrigger.
 *
 * ── the return ──
 * A single spin's expected pay, in stakes, is exact from the strips (every reel's stop is uniform,
 * so each line's symbols are independent, and a wild's multiplier is an independent factor per
 * reel): call it base, and r the free spins awarded per spin. A round returns
 * base · (1 + 2r / (1 − r)), and the tests hold each machine's figure in exact integers:
 *
 *   Ore Rush        base 0.854225…, r 0.057563…, return 95.8575%
 *   Ocean Monument  base 0.849164…, r 0.060504…, return 95.8536%
 *
 * Both keep 4.14% (rounded down to the basis point). The two ceilings below (a round pays at most
 * SLOTS_MAX_WIN_X stakes and plays at most SLOTS_MAX_FREE_SPINS free spins) and the floored payouts
 * can only lower the return; 20 million simulated Ore Rush rounds never came near either ceiling
 * (best round 406×, longest 48 free spins).
 *
 * ── provably fair ──
 * Everything comes from the player's committed server seed, their client seed and the seed's
 * nonce. Spin s of the round (0 is the paid spin, then each free spin in order) stops reel r at
 * floor(x · length), where x is the first 52 bits of
 * HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${s}:${r}`) over 2^52. The whole round is
 * decided and paid in the request that stakes it; the seed is revealed with the result.
 */

export const SLOTS_REELS = 5;
export const SLOTS_ROWS = 3;
export const SLOTS_LINE_COUNT = 10;
/** A round pays at most this many stakes, free spins included; it ends when it gets there. */
export const SLOTS_MAX_WIN_X = 1000;
/** A round plays at most this many free spins; retriggers past it award nothing. */
export const SLOTS_MAX_FREE_SPINS = 100;

/** The row each line crosses on each reel, top row 0. Both machines play the same ten. */
export const SLOTS_LINES: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 0, 1, 0],
];

export type SlotMachineId = 'ore-rush' | 'monument';

export interface SlotSymbol {
  readonly id: string;
  readonly name: string;
  /** Line-bet multiples for 3, 4 and 5 in a row; empty for the wild and the scatter. */
  readonly pays: readonly number[];
}

export interface SlotMachine {
  readonly id: SlotMachineId;
  readonly name: string;
  /** What a win is announced as, and the page it links to. */
  readonly label: string;
  readonly path: string;
  /** Value order, lowest first, then the wild, then the scatter. */
  readonly symbols: readonly SlotSymbol[];
  readonly wild: number;
  readonly scatter: number;
  /** A line pays this many times over for every wild in its run: 1 is a plain wild. */
  readonly wildMultiplier: number;
  /** Scatter pays in stakes, and the free spins they start, by how many are showing. */
  readonly scatterPayX: Readonly<Record<number, number>>;
  readonly scatterSpins: Readonly<Record<number, number>>;
  readonly freeMultiplier: number;
  readonly strips: readonly (readonly number[])[];
  /** 1 − the return, rounded DOWN to the basis point: what rakeback and referral shares are cut
   * from, so they are never paid out of margin the house does not keep. */
  readonly houseEdgeBps: number;
}

export const ORE_RUSH: SlotMachine = {
  id: 'ore-rush',
  name: 'Ore Rush',
  label: 'Slots',
  path: '/slots',
  symbols: [
    { id: 'redstone', name: 'Redstone', pays: [4, 10, 40] },
    { id: 'iron', name: 'Iron Ingot', pays: [5, 12, 50] },
    { id: 'gold', name: 'Gold Ingot', pays: [6, 15, 75] },
    { id: 'emerald', name: 'Emerald', pays: [8, 25, 100] },
    { id: 'apple', name: 'Golden Apple', pays: [12, 40, 150] },
    { id: 'diamond', name: 'Diamond', pays: [20, 60, 250] },
    { id: 'netherite', name: 'Netherite Ingot', pays: [30, 100, 500] },
    { id: 'star', name: 'Nether Star', pays: [50, 200, 1000] },
    { id: 'totem', name: 'Totem of Undying', pays: [] },
    { id: 'book', name: 'Enchanted Book', pays: [] },
  ],
  wild: 8,
  scatter: 9,
  wildMultiplier: 1,
  scatterPayX: { 3: 2, 4: 10, 5: 50 },
  scatterSpins: { 3: 8, 4: 12, 5: 20 },
  freeMultiplier: 2,
  strips: [
    [2, 0, 3, 1, 1, 1, 2, 3, 0, 6, 7, 5, 1, 1, 2, 0, 0, 4, 5, 0, 0, 4, 0, 4, 3, 2, 9, 6, 2, 1, 3],
    [0, 9, 2, 3, 0, 6, 1, 0, 4, 5, 8, 0, 2, 3, 5, 4, 1, 2, 8, 3, 0, 1, 1, 1, 8, 5, 7, 8, 6, 4, 0, 2, 3],
    [9, 2, 2, 2, 3, 1, 5, 5, 1, 5, 8, 8, 1, 0, 3, 4, 0, 6, 2, 0, 4, 7, 1, 0, 0, 4, 8, 1, 8, 6, 0, 3, 3],
    [1, 8, 4, 6, 0, 0, 1, 3, 8, 2, 3, 0, 4, 5, 1, 3, 7, 0, 2, 9, 8, 8, 1, 6, 3, 0, 1, 2, 5, 0, 4, 5, 2],
    [6, 4, 0, 3, 2, 0, 9, 1, 0, 1, 7, 3, 4, 3, 6, 1, 2, 2, 0, 3, 1, 0, 2, 4, 5, 0, 0, 1, 2, 5, 1],
  ],
  // 1 − 0.958575 = 4.1425%
  houseEdgeBps: 414,
};

/* Thirty-four stops a reel. Reels 1 and 5 carry 7 cod, 7 pufferfish, 6 shards, 5 crystals, 3 shells,
 * 3 trims, a trident, a heart and the Elder Guardian; reels 2-4 carry 8, 6, 5, 4, 3, 2, 2, 1, two
 * Guardians and the Elder Guardian. Each symbol is spread evenly round its drum, never beside itself. */
export const OCEAN_MONUMENT: SlotMachine = {
  id: 'monument',
  name: 'Ocean Monument',
  label: 'Ocean Monument',
  path: '/monument',
  symbols: [
    { id: 'cod', name: 'Raw Cod', pays: [4, 10, 40] },
    { id: 'pufferfish', name: 'Pufferfish', pays: [5, 12, 50] },
    { id: 'shard', name: 'Prismarine Shard', pays: [6, 15, 60] },
    { id: 'crystals', name: 'Prismarine Crystals', pays: [8, 20, 80] },
    { id: 'nautilus', name: 'Nautilus Shell', pays: [10, 30, 120] },
    { id: 'trim', name: 'Tide Armor Trim', pays: [15, 50, 200] },
    { id: 'trident', name: 'Trident', pays: [25, 80, 400] },
    { id: 'heart', name: 'Heart of the Sea', pays: [40, 150, 750] },
    { id: 'guardian', name: 'Guardian', pays: [] },
    { id: 'elder', name: 'Elder Guardian', pays: [] },
  ],
  wild: 8,
  scatter: 9,
  wildMultiplier: 2,
  scatterPayX: { 3: 2, 4: 8, 5: 40 },
  scatterSpins: { 3: 10, 4: 12, 5: 15 },
  freeMultiplier: 2,
  strips: [
    [1, 0, 2, 1, 3, 5, 0, 4, 2, 1, 3, 1, 0, 2, 5, 3, 0, 1, 6, 4, 2, 0, 9, 1, 7, 3, 2, 0, 5, 1, 0, 4, 3, 2],
    [0, 2, 4, 1, 0, 3, 5, 7, 2, 1, 0, 6, 4, 3, 8, 0, 2, 1, 0, 1, 3, 2, 0, 4, 1, 5, 9, 0, 2, 6, 8, 3, 0, 1],
    [2, 3, 1, 0, 6, 4, 3, 1, 0, 2, 5, 1, 0, 2, 8, 0, 3, 4, 1, 6, 0, 7, 2, 1, 5, 0, 3, 0, 2, 1, 4, 0, 8, 9],
    [1, 3, 0, 6, 2, 5, 1, 0, 3, 4, 8, 2, 0, 1, 0, 2, 3, 1, 6, 0, 4, 2, 0, 1, 5, 7, 3, 8, 9, 0, 1, 2, 0, 4],
    [4, 1, 2, 0, 3, 1, 9, 6, 0, 5, 2, 1, 0, 3, 4, 2, 1, 0, 2, 5, 1, 3, 0, 2, 1, 7, 4, 0, 3, 5, 1, 2, 0, 3],
  ],
  // 1 − 0.958536 = 4.1464%
  houseEdgeBps: 414,
};

export const SLOTS_MACHINES: Readonly<Record<SlotMachineId, SlotMachine>> = {
  'ore-rush': ORE_RUSH,
  monument: OCEAN_MONUMENT,
};
export const SLOTS_MACHINE_IDS = Object.keys(SLOTS_MACHINES) as [SlotMachineId, ...SlotMachineId[]];

/* Ore Rush under the names it shipped with. */
export const SLOTS_HOUSE_EDGE_BPS = ORE_RUSH.houseEdgeBps;
export const SLOTS_FREE_MULTIPLIER = ORE_RUSH.freeMultiplier;
export const SLOTS_SYMBOLS = ORE_RUSH.symbols;
export const SLOTS_WILD = ORE_RUSH.wild;
export const SLOTS_SCATTER = ORE_RUSH.scatter;
export const SLOTS_SCATTER_PAY_X = ORE_RUSH.scatterPayX;
export const SLOTS_SCATTER_SPINS = ORE_RUSH.scatterSpins;
export const SLOTS_STRIPS = ORE_RUSH.strips;

const TWO_POW_52 = 2 ** 52;

export interface SlotLineWin {
  line: number;
  symbol: number;
  count: number;
  /** What the wilds in the run multiplied the line by: 1 without a multiplying wild. */
  multiplier: number;
  /** Line-bet multiples, the wilds' multiplier included. */
  pays: number;
}

export interface SlotSpinResult {
  /** Strip index in the top row of each reel. */
  stops: number[];
  /** grid[reel][row], symbol indices. */
  grid: number[][];
  free: boolean;
  lines: SlotLineWin[];
  books: number;
  /** Free spins this spin awarded (after the round's ceiling). */
  awarded: number;
  /** What the spin paid, in tenths of the stake, before the free-spin multiplier. */
  units: number;
  payoutMinor: bigint;
}

export interface SlotRound {
  spins: SlotSpinResult[];
  freeSpins: number;
  payoutMinor: bigint;
  capped: boolean;
}

/** The strip index each reel stops at for spin `spin` of the round. */
export function spinStops(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  spin: number,
  machine: SlotMachine = ORE_RUSH,
): number[] {
  if (!Number.isInteger(spin) || spin < 0 || spin > SLOTS_MAX_FREE_SPINS) throw new RangeError('spin out of range');
  return machine.strips.map((strip, reel) => {
    const digest = createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${spin}:${reel}`, 'utf8')
      .digest('hex');
    const sample = Number.parseInt(digest.slice(0, 13), 16) / TWO_POW_52;
    return Math.floor(sample * strip.length);
  });
}

/** The three symbols showing on each reel. */
export function windowOf(stops: readonly number[], machine: SlotMachine = ORE_RUSH): number[][] {
  if (stops.length !== SLOTS_REELS) throw new RangeError('one stop per reel');
  return stops.map((top, reel) => {
    const strip = machine.strips[reel]!;
    if (!Number.isInteger(top) || top < 0 || top >= strip.length) throw new RangeError('stop off the strip');
    return [0, 1, 2].map((row) => strip[(top + row) % strip.length]!);
  });
}

/** What a window pays, in tenths of the stake (line pays are already tenths: line bet = stake / 10). */
export function evaluateWindow(
  grid: readonly (readonly number[])[],
  machine: SlotMachine = ORE_RUSH,
): { lines: SlotLineWin[]; books: number; units: number } {
  const { wild, scatter } = machine;
  const lines: SlotLineWin[] = [];
  SLOTS_LINES.forEach((rows, line) => {
    const first = grid[0]![rows[0]!]!;
    if (first === wild || first === scatter) return;
    let count = 1;
    let wilds = 0;
    while (count < SLOTS_REELS) {
      const symbol = grid[count]![rows[count]!]!;
      if (symbol === wild) wilds += 1;
      else if (symbol !== first) break;
      count += 1;
    }
    if (count < 3) return;
    const multiplier = machine.wildMultiplier ** wilds;
    lines.push({ line, symbol: first, count, multiplier, pays: machine.symbols[first]!.pays[count - 3]! * multiplier });
  });
  let books = 0;
  for (const column of grid) for (const symbol of column) if (symbol === scatter) books += 1;
  const scatterUnits = (machine.scatterPayX[books] ?? 0) * 10;
  return { lines, books, units: lines.reduce((sum, win) => sum + win.pays, 0) + scatterUnits };
}

/** The largest stake whose best round still pays within `maxPayoutMinor`. */
export function maxStakeFor(maxPayoutMinor: bigint): bigint {
  return maxPayoutMinor / BigInt(SLOTS_MAX_WIN_X);
}

/**
 * The whole round a stake buys: the paid spin and every free spin it leads to, each spin's payout
 * floored on its own, the total held to SLOTS_MAX_WIN_X stakes.
 */
export function playRound(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  stakeMinor: bigint,
  machine: SlotMachine = ORE_RUSH,
): SlotRound {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  return replayRound(stakeMinor, machine, (spin) => spinStops(serverSeed, clientSeed, nonce, spin, machine));
}

/** The same round rebuilt from stored stops, for history and the fairness page. */
export function roundFromStops(
  stakeMinor: bigint,
  flatStops: readonly number[],
  machine: SlotMachine = ORE_RUSH,
): SlotRound {
  if (flatStops.length === 0 || flatStops.length % SLOTS_REELS !== 0) throw new RangeError('stops come in fives');
  const round = replayRound(stakeMinor, machine, (spin) => flatStops.slice(spin * SLOTS_REELS, (spin + 1) * SLOTS_REELS));
  if (round.spins.length * SLOTS_REELS !== flatStops.length) throw new RangeError('stops do not match the round');
  return round;
}

function replayRound(stakeMinor: bigint, machine: SlotMachine, stopsFor: (spin: number) => number[]): SlotRound {
  const cap = stakeMinor * BigInt(SLOTS_MAX_WIN_X);
  const spins: SlotSpinResult[] = [];
  let total = 0n;
  let left = 0;
  let freeSpins = 0;
  let capped = false;
  for (let spin = 0; spin === 0 || left > 0; spin += 1) {
    const free = spin > 0;
    if (free) {
      left -= 1;
      freeSpins += 1;
    }
    const stops = stopsFor(spin);
    const grid = windowOf(stops, machine);
    const { lines, books, units } = evaluateWindow(grid, machine);
    const mult = BigInt(free ? machine.freeMultiplier : 1);
    let payout = (stakeMinor * BigInt(units) * mult) / 10n;
    if (total + payout >= cap) {
      payout = cap - total;
      capped = true;
    }
    total += payout;
    // Free spins awarded, held so the round never plays more than SLOTS_MAX_FREE_SPINS.
    const room = SLOTS_MAX_FREE_SPINS - freeSpins - left;
    const awarded = capped ? 0 : Math.max(0, Math.min(machine.scatterSpins[books] ?? 0, room));
    left += awarded;
    spins.push({ stops, grid, free, lines, books, awarded, units, payoutMinor: payout });
    if (capped) break;
  }
  return { spins, freeSpins, payoutMinor: total, capped };
}
