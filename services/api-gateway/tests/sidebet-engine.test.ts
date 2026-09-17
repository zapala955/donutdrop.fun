import assert from 'node:assert/strict';
import test from 'node:test';
import {
  impliedMultiplierBps,
  settlePool,
  shareFor,
  splitPool,
  type Bet,
} from '../src/lib/sidebet-engine.js';

const bet = (id: string, outcome: string, stakeMinor: bigint): Bet => ({
  id,
  userId: `user-${id}`,
  outcome,
  stakeMinor,
});

/* ═════════════════════════ the cut ═════════════════════════ */

test('a pool always splits exactly, at every size and every legal rate', () => {
  for (const pool of [0n, 1n, 7n, 999n, 1_000_000n, 99_999_999n, 10n ** 18n]) {
    for (const bps of [0, 1, 37, 300, 999, 1000]) {
      const split = splitPool(pool, bps);
      assert.equal(split.payoutMinor + split.rakeMinor, split.poolMinor, `pool=${pool} bps=${bps}`);
      assert.ok(split.rakeMinor >= 0n);
      assert.ok(split.payoutMinor >= 0n);
    }
  }
});

test('the cut truncates toward the players, never toward the house', () => {
  // 300bps of 2 is 0.06, which must floor to nothing rather than round up to a unit.
  assert.equal(splitPool(2n, 300).rakeMinor, 0n);
  assert.equal(splitPool(2n, 300).payoutMinor, 2n);
});

/* ═════════════════════════ settlement ═════════════════════════ */

test('the winning side splits the pool pro rata, and the whole pool is accounted for', () => {
  const bets = [
    bet('a', 'EXTRACT', 10_000_000n),
    bet('b', 'EXTRACT', 30_000_000n),
    bet('c', 'WIPEOUT', 20_000_000n),
  ];
  const result = settlePool(bets, 'EXTRACT', 300);

  assert.equal(result.poolMinor, 60_000_000n);
  assert.equal(result.rakeMinor, 1_800_000n);
  assert.equal(result.payoutMinor, 58_200_000n);
  assert.equal(result.voided, false);

  // b staked three times a, so b is paid three times a.
  assert.equal(result.payouts.get('c'), 0n, 'the losing side is paid nothing, explicitly');
  const paidA = result.payouts.get('a') ?? 0n;
  const paidB = result.payouts.get('b') ?? 0n;
  assert.equal(paidB, paidA * 3n);

  const distributed = [...result.payouts.values()].reduce((sum, value) => sum + value, 0n);
  assert.equal(
    distributed + result.rakeMinor,
    result.poolMinor,
    'every unit is either paid out or taken as the cut',
  );
});

test('the rounding remainder is given away, not dropped', () => {
  /* Three equal stakes cannot divide a payout that is not a multiple of three. The schema's
   * `side_bet_rake_adds_up` refuses a row where the pool does not reconcile, so dropping the
   * remainder would not merely be unfair — the settlement would fail to write. */
  const bets = [
    bet('a', 'YES', 1n),
    bet('b', 'YES', 1n),
    bet('c', 'YES', 1n),
    bet('d', 'NO', 7n),
  ];
  const result = settlePool(bets, 'YES', 0);
  const distributed = [...result.payouts.values()].reduce((sum, value) => sum + value, 0n);
  assert.equal(distributed, result.payoutMinor);
  assert.equal(distributed + result.rakeMinor, result.poolMinor);
});

test('a side nobody backed voids the market and refunds at face value', () => {
  const bets = [bet('a', 'EXTRACT', 5_000_000n), bet('b', 'EXTRACT', 1_000_000n)];
  const result = settlePool(bets, 'WIPEOUT', 300);

  assert.equal(result.voided, true);
  assert.equal(result.rakeMinor, 0n, 'the house is paid nothing for a result nobody can be paid on');
  assert.equal(result.payouts.get('a'), 5_000_000n);
  assert.equal(result.payouts.get('b'), 1_000_000n);
});

test('a match with no result refunds everybody whole', () => {
  const bets = [bet('a', 'EXTRACT', 4_000_000n), bet('b', 'WIPEOUT', 9_000_000n)];
  const result = settlePool(bets, null, 1000);

  assert.equal(result.voided, true);
  assert.equal(result.rakeMinor, 0n);
  assert.equal(result.payouts.get('a'), 4_000_000n);
  assert.equal(result.payouts.get('b'), 9_000_000n);
});

test('an empty market settles to nothing rather than dividing by zero', () => {
  const result = settlePool([], 'EXTRACT', 300);
  assert.equal(result.poolMinor, 0n);
  assert.equal(result.rakeMinor, 0n);
  assert.equal(result.payouts.size, 0);
});

test('nobody is ever paid more than the pool holds, across a spread of shapes', () => {
  /* The property that makes a parimutuel house unable to lose. Checked over awkward splits rather
   * than round ones, because the only way it can break is a rounding seam. */
  for (const [left, right] of [
    [1n, 999_999n],
    [7n, 13n],
    [123_456_789n, 987_654_321n],
    [10n ** 15n, 1n],
  ] as const) {
    for (const bps of [0, 37, 300, 1000]) {
      const bets = [bet('l', 'A', left), bet('r', 'B', right)];
      for (const winner of ['A', 'B'] as const) {
        const result = settlePool(bets, winner, bps);
        const distributed = [...result.payouts.values()].reduce((sum, value) => sum + value, 0n);
        assert.ok(
          distributed + result.rakeMinor <= result.poolMinor,
          `paid more than the pool at ${left}/${right} bps=${bps}`,
        );
      }
    }
  }
});

test('shareFor never divides by zero', () => {
  assert.equal(shareFor(5n, 0n, 100n), 0n);
});

/* ═════════════════════════ the displayed price ═════════════════════════ */

test('the multiplier is net of the cut, so the figure shown is the figure paid', () => {
  // $40M on this side of a $60M pool at 3%: payout is $58.2M, so this side pays 1.455x.
  assert.equal(impliedMultiplierBps(40_000_000n, 60_000_000n, 300), 14_550);
});

test('the multiplier shortens as a side is backed', () => {
  const thin = impliedMultiplierBps(1_000_000n, 60_000_000n, 300);
  const heavy = impliedMultiplierBps(40_000_000n, 60_000_000n, 300);
  assert.ok(thin > heavy, 'the crowded side pays less, which is the whole signal');
});

test('an unbacked side reports the pool rather than dividing by zero', () => {
  assert.equal(impliedMultiplierBps(0n, 10_000_000n, 300), 10_000);
  assert.equal(impliedMultiplierBps(0n, 0n, 300), 0);
});
