import { createHmac } from 'node:crypto';

/**
 * Stocks — one shared price chart, and leveraged long and short positions on it (2026-11-13).
 *
 * The owner: "its basically like a chart that goes up and down yk like crypto or stocks and ppl can
 * long or short it with a leverage of up to 1000x", with a 10% edge.
 *
 * ── the chart: a price on a fine grid ──
 * The price is always BASE · U^level for a whole-number level, U = 1 + STEP (0.0025%). It moves one
 * level at a time, up with probability Q = 1 / (2 + STEP), down otherwise, thousands of times a tick
 * (how many is the market's mood, below). Q is chosen so that
 *
 *     E[price after a move] = price · (Q·U + (1 − Q)/U) = price:
 *
 * the price is a martingale. Whatever a player does -- open, hold, close early or late, at any
 * leverage -- the chart itself neither helps nor hurts them on average. The chart shows each tick's
 * closing level; every tick also keeps its low and high, because a position is liquidated by any
 * move that touches its level, inside a tick or not.
 *
 * ── provably fair ──
 * A tick's moves come from HMAC-SHA256(serverSeed, `${epochId}:${tick}`): its 32 bytes seed
 * xoshiro128** (four little-endian 32-bit words), and each move is up when the next 32-bit output is
 * below Q · 2^32. An epoch is fixed the moment its seed is drawn; its hash is published before it
 * starts and the seed once it ends, so anyone can replay every move.
 *
 * ── the edge, exactly 10% at every leverage ──
 * A position is settled against an entry price a little worse than the market: it opens already
 * down a fee f of its stake, and because the price is a martingale that is what it is worth on
 * average whenever the player closes -- −f · stake, for any strategy.
 *
 * Liquidation cannot leak value either. The liquidation price sits on a grid level n levels from the
 * open, and the price only moves one level at a time, so it lands on that level exactly, where the
 * loss is exactly the stake. (On a price that jumps, it could land beyond it, and the player would
 * lose only the stake, not the extra: free insurance worth a lot at high leverage.) n is the grid
 * level nearest to where the loss reaches the stake, and the leverage the position runs at is set
 * from it (effectiveLeverage) so that f is exactly EDGE: 10.00% on every position, at every
 * leverage (stocks.test.ts checks every leverage, and simulates strategies).
 *
 * With Δ = level − open level, a position of `stake` at leverage L pays
 *
 *     long:   stake · L' · (U^Δ − U^−n)      liquidated at Δ = −n
 *     short:  stake · L' · (U^n − U^Δ)       liquidated at Δ = +n
 *
 * and is closed at the game's payout cap when it reaches the cap level.
 */

export const STOCKS_EDGE_BPS = 1000;
export const STOCKS_TICK_MS = 100;
/** Two minutes of ticks to an epoch: each seed is revealed two minutes after its hash went out. */
export const STOCKS_EPOCH_TICKS = 1200;
/** One grid level: 0.0025%. */
export const STOCKS_STEP_PPM = 25;
/**
 * ── the market's mood: how many moves a tick makes ──
 * The owner: "i want it to be way more volatile i want it to be made to trade on 1s timeframes",
 * then "make sure its volatile asf and risky asf". A steady random walk looks equally calm at any
 * size once a chart fits it, so the market has moods. Every 4 seconds (a block of 40 ticks) it is
 * calm, normal, wild or in a frenzy, and moves that many times a tick; any tick may also spike,
 * moving 8 times as often. On average about 0.8% a second, 1.6% in a frenzy, and a spike can move
 * 1.5% in a tenth of a second. At 100x a position lives for seconds; at 1000x, for a tick or two.
 *
 * Only the NUMBER of moves changes, never a move: each is still one level, up with probability Q,
 * so the price is still a martingale, liquidation still lands exactly on its level, and the fee is
 * still exactly the edge. Both are drawn from the seed as well (paceOf, tickPlan), so a revealed seed
 * replays them too.
 */
