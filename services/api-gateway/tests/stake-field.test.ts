import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/* Every game's stake field (2026-11-09, the operator's ask): a Max button beside ½ and 2×, and the
 * full keyboard on a phone. The fields asked for the number pad (inputmode="decimal"), which has no
 * letters, so "10m" could not be typed there although parseAmount has always read it. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const source = async (file: string) =>
  (await readFile(path.join(frontend, 'assets/js', file), 'utf8')).replace(/\r\n/g, '\n');

type Util = {
  adjustStake: (adj: string, current: unknown, balance: unknown, ceiling: unknown) => bigint;
  parseAmount: (input: string) => number | null;
};
const util = async () => (await import(pathToFileURL(path.join(frontend, 'assets/js/util.js')).href)) as Util;

/* [file, the stake input's id, the button class, what Max is capped at] */
const GAMES: [string, string, string, string][] = [
  ['crash.js', 'crashStake', 'crash', 'snap?.config?.maxStakeMinor'],
  ['chicken.js', 'chickenStake', 'chicken', 'config?.maxStakeMinor'],
  ['blackjack.js', 'bjStake', 'bj', 'config?.maxStakeMinor'],
  ['dice.js', 'diceStake', 'dice', 'largestRoll()'],
  ['derby.js', 'derbyStake', 'derby', 'maxStake()'],
  ['tower.js', 'towerStake', 'tower', 'config?.maxStakeMinor'],
  ['mines.js', 'minesStake', 'mines', 'config?.maxStakeMinor'],
  ['fishing.js', 'fishingStake', 'fishing', 'maxStake()'],
  ['icefishing.js', 'icefishStake', 'icefish', 'config?.maxStakeMinor'],
  ['plinko.js', 'plinkoStake', 'plinko', 'boardMaxStake()'],
  ['slots.js', '${P}Stake', 'slots', 'maxStake()'],
];

describe('the stake field', () => {
  it('Max is the balance, capped at the most the game takes', async () => {
    const { adjustStake } = await util();
    assert.equal(adjustStake('max', 5_000_000n, '250000000', '100000000'), 100_000_000n);
    assert.equal(adjustStake('max', 5_000_000n, '40000000', '100000000'), 40_000_000n);
    // The game has not answered yet: the balance alone.
    assert.equal(adjustStake('max', 0n, '40000000', 0n), 40_000_000n);
    assert.equal(adjustStake('max', 0n, '40000000', undefined), 40_000_000n);
    // Signed out, or broke: nothing.
    assert.equal(adjustStake('max', 1_000_000n, '0', '100000000'), 0n);
    assert.equal(adjustStake('max', 1_000_000n, undefined, '100000000'), 0n);
    // ½ and 2× as before.
    assert.equal(adjustStake('half', 3_000_001n, '0', 0n), 1_500_000n);
    assert.equal(adjustStake('double', 3_000_000n, '0', 0n), 6_000_000n);
  });

  /* 2026-11-10: halving 15.6k put "7812" in the box. What a button writes is cut to three figures in
   * its unit, always down, and the box shows it with the unit -- and bets exactly what it shows. */
  it('writes three figures with a unit, and bets exactly what the box says', async () => {
    const { adjustStake, parseAmount, formatAmountInput } = await util() as Util & { formatAmountInput: (n: number) => string };
    const box = (value: bigint) => formatAmountInput(Number(value));
    assert.equal(box(adjustStake('half', 15_625n, '0', 0n)), '7.81k');
    assert.equal(box(adjustStake('half', 15_600n, '0', 0n)), '7.8k');
    assert.equal(box(adjustStake('double', 7_810n, '0', 0n)), '15.6k');
    assert.equal(box(adjustStake('half', 125_000n, '0', 0n)), '62.5k');
    // Max goes down, never up: never more than the balance or the ceiling.
    assert.equal(adjustStake('max', 0n, '2512345678', 0n), 2_510_000_000n);
    assert.equal(box(adjustStake('max', 0n, '2512345678', 0n)), '2.51b');
    assert.equal(box(adjustStake('max', 0n, '100101500', 0n)), '100m');
    assert.equal(adjustStake('max', 0n, '2512345678', '1000000000'), 1_000_000_000n);
    // Under a thousand nothing is cut.
    assert.equal(adjustStake('half', 999n, '0', 0n), 499n);
    // What the box shows is what is bet.
    for (const stake of [7_810n, 15_600n, 2_510_000_000n, 62_500n, 499n]) {
      assert.equal(parseAmount(box(stake)), Number(stake));
    }
    // A figure typed by hand is shown as typed: 7812 is not quietly made 7.81k.
    assert.equal(formatAmountInput(7_812), '7812');
    assert.equal(formatAmountInput(1_234), '1234');
  });

  it('every game has ½, 2× and Max, all through the one rule', async () => {
    for (const [file, , cls, ceiling] of GAMES) {
      const code = await source(file);
      assert.match(code, new RegExp(`class="${cls}__adj" data-adj="max" aria-label="Bet the most you can">Max</button>`), file);
      assert.ok(code.includes(`adjustStake(button.dataset.adj, current, state.balanceMinor, ${ceiling})`), `${file}: Max capped at ${ceiling}`);
      assert.doesNotMatch(code, /dataset\.adj === 'half' \? current \/ 2n : current \* 2n/, file);
    }
    const duel = await source('mines-duel.js');
    assert.match(duel, /const most = el\('button', 'mduel__adj', 'Max'\);/);
    assert.match(duel, /most\.addEventListener\('click', scale\('max'\)\);/);
    assert.match(duel, /adjustStake\(mul, current, state\.balanceMinor, board\.maxStakeMinor\)/);
  });

  it('opens the full keyboard on a phone, so "10m" can be typed', async () => {
    const { parseAmount } = await util();
    assert.equal(parseAmount('10m'), 10_000_000);
    assert.equal(parseAmount('1.5B'), 1_500_000_000);
    for (const [file, id] of GAMES) {
      const code = await source(file);
      assert.ok(code.includes(`<input id="${id}" inputmode="text" autocapitalize="off"`), `${file}: ${id}`);
    }
    // The withdrawal amount, a tip, a staking amount and a duel's stake too.
    assert.match(await source('app.js'), /<input id="wdAmount" class="auth__input" type="text" inputmode="text"/);
    for (const [file, name] of [['chat.js', 'field'], ['staking.js', 'input'], ['mines-duel.js', 'input']]) {
      const code = await source(file!);
      assert.ok(code.includes(`${name}.inputMode = 'text';`), file);
      assert.ok(!code.includes(`${name}.inputMode = 'decimal';`), file);
    }
  });
});
