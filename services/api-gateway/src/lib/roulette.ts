import { createFairRoll } from '@donut/provably-fair';

export const ROULETTE_NUMBERS = 37;
export const ROULETTE_ORDER = Object.freeze([
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const);

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type RouletteSelection =
  | `straight:${number}`
  | 'red'
  | 'black'
  | 'odd'
  | 'even'
  | 'low'
  | 'high'
  | 'dozen:1'
  | 'dozen:2'
  | 'dozen:3';

export type RouletteBetClass = 'straight' | 'evenMoney' | 'dozen';

export function rouletteResult(
  serverSeed: string,
  roundId: string,
): {
  result: number;
  digest: string;
} {
  const roll = createFairRoll(serverSeed, roundId, 0);
  return { result: Math.floor(roll.roll * ROULETTE_NUMBERS), digest: roll.digest };
}

export function rouletteBetClass(selection: RouletteSelection): RouletteBetClass {
  if (selection.startsWith('straight:')) return 'straight';
  if (selection.startsWith('dozen:')) return 'dozen';
  return 'evenMoney';
}

/**
 * Gross return, including the stake, for one winning bet.
 *
 * Every market gets the same configured expected edge. There are 37 equally likely pockets, so
 * gross return = (1 - edge) * 37 / winning pockets. Integer basis points deliberately round down
 * by less than one ten-thousandth of the stake instead of ever promising money the table did not
 * price in.
 */
export function roulettePayoutBps(selection: RouletteSelection, houseEdgeBps: number): number {
  if (!Number.isInteger(houseEdgeBps) || houseEdgeBps < 0 || houseEdgeBps >= 10_000) {
    throw new RangeError('houseEdgeBps must be an integer between 0 and 9999');
  }
  const winningPockets =
    rouletteBetClass(selection) === 'straight'
      ? 1
      : rouletteBetClass(selection) === 'dozen'
        ? 12
        : 18;
  return Math.floor(((10_000 - houseEdgeBps) * ROULETTE_NUMBERS) / winningPockets);
}

export function rouletteWins(selection: RouletteSelection, result: number): boolean {
  if (!Number.isInteger(result) || result < 0 || result >= ROULETTE_NUMBERS) return false;
  if (selection.startsWith('straight:')) return Number(selection.slice(9)) === result;
  if (result === 0) return false;
  if (selection === 'red') return RED.has(result);
  if (selection === 'black') return !RED.has(result);
  if (selection === 'odd') return result % 2 === 1;
  if (selection === 'even') return result % 2 === 0;
  if (selection === 'low') return result <= 18;
  if (selection === 'high') return result >= 19;
  if (selection === 'dozen:1') return result <= 12;
  if (selection === 'dozen:2') return result >= 13 && result <= 24;
  return result >= 25;
}

export function roulettePayout(
  stakeMinor: bigint,
  selection: RouletteSelection,
  result: number,
  payoutBps: number,
): bigint {
  if (stakeMinor <= 0n || !rouletteWins(selection, result)) return 0n;
  if (!Number.isInteger(payoutBps) || payoutBps <= 10_000) {
    throw new RangeError('payoutBps must be an integer above 10000');
  }
  return (stakeMinor * BigInt(payoutBps)) / 10_000n;
}

export function rouletteColor(result: number): 'green' | 'red' | 'black' {
  if (result === 0) return 'green';
  return RED.has(result) ? 'red' : 'black';
}
