import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HUMAN_FLOOR_MS,
  TRANSPORT_SLACK_MS,
  VARIANT_RULES,
  consistencySuspicion,
  duelMarginPerPlayer,
  judge,
  resolveDuel,
  scheduleFor,
  splitPot,
} from '../src/lib/duel-engine.js';

/* ═════════════════════════ the fee ═════════════════════════ */

test('splitPot charges the rake on the pot and pays the winner the rest', () => {
  // The worked example from the brief: two $50M stakes, 3% rake, winner takes $97M.
  const money = splitPot(50_000_000n, 300);
  assert.equal(money.potMinor, 100_000_000n);
  assert.equal(money.rakeMinor, 3_000_000n);
  assert.equal(money.payoutMinor, 97_000_000n);
});

test('pot always equals payout plus rake, at every stake and every legal rake', () => {
  /* The identity the database also enforces in `duel_rake_adds_up`. Checked across awkward stakes
   * and rates rather than round ones, because the only way it can break is a rounding seam. */
  for (const stake of [1n, 3n, 7n, 999n, 1_000_001n, 123_456_789n, 10n ** 18n]) {
    for (const bps of [0, 1, 37, 300, 999, 1000]) {
      const money = splitPot(stake, bps);
      assert.equal(money.payoutMinor + money.rakeMinor, money.potMinor,
        `stake=${stake} bps=${bps}`);
      assert.ok(money.rakeMinor >= 0n);
      assert.ok(money.payoutMinor >= 0n);
    }
  }
});

test('the rake truncates toward the player, never toward the house', () => {
  /* pot = 2, 300bps of 2 is 0.06, which must floor to 0 rather than round to 1. A house that
   * rounds its own fee up collects money it did not earn a few million times a day. */
  const money = splitPot(1n, 300);
  assert.equal(money.potMinor, 2n);
  assert.equal(money.rakeMinor, 0n);
  assert.equal(money.payoutMinor, 2n);
});

test('a zero rake is a legal configuration and takes nothing', () => {
  const money = splitPot(1_000_000n, 0);
  assert.equal(money.rakeMinor, 0n);
  assert.equal(money.payoutMinor, money.potMinor);
});

test('splitPot refuses a stake or a rake it cannot honour', () => {
  assert.throws(() => splitPot(0n, 300), /positive/);
  assert.throws(() => splitPot(-5n, 300), /positive/);
  assert.throws(() => splitPot(100n, 1001), /between 0 and 1000/);
  assert.throws(() => splitPot(100n, -1), /between 0 and 1000/);
  assert.throws(() => splitPot(100n, 12.5), /between 0 and 1000/);
});

test('each player generates half the rake as margin', () => {
  // Both sides contributed the pot equally, so neither may be credited for all of it.
  const money = splitPot(50_000_000n, 300);
  assert.equal(duelMarginPerPlayer(money), 1_500_000n);
});

/* ═════════════════════════ the schedule ═════════════════════════ */

test('the cue schedule is reproducible from the revealed seed', () => {
  // This is the whole provably-fair claim: same seed, same cue, every time.
  const first = scheduleFor('a'.repeat(64), 'reflex', 2);
  const second = scheduleFor('a'.repeat(64), 'reflex', 2);
  assert.deepEqual(first, second);
});

test('a different seed or round moves the cue', () => {
  const base = scheduleFor('a'.repeat(64), 'reflex', 0);
  const otherSeed = scheduleFor('b'.repeat(64), 'reflex', 0);
  const otherRound = scheduleFor('a'.repeat(64), 'reflex', 1);
  assert.notDeepEqual(base, otherSeed);
  assert.notDeepEqual(base, otherRound);
});