export const STOCKS_PACE_BLOCK_TICKS = 40;
/** The moods, as [chance, moves a tick]: calm, normal, wild, frenzy. */
export const STOCKS_PACES: readonly (readonly [number, number])[] = [
  [0.40, 2_500],
  [0.35, 6_000],
  [0.18, 16_000],
  [0.07, 40_000],
];
export const STOCKS_SPIKE_CHANCE = 0.015;
export const STOCKS_SPIKE_FACTOR = 8;
/** The price at level 0. */
export const STOCKS_BASE_PRICE = 1000;
export const STOCKS_MAX_LEVERAGE = 1000;
/** The least leverage a position may take. The owner: "risky asf and not some 2x leverage shit". */
export const STOCKS_MIN_LEVERAGE = 10;

export type Side = 'long' | 'short';

const ratio = (stepPpm: number) => 1 + stepPpm / 1_000_000;

/** The price at a level, for display and records. Every decision is made on levels. */
export function priceAt(level: number, stepPpm = STOCKS_STEP_PPM): number {
  return STOCKS_BASE_PRICE * ratio(stepPpm) ** level;
}

/** The chance a move goes up, as a 32-bit threshold: up when the draw is below it. */
export function upThreshold(stepPpm = STOCKS_STEP_PPM): number {
  return Math.floor((1 / (2 + stepPpm / 1_000_000)) * 2 ** 32);
}

/** xoshiro128**, seeded from a tick's HMAC: the 32-bit draws behind that tick's moves. */
function drawsFor(digest: Buffer): () => number {
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  if ((a | b | c | d) === 0) a = 1; // the all-zero state never moves; 2^-128, but cheap to close
  return () => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result;
  };
}
const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

/**
 * The mood of a tick's 4-second block: the moves each of its ticks makes, before any spike. The
 * first 32-bit word of HMAC-SHA256(serverSeed, `${epochId}:pace:${block}`), read as a share of 2^32,
 * picks from STOCKS_PACES in order.
 */
export function paceOf(serverSeed: string, epochId: string, tick: number): number {
  const block = Math.floor(tick / STOCKS_PACE_BLOCK_TICKS);
  const draw = createHmac('sha256', serverSeed).update(`${epochId}:pace:${block}`).digest().readUInt32LE(0) / 2 ** 32;
  let below = 0;
  for (const [chance, moves] of STOCKS_PACES) {
    below += chance;
    if (draw < below) return moves;
  }
  return STOCKS_PACES[STOCKS_PACES.length - 1]![1];
}

const SPIKE_THRESHOLD = Math.floor(STOCKS_SPIKE_CHANCE * 2 ** 32);

/**
 * A tick's draws and how many moves it makes. The tick's first draw decides a spike (below
 * SPIKE_CHANCE · 2^32: the block's pace times SPIKE_FACTOR); every draw after it is one move.
 */
function tickPlan(serverSeed: string, epochId: string, tick: number, pace: number): { next: () => number; moves: number } {
  const next = drawsFor(createHmac('sha256', serverSeed).update(`${epochId}:${tick}`).digest());
  const spiked = next() < SPIKE_THRESHOLD;
  return { next, moves: spiked ? pace * STOCKS_SPIKE_FACTOR : pace };
}

/** How many moves a tick makes. */
export function tickMoveCount(serverSeed: string, epochId: string, tick: number): number {
  return tickPlan(serverSeed, epochId, tick, paceOf(serverSeed, epochId, tick)).moves;
}

/** The levels a tick moves through, after each of its moves, starting from `from`. */
export function tickMoves(serverSeed: string, epochId: string, tick: number, from: number, stepPpm = STOCKS_STEP_PPM): Int32Array {
  const { next, moves } = tickPlan(serverSeed, epochId, tick, paceOf(serverSeed, epochId, tick));
  const threshold = upThreshold(stepPpm);
  const levels = new Int32Array(moves);
  let level = from;
  for (let move = 0; move < moves; move += 1) {
    level += next() < threshold ? 1 : -1;
    levels[move] = level;
  }
  return levels;
}

export interface EpochPath {
  /** The level each tick closes at. Tick 0 is the epoch's start level and does not move. */
  readonly close: Int32Array;
  readonly low: Int32Array;
  readonly high: Int32Array;
}

/**
 * Every tick of an epoch, `chunk` ticks at a time: yields between chunks and returns the path. The
 * one implementation behind epochPath (all at once) and epochPathAsync (a chunk per turn of the
 * event loop), so both give the same path.
 */
