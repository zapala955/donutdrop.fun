import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  LOBBY_SOCKET_BUDGET,
  createSocketBudget,
} from '../src/lib/socket-limit.js';

/**
 * The property under test is the one an attacker cares about: over any sustained period, a socket
 * cannot make the server parse more frames than the configured rate — no matter how the frames are
 * spaced, and no matter what the clock does.
 */
describe('socket frame budget', () => {
  it('absorbs a burst up to capacity and then refuses', () => {
    const budget = createSocketBudget({ ratePerSecond: 10, burst: 20 });
    for (let index = 0; index < 20; index += 1) {
      assert.equal(budget.take(), true, `frame ${index} inside the burst should pass`);
    }
    assert.equal(budget.take(), false, 'the frame past capacity is refused');
    assert.equal(budget.refused, 1);
  });

  it('refills at the configured rate and no faster', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 });
    try {
      const budget = createSocketBudget({ ratePerSecond: 10, burst: 10 });
      for (let index = 0; index < 10; index += 1) assert.equal(budget.take(), true);
      assert.equal(budget.take(), false, 'bucket is empty');

      // Half a second at ten per second is five tokens, not six.
      mock.timers.tick(500);
      for (let index = 0; index < 5; index += 1) {
        assert.equal(budget.take(), true, `refilled frame ${index} should pass`);
      }
      assert.equal(budget.take(), false, 'the sixth refilled frame is refused');
    } finally {
      mock.timers.reset();
    }
  });

  it('never accumulates beyond capacity while idle', () => {
    mock.timers.enable({ apis: ['Date'], now: 0 });
    try {
      const budget = createSocketBudget({ ratePerSecond: 10, burst: 20 });
      /* An hour of silence must not buy an hour's worth of frames. Without the cap, a connection
       * that idles and then floods is the whole limiter defeated by waiting. */
      mock.timers.tick(3_600_000);
      for (let index = 0; index < 20; index += 1) assert.equal(budget.take(), true);
      assert.equal(budget.take(), false, 'idling does not raise the ceiling above capacity');
    } finally {
      mock.timers.reset();
    }
  });

  it('does not mint tokens when the clock jumps backwards', () => {
    /* Date.now is stubbed by hand rather than with mock.timers, which refuses to tick backwards —
     * and moving backwards is the entire point of this case. An NTP correction or a resumed
     * container can do it, and it must neither refill the bucket nor wedge it. */
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      const budget = createSocketBudget({ ratePerSecond: 10, burst: 10 });
      for (let index = 0; index < 10; index += 1) assert.equal(budget.take(), true);

      clock -= 500_000;
      assert.equal(budget.take(), false, 'a backwards jump grants nothing');

      clock += 1_000;
      assert.equal(budget.take(), true, 'the bucket recovers on the next real second');
    } finally {
      Date.now = realNow;
    }
  });

  it('clamps a burst that is smaller than one second of traffic', () => {
    /* A bucket too small to hold one second of the sustained rate would refuse correct clients. */
    const budget = createSocketBudget({ ratePerSecond: 25, burst: 5 });
    for (let index = 0; index < 25; index += 1) {
      assert.equal(budget.take(), true, `frame ${index} at the sustained rate should pass`);
    }
  });

  it('ships a budget that leaves real clients headroom', () => {
    /* Only the lobby budget is left. The arena budget went with the arena — it existed because a
     * 20Hz input stream needed room above it, and nothing on the platform sends at that rate any
     * more. Lobby sockets carry watch/unwatch and a ping, so the bar is that a burst of those
     * cannot trip a limit that is supposed to catch abuse. */
    assert.ok(LOBBY_SOCKET_BUDGET.ratePerSecond >= 5);
    assert.ok(LOBBY_SOCKET_BUDGET.burst >= LOBBY_SOCKET_BUDGET.ratePerSecond);
  });

  it('counts every refusal for the close-time log line', () => {
    const budget = createSocketBudget({ ratePerSecond: 1, burst: 1 });
    assert.equal(budget.take(), true);
    for (let index = 0; index < 50; index += 1) budget.take();
    assert.equal(budget.refused, 50);
  });
});