test('the cue always lands inside its variant window', () => {
  for (const variant of ['reflex', 'precision', 'sequence'] as const) {
    const rules = VARIANT_RULES[variant];
    for (let round = 0; round < 64; round += 1) {
      const schedule = scheduleFor(`seed-${round}`, variant, round % 9);
      assert.ok(schedule.cueOffsetMs >= rules.cueMinMs, `${variant} cue under floor`);
      assert.ok(schedule.cueOffsetMs <= rules.cueMaxMs, `${variant} cue over ceiling`);
    }
  }
});

test('the precision target avoids both edges of the sweep', () => {
  /* A target that can sit at 0 or at the very end makes "press instantly" and "never press" into
   * winning strategies on some rounds. */
  const rules = VARIANT_RULES.precision;
  for (let round = 0; round < 64; round += 1) {
    const schedule = scheduleFor(`seed-${round}`, 'precision', round % 9);
    assert.ok(schedule.targetOffsetMs !== null);
    assert.ok(schedule.targetOffsetMs! >= rules.roundMs * 0.15);
    assert.ok(schedule.targetOffsetMs! <= rules.roundMs * 0.85);
  }
});

test('only the sequence variant carries symbols, and only precision carries a target', () => {
  assert.equal(scheduleFor('s', 'reflex', 0).symbols.length, 0);
  assert.equal(scheduleFor('s', 'reflex', 0).targetOffsetMs, null);
  assert.equal(scheduleFor('s', 'precision', 0).symbols.length, 0);
  assert.equal(scheduleFor('s', 'sequence', 0).symbols.length, 4);
  assert.equal(scheduleFor('s', 'sequence', 0).targetOffsetMs, null);
  for (const symbol of scheduleFor('s', 'sequence', 0).symbols) {
    assert.ok(symbol >= 0 && symbol < 6);
  }
});

/* ═════════════════════════ the verdict ═════════════════════════ */

const reflexSchedule = { roundIndex: 0, cueOffsetMs: 1_000, targetOffsetMs: null, symbols: [] };

test('a normal human reaction counts and scores the reaction, not the raw timestamp', () => {
  const result = judge('reflex', reflexSchedule, { reportedMs: 1_240, arrivedMs: 1_300 });
  assert.equal(result.verdict, 'valid');
  assert.equal(result.score, 240);
});

test('an input before the cue is too_early, not a fast reaction', () => {
  const result = judge('reflex', reflexSchedule, { reportedMs: 900, arrivedMs: 950 });
  assert.equal(result.verdict, 'too_early');
  assert.equal(result.score, null);
});

test('a superhuman reaction is refused', () => {
  const result = judge('reflex', reflexSchedule, {
    reportedMs: 1_000 + HUMAN_FLOOR_MS - 1,
    arrivedMs: 1_200,
  });
  assert.equal(result.verdict, 'implausible');
  assert.equal(result.score, null);
});

test('a reaction exactly at the human floor is allowed', () => {
  // The floor is a refusal threshold, not a target to beat; the boundary itself must not be lost.
  const result = judge('reflex', reflexSchedule, {
    reportedMs: 1_000 + HUMAN_FLOOR_MS,
    arrivedMs: 1_400,
  });
  assert.equal(result.verdict, 'valid');
  assert.equal(result.score, HUMAN_FLOOR_MS);
});

test('a report its own arrival cannot account for is refused', () => {
  /* Claiming a 1.2s reaction on a packet that arrived at 100ms is physically impossible: the
   * report cannot precede the transport that carried it. */
  const result = judge('reflex', reflexSchedule, { reportedMs: 5_000, arrivedMs: 100 });
  assert.equal(result.verdict, 'implausible');
});

test('a slow connection is not punished for being slow', () => {
  /* The same honest 240ms reaction, arriving 2s late. It must score identically to the fast
   * connection above — this is the entire reason the measurement is client-side. */
  const result = judge('reflex', reflexSchedule, {
    reportedMs: 1_240,
    arrivedMs: 1_240 + TRANSPORT_SLACK_MS - 1,
  });
  assert.equal(result.verdict, 'valid');
  assert.equal(result.score, 240);
});