function* epochSteps(
  serverSeed: string,
  epochId: string,
  startLevel: number,
  ticks: number,
  stepPpm: number,
  chunk: number,
): Generator<void, EpochPath> {
  const close = new Int32Array(ticks);
  const low = new Int32Array(ticks);
  const high = new Int32Array(ticks);
  close[0] = low[0] = high[0] = startLevel;
  const threshold = upThreshold(stepPpm);
  let pace = 0;
  for (let tick = 1; tick < ticks; tick += 1) {
    if (tick === 1 || tick % STOCKS_PACE_BLOCK_TICKS === 0) pace = paceOf(serverSeed, epochId, tick);
    const { next, moves } = tickPlan(serverSeed, epochId, tick, pace);
    let level = close[tick - 1]!;
    let lo = level;
    let hi = level;
    for (let move = 0; move < moves; move += 1) {
      level += next() < threshold ? 1 : -1;
      if (level < lo) lo = level;
      else if (level > hi) hi = level;
    }
    close[tick] = level;
    low[tick] = lo;
    high[tick] = hi;
    if (tick % chunk === 0) yield;
  }
  return { close, low, high };
}

/** Every tick of an epoch: close, low and high. About 12 million moves, some 170ms. */
export function epochPath(
  serverSeed: string,
  epochId: string,
  startLevel: number,
  ticks = STOCKS_EPOCH_TICKS,
  stepPpm = STOCKS_STEP_PPM,
): EpochPath {
  const steps = epochSteps(serverSeed, epochId, startLevel, ticks, stepPpm, ticks);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * The same path, built 60 ticks (a few milliseconds) at a time with the event loop let through in
 * between, so building an epoch never stalls the API, the other games or the chart's broadcast.
 */
export async function epochPathAsync(
  serverSeed: string,
  epochId: string,
  startLevel: number,
  ticks = STOCKS_EPOCH_TICKS,
  stepPpm = STOCKS_STEP_PPM,
): Promise<EpochPath> {
  const steps = epochSteps(serverSeed, epochId, startLevel, ticks, stepPpm, 60);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * How many levels from the open a position at leverage L is liquidated: the grid level nearest to
 * where the loss would reach the stake. Null when the leverage is too high for the grid to hold even
 * one level.
 */
export function liquidationLevels(side: Side, leverage: number, stepPpm = STOCKS_STEP_PPM, edgeBps = STOCKS_EDGE_BPS): number | null {
  if (!Number.isInteger(leverage) || leverage < 1) throw new RangeError('leverage must be a whole number of at least 1');
  const lnU = Math.log(ratio(stepPpm));
  const room = 1 - edgeBps / 10_000; // the share of the stake a price move may take before liquidation
  const exact = side === 'long'
    ? -Math.log(1 - room / leverage) / lnU
    : Math.log(1 + room / leverage) / lnU;
  const n = Math.round(exact);
  return n >= 1 ? n : null;
}

/**
 * The leverage a position really runs at, given its liquidation level: the one that makes the fee
 * exactly EDGE and the loss at that level exactly the stake. Within about 1.5% of the leverage asked
 * for at 1000x, and indistinguishable from it below 100x.
 *
 *   long:   L' · (1 − U^−n) = 1 − EDGE         short:   L' · (U^n − 1) = 1 − EDGE
 */
export function effectiveLeverage(side: Side, n: number, stepPpm = STOCKS_STEP_PPM, feePpm = STOCKS_EDGE_BPS * 100): number {
  const u = ratio(stepPpm);
  const room = 1 - feePpm / 1_000_000;
  return side === 'long' ? room / (1 - u ** -n) : room / (u ** n - 1);
}

export interface PositionTerms {
  readonly side: Side;
  readonly stakeMinor: bigint;
  readonly leverage: number;
  readonly openLevel: number;
  readonly maxPayoutMinor: bigint;
}

export interface Position extends PositionTerms {
  /** The fee as a share of the stake, in parts per million: EDGE, for every position. */
  readonly feePpm: number;
  /** Where the position is liquidated: openLevel − n for a long, openLevel + n for a short. */
  readonly liquidationLevel: number;
  /** The level at which the payout reaches the cap; null when no level can get there. */
  readonly capLevel: number | null;
}

export interface Opened extends Position {
  readonly effectiveLeverage: number;
  readonly openPrice: number;
  readonly entryPrice: number;
  readonly liquidationPrice: number;
  readonly capPrice: number | null;
}

/** Everything a position opens with. Throws when the leverage or the stake does not fit. */
export function openPosition(terms: PositionTerms, stepPpm = STOCKS_STEP_PPM, edgeBps = STOCKS_EDGE_BPS): Opened {
  const { side, stakeMinor, leverage, openLevel, maxPayoutMinor } = terms;
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  if (maxPayoutMinor <= stakeMinor) throw new RangeError('the cap must be above the stake');
  const n = liquidationLevels(side, leverage, stepPpm, edgeBps);
  if (n === null) throw new RangeError('that leverage is too high for the chart');
  const feePpm = edgeBps * 100;
  const L = effectiveLeverage(side, n, stepPpm, feePpm);
  const u = ratio(stepPpm);
  const lnU = Math.log(u);
  const capShare = Number(maxPayoutMinor) / (Number(stakeMinor) * L);
  let capDelta: number | null;
  if (side === 'long') {
    // stake·L'·(U^Δ − U^−n) ≥ cap  ⇔  Δ ≥ ln(cap/(stake·L') + U^−n) / ln U.
    capDelta = Math.ceil(Math.log(capShare + u ** -n) / lnU);
  } else {
    // stake·L'·(U^n − U^Δ) ≥ cap  ⇔  U^Δ ≤ U^n − cap/(stake·L'): out of reach when not positive.
    const room = u ** n - capShare;
    capDelta = room > 0 ? Math.floor(Math.log(room) / lnU) : null;
  }
  const fee = feePpm / 1_000_000;
  const open = priceAt(openLevel, stepPpm);
  const liquidationLevel = side === 'long' ? openLevel - n : openLevel + n;
  const capLevel = capDelta === null ? null : openLevel + capDelta;
  return {
    ...terms,
    feePpm,
    liquidationLevel,
    capLevel,
    effectiveLeverage: L,
    openPrice: open,
    // The price the position is settled against: worse than the market by fee/L' of it.
    entryPrice: side === 'long' ? open * (1 + fee / L) : open * (1 - fee / L),
    liquidationPrice: priceAt(liquidationLevel, stepPpm),
    capPrice: capLevel === null ? null : priceAt(capLevel, stepPpm),
  };
}

/** What the position pays if closed at `level`, floored, within [0, cap]. */
export function payoutAt(position: Position, level: number, stepPpm = STOCKS_STEP_PPM): bigint {
  const u = ratio(stepPpm);
  const delta = level - position.openLevel;
  const n = Math.abs(position.liquidationLevel - position.openLevel);
  const L = effectiveLeverage(position.side, n, stepPpm, position.feePpm);
  const share = position.side === 'long' ? u ** delta - u ** -n : u ** n - u ** delta;
  const value = Number(position.stakeMinor) * L * share;
  if (!(value > 0)) return 0n;
  const floored = BigInt(Math.floor(value));
  return floored > position.maxPayoutMinor ? position.maxPayoutMinor : floored;
}

export type Outcome = 'liquidated' | 'capped';

/** Whether a single level ends the position, and how. */
export function outcomeAt(position: Position, level: number): Outcome | null {
  if (position.side === 'long') {
    if (level <= position.liquidationLevel) return 'liquidated';
    if (position.capLevel !== null && level >= position.capLevel) return 'capped';
    return null;
  }
  if (level >= position.liquidationLevel) return 'liquidated';
  if (position.capLevel !== null && level <= position.capLevel) return 'capped';
  return null;
}

/**
 * Whether a tick, from its low and high, ends the position, and how. When the tick reaches both the
 * liquidation and the cap level, `moves` (the tick's levels in order, from tickMoves) decides which
 * came first; it is only asked for in that case.
 */
export function outcomeInTick(
  position: Position,
  low: number,
  high: number,
  moves: () => Int32Array,
): Outcome | null {
  const liquidated = position.side === 'long' ? low <= position.liquidationLevel : high >= position.liquidationLevel;
  const capped =
    position.capLevel !== null &&
    (position.side === 'long' ? high >= position.capLevel : low <= position.capLevel);
  if (liquidated && capped) {
    for (const level of moves()) {
      const outcome = outcomeAt(position, level);
      if (outcome) return outcome;
    }
  }
  if (liquidated) return 'liquidated';
  if (capped) return 'capped';
  return null;
}
