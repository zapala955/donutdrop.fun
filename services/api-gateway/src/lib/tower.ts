import { createHmac } from 'node:crypto';

/**
 * Tower — nine floors, each a row of tiles with TNT behind some of them. The player climbs one
 * floor at a time by turning one tile on it; a gem goes up a floor, TNT loses the stake, and they
 * may cash out after any floor cleared.
 *
 * ── the modes ──
 * A mode is how many tiles a floor has and how many of them are TNT:
 *
 *     easy    4 tiles, 1 TNT   (3 in 4 safe)
 *     medium  3 tiles, 1 TNT   (2 in 3 safe)
 *     hard    2 tiles, 1 TNT   (1 in 2 safe)
 *     expert  3 tiles, 2 TNT   (1 in 3 safe)
 *
 * ── the edge ──
 * Every floor is its own draw, so the chance of clearing k floors is (safe / tiles)^k, and the
 * multiplier for cashing out after k floors is (1 − edge) · (tiles / safe)^k. Cashing out after k
 * floors therefore returns (1 − edge) of the stake on average, for every k and every mode: a
 * player's only choice is when to stop, so every strategy returns the same 90%, the same edge as
 * Mines. Multipliers and payouts are floored, which can only widen that edge.
 *
 * ── provably fair ──
 * The TNT is placed when the game starts, from the player's committed server seed, their client
 * seed and the seed's nonce. Floor f is a partial Fisher–Yates shuffle of its tiles in which step i
 * draws HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${f}:${i}`), first 52 bits; the first
 * `traps` tiles of the shuffle are that floor's TNT. The seed is revealed when the game ends, and
 * not before: it is the whole tower.
 */

export const TOWER_FLOORS = 9;
export const TOWER_HOUSE_EDGE_BPS = 1000;

export const TOWER_MODES = {
  easy: { tiles: 4, traps: 1 },
  medium: { tiles: 3, traps: 1 },
  hard: { tiles: 2, traps: 1 },
  expert: { tiles: 3, traps: 2 },
} as const;

export type TowerMode = keyof typeof TOWER_MODES;
export const TOWER_MODE_NAMES = Object.keys(TOWER_MODES) as TowerMode[];

const TWO_POW_52 = 2 ** 52;

/**
 * The whole tower's TNT, bottom floor first: floor f's TNT tiles (0-based, left to right) are
 * entries f·traps … f·traps + traps − 1, sorted within the floor.
 */
export function trapLayout(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  mode: TowerMode,
): number[] {
  const { tiles, traps } = modeOf(mode);
  const layout: number[] = [];
  for (let floor = 0; floor < TOWER_FLOORS; floor += 1) {
    const order = Array.from({ length: tiles }, (_, index) => index);
    for (let i = 0; i < traps; i += 1) {
      const digest = createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}:${floor}:${i}`, 'utf8')
        .digest('hex');
      const sample = Number.parseInt(digest.slice(0, 13), 16) / TWO_POW_52;
      const j = i + Math.floor(sample * (tiles - i));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    layout.push(...order.slice(0, traps).sort((a, b) => a - b));
  }
  return layout;
}

/** The TNT tiles on one floor of a layout. */
export function trapsOnFloor(layout: readonly number[], mode: TowerMode, floor: number): number[] {
  const { traps } = modeOf(mode);
  assertFloor(floor, TOWER_FLOORS - 1);
  return layout.slice(floor * traps, floor * traps + traps);
}

/**
 * The exact odds against clearing `cleared` floors, as a fraction: numerator over denominator, so
 * that numerator / denominator = 1 / P(cleared).
 */
export function oddsAgainst(mode: TowerMode, cleared: number): { num: bigint; den: bigint } {
  const { tiles, traps } = modeOf(mode);
  assertFloor(cleared, TOWER_FLOORS);
  return { num: BigInt(tiles) ** BigInt(cleared), den: BigInt(tiles - traps) ** BigInt(cleared) };
}

/** The multiplier for cashing out after `cleared` floors, in basis points, floored. */
export function multiplierBps(mode: TowerMode, cleared: number): number {
  const { num, den } = oddsAgainst(mode, cleared);
  return Number((BigInt(10_000 - TOWER_HOUSE_EDGE_BPS) * num) / den);
}

/** What cashing out after `cleared` floors pays on this stake, floored, before any cap. */
export function payoutFor(stakeMinor: bigint, mode: TowerMode, cleared: number): bigint {
  if (stakeMinor <= 0n) throw new RangeError('stake must be positive');
  const { num, den } = oddsAgainst(mode, cleared);
  return (stakeMinor * BigInt(10_000 - TOWER_HOUSE_EDGE_BPS) * num) / (10_000n * den);
}

/** The chance, in basis points, that the tile picked on any floor is safe. */
export function safeChanceBps(mode: TowerMode): number {
  const { tiles, traps } = modeOf(mode);
  return Math.floor(((tiles - traps) * 10_000) / tiles);
}

export function isTowerMode(value: unknown): value is TowerMode {
  return typeof value === 'string' && Object.hasOwn(TOWER_MODES, value);
}

export function modeOf(mode: TowerMode): { tiles: number; traps: number } {
  if (!isTowerMode(mode)) throw new RangeError(`unknown tower mode ${String(mode)}`);
  return TOWER_MODES[mode];
}

function assertFloor(value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`floor must be between 0 and ${max}`);
  }
}
