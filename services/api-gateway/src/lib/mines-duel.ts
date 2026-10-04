import { createHmac } from 'node:crypto';
import { MINES_TILES } from './mines.js';

/**
 * mines-duel.ts — the rules of a 1v1 Mines Duel, with no database and no network in them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE GAME
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A 5x5 field with some TNT in it. Both players turn tiles on the SAME field at the same time,
 * neither able to see how the other is doing. A player may stop whenever they have turned at least
 * one safe tile ("lock in"); turning TNT ends their run with a score of zero; and anybody still
 * turning tiles when the clock runs out is locked in where they stand. The higher score wins the
 * pot less the rake. Equal scores are a draw and both stakes go back.
 *
 * The only decision is when to stop, and it is a real one: the opponent's score is unknown, so
 * every extra tile is a bet that the other player stopped sooner or hit TNT, against the chance
 * this tile is the one that ends you.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHO CAN INFLUENCE THE FIELD
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Same construction as a coinflip, for the same reason. The server seed is generated and its hash
 * published when the host opens the game; the host's client seed is fixed then; the opponent's is
 * supplied when they join. The field is a Fisher–Yates shuffle of the 25 tiles in which step i
 * draws
 *
 *     HMAC-SHA256(serverSeed, "minesduel:" + hostClientSeed + ":" + opponentClientSeed + ":" + i)
 *
 * (first 52 bits, as a fraction), and the first `mines` tiles of the shuffle are the TNT. The
 * opponent's seed changes the field but they choose it blind, because the server seed is only
 * revealed when the game ends; the server cannot pick a seed after the fact because the hash was
 * published first. Anyone can recompute the field from the reveal.
 *
 * The same field for both players means one player's bad luck is the other's too, so a duel is
 * decided by nerve rather than by who was dealt the kinder layout.
 */

export const DUEL_TILES = MINES_TILES;
/** The choices the page offers; the API accepts anything in [MIN, MAX]. */
export const DUEL_MINE_OPTIONS: readonly number[] = Object.freeze([3, 5, 8, 12]);
export const DUEL_MIN_MINES = 1;
export const DUEL_MAX_MINES = 20;

const TWO_POW_52 = 2 ** 52;

export type DuelOutcome = 'host' | 'opponent' | 'draw';
export type PlayerState = 'playing' | 'locked' | 'busted';

/** The TNT tiles, 0-24 in reading order, sorted. */
export function duelMinePositions(
  serverSeed: string,
  hostClientSeed: string,
  opponentClientSeed: string,
  mineCount: number,
): number[] {
  if (!Number.isInteger(mineCount) || mineCount < DUEL_MIN_MINES || mineCount > DUEL_MAX_MINES) {
    throw new RangeError(`mine count must be between ${DUEL_MIN_MINES} and ${DUEL_MAX_MINES}`);
  }
  const tiles = Array.from({ length: DUEL_TILES }, (_, index) => index);
  for (let i = 0; i < mineCount; i += 1) {
    const digest = createHmac('sha256', serverSeed)
      .update(`minesduel:${hostClientSeed}:${opponentClientSeed}:${i}`, 'utf8')
      .digest('hex');
    const sample = Number.parseInt(digest.slice(0, 13), 16) / TWO_POW_52;
    const j = i + Math.floor(sample * (DUEL_TILES - i));
    [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
  }
  return tiles.slice(0, mineCount).sort((a, b) => a - b);
}

/** The field as one integer: bit i set means tile i is TNT. */
export function maskOf(tiles: readonly number[]): number {
  let mask = 0;
  for (const tile of tiles) mask |= 1 << tile;
  return mask;
}

export function minesOfMask(mask: number): number[] {
  const tiles: number[] = [];
  for (let tile = 0; tile < DUEL_TILES; tile += 1) if ((mask >> tile) & 1) tiles.push(tile);
  return tiles;
}

export const isMine = (mask: number, tile: number): boolean => ((mask >> tile) & 1) === 1;

/** How many of these tiles were safe. */
export function safeCount(picks: readonly number[], mask: number): number {
  return picks.reduce((count, tile) => count + (isMine(mask, tile) ? 0 : 1), 0);
}

/** The most safe tiles a field can give: turning all of them leaves nothing more to turn. */
export const safeTiles = (mineCount: number): number => DUEL_TILES - mineCount;

/** A player's score once their run is over: TNT is zero, otherwise the safe tiles they turned. */
export function scoreOf(state: PlayerState, picks: readonly number[], mask: number): number {
  return state === 'busted' ? 0 : safeCount(picks, mask);
}

/** Higher score wins; equal scores are a draw. */
export function decide(hostScore: number, opponentScore: number): DuelOutcome {
  if (hostScore > opponentScore) return 'host';
  if (opponentScore > hostScore) return 'opponent';
  return 'draw';
}

/**
 * The chance, in basis points, that the next tile a player turns is safe, given how many safe tiles
 * they have already turned. Shown to the player; it is arithmetic on public numbers and tells them
 * nothing about where the TNT is.
 */
export function nextSafeChanceBps(mineCount: number, turned: number): number {
  const hidden = DUEL_TILES - turned;
  const safeLeft = DUEL_TILES - mineCount - turned;
  if (hidden <= 0 || safeLeft <= 0) return 0;
  return Math.floor((safeLeft * 10_000) / hidden);
}