test('nothing inside the window is too_late', () => {
  const late = judge('reflex', reflexSchedule, { reportedMs: 20_000, arrivedMs: 20_100 });
  assert.equal(late.verdict, 'too_late');
});

test('precision scores absolute distance, so early and late miss equally', () => {
  const schedule = { roundIndex: 0, cueOffsetMs: 1_500, targetOffsetMs: 5_000, symbols: [] };
  const early = judge('precision', schedule, { reportedMs: 4_880, arrivedMs: 5_000 });
  const late = judge('precision', schedule, { reportedMs: 5_120, arrivedMs: 5_200 });
  assert.equal(early.score, 120);
  assert.equal(late.score, 120);
});

test('sequence scores wrong symbols, so lower stays better across every variant', () => {
  const schedule = { roundIndex: 0, cueOffsetMs: 1_200, targetOffsetMs: null, symbols: [1, 2, 3, 4] };
  const perfect = judge('sequence', schedule, { reportedMs: 4_000, arrivedMs: 4_100, symbols: [1, 2, 3, 4] });
  const twoWrong = judge('sequence', schedule, { reportedMs: 4_000, arrivedMs: 4_100, symbols: [1, 2, 9, 9] });
  assert.equal(perfect.score, 0);
  assert.equal(twoWrong.score, 2);
});

/* ═════════════════════════ the result ═════════════════════════ */

test('lower score takes the round', () => {
  const result = resolveDuel([
    { roundIndex: 0, hostScore: 210, opponentScore: 260 },
    { roundIndex: 1, hostScore: 300, opponentScore: 240 },
    { roundIndex: 2, hostScore: 190, opponentScore: 220 },
  ]);
  assert.equal(result.outcome, 'decided');
  assert.equal(result.winner, 'host');
  assert.equal(result.hostRounds, 2);
  assert.equal(result.opponentRounds, 1);
});

test('a refused input loses the round to the player who produced a valid one', () => {
  const result = resolveDuel([{ roundIndex: 0, hostScore: null, opponentScore: 900 }]);
  assert.equal(result.winner, 'opponent');
});

test('a round both players lost is awarded to neither', () => {
  const result = resolveDuel([
    { roundIndex: 0, hostScore: null, opponentScore: null },
    { roundIndex: 1, hostScore: 200, opponentScore: 300 },
  ]);
  assert.equal(result.hostRounds, 1);
  assert.equal(result.opponentRounds, 0);
});

test('equal rounds is a draw, and a draw names no winner', () => {
  const result = resolveDuel([
    { roundIndex: 0, hostScore: 200, opponentScore: 300 },
    { roundIndex: 1, hostScore: 300, opponentScore: 200 },
  ]);
  assert.equal(result.outcome, 'draw');
  assert.equal(result.winner, null);
});

test('an exact tie on the millisecond goes to neither player', () => {
  const result = resolveDuel([{ roundIndex: 0, hostScore: 250, opponentScore: 250 }]);
  assert.equal(result.outcome, 'draw');
  assert.equal(result.hostRounds, 0);
  assert.equal(result.opponentRounds, 0);
});

test('a duel with no rounds at all is a draw rather than a crash', () => {
  const result = resolveDuel([]);
  assert.equal(result.outcome, 'draw');
  assert.equal(result.winner, null);
});

/* ═════════════════════════ the fraud signal ═════════════════════════ */

test('consistency needs enough rounds to mean anything', () => {
  assert.equal(consistencySuspicion([200, 210]), null);
});

test('a machine scatters less than a hand', () => {
  const machine = consistencySuspicion([200, 200, 201, 200, 200]);
  const human = consistencySuspicion([198, 265, 231, 302, 214]);
  assert.ok(machine !== null && human !== null);
  assert.ok(machine! < human!, 'a constant-offset script must look tighter than a person');
});
