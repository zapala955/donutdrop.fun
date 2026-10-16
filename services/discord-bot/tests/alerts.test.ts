import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MoneyAlertMemory,
  money,
  moneyEmbeds,
  parseMoneyAlerts,
  type MoneyAlerts,
} from '../src/alerts.js';

const poll = (over: Partial<MoneyAlerts> = {}): MoneyAlerts => ({
  channelId: null,
  roleId: null,
  dailyProfitMinor: 100_000_000n,
  wins: [],
  profits: [],
  holds: [],
  ...over,
});

const win = (id: string, payout = 90_000_000n) => ({
  id,
  game: 'Mines',
  username: 'Steve',
  wagerMinor: 1_000_000n,
  payoutMinor: payout,
});

describe('money alert memory', () => {
  it('learns what is already there on the first poll and posts none of it', () => {
    const memory = new MoneyAlertMemory();
    const first = memory.take(poll({ wins: [win('a')], profits: [{ userId: 'u', username: 'Steve', netMinor: 150_000_000n }] }));
    assert.deepEqual(first, { wins: [], profits: [], holds: [] });
    const second = memory.take(poll({ wins: [win('a')], profits: [{ userId: 'u', username: 'Steve', netMinor: 150_000_000n }] }));
    assert.deepEqual(second, { wins: [], profits: [], holds: [] });
  });

  it('posts each win and each hold once', () => {
    const memory = new MoneyAlertMemory();
    memory.take(poll());
    const hold = { userId: 'u', username: 'Steve', reason: 'Auto: net winnings', at: '2026-10-16T10:00:00.000Z' };
    const fresh = memory.take(poll({ wins: [win('a'), win('b')], holds: [hold] }));
    assert.deepEqual(fresh.wins.map((w) => w.id), ['a', 'b']);
    assert.equal(fresh.holds.length, 1);
    const again = memory.take(poll({ wins: [win('a'), win('b'), win('c')], holds: [hold] }));
    assert.deepEqual(again.wins.map((w) => w.id), ['c']);
    assert.equal(again.holds.length, 0);
    // The same player held again later is a new hold.
    const later = memory.take(poll({ holds: [{ ...hold, at: '2026-10-16T12:00:00.000Z' }] }));
    assert.equal(later.holds.length, 1);
  });

  it('posts a player up on the day again only at the next multiple of the bar', () => {
    const memory = new MoneyAlertMemory();
    memory.take(poll());
    const up = (net: bigint) => memory.take(poll({ profits: [{ userId: 'u', username: 'Steve', netMinor: net }] })).profits.length;
    assert.equal(up(120_000_000n), 1, '1x the bar');
    assert.equal(up(180_000_000n), 0, 'still under 2x');
    assert.equal(up(210_000_000n), 1, 'past 2x');
    assert.equal(up(150_000_000n), 0, 'falling back says nothing');
    assert.equal(up(299_000_000n), 0, 'back under the 3x it has not reached');
    assert.equal(up(300_000_000n), 1, '3x');
  });

  it('forgets after its window, so memory does not grow forever', () => {
    const memory = new MoneyAlertMemory();
    const t0 = Date.parse('2026-10-16T00:00:00Z');
    memory.take(poll(), t0);
    assert.equal(memory.take(poll({ wins: [win('a')] }), t0 + 1000).wins.length, 1);
    assert.equal(memory.take(poll({ wins: [win('a')] }), t0 + 60 * 60 * 1000).wins.length, 0);
    // Past two hours the id is forgotten; the gateway's ten-minute window will long since have dropped it.
    assert.equal(memory.take(poll({ wins: [win('a')] }), t0 + 3 * 60 * 60 * 1000).wins.length, 1);
  });
});

describe('money alert payload', () => {
  it('drops malformed rows and ids rather than posting them half-filled', () => {
    const parsed = parseMoneyAlerts({
      channelId: '123456789012345678',
      roleId: '<@everyone>',
      dailyProfitMinor: '100000000',
      wins: [
        { id: 'a', game: 'Crash', username: 'Steve', wagerMinor: '500000', payoutMinor: '26490000', at: 'x' },
        { id: 'b', game: 'Crash', username: 'Steve', wagerMinor: 'lots', payoutMinor: '1' },
        null,
      ],
      profits: [{ userId: 'u', username: 'Alex', netMinor: '150000000' }, { userId: 'v' }],
      holds: [{ userId: 'u', username: 'Alex', reason: 'Auto', at: '2026-10-16T10:00:00.000Z' }],
    });
    assert.equal(parsed.channelId, '123456789012345678');
    assert.equal(parsed.roleId, null, 'a role id that is not a snowflake is never mentioned');
    assert.deepEqual(parsed.wins.map((w) => w.id), ['a']);
    assert.equal(parsed.wins[0]?.payoutMinor, 26_490_000n);
    assert.deepEqual(parsed.profits.map((p) => p.username), ['Alex']);
    assert.equal(parsed.holds.length, 1);
    assert.deepEqual(parseMoneyAlerts(null).wins, []);
  });

  it('reads the way the site does, and escapes names Discord would format', () => {
    assert.equal(money(26_490_000n), '$26.5M');
    assert.equal(money(1_500_000_000n), '$1.5B');
    assert.equal(money(-2_000_000n), '-$2M');
    const embeds = moneyEmbeds({
      wins: [{ id: 'a', game: 'Crash', username: 'Big_Win_Guy', wagerMinor: 500_000n, payoutMinor: 26_490_000n }],
      profits: [{ userId: 'u', username: 'Alex', netMinor: 150_000_000n }],
      holds: [],
    }).map((embed) => embed.toJSON());
    assert.equal(embeds.length, 2);
    assert.equal(embeds[0]?.title, 'Big win');
    assert.match(embeds[0]?.description ?? '', /\*\*Big\\_Win\\_Guy\*\* won \*\*\$26M\*\* on Crash — staked \$500K, paid \$26\.5M \(52\.98×\)/);
    assert.equal(embeds[1]?.title, 'Up big over 24 hours');
    assert.match(embeds[1]?.description ?? '', /\*\*Alex\*\* is up \*\*\$150M\*\*/);
    assert.deepEqual(moneyEmbeds({ wins: [], profits: [], holds: [] }), []);
  });

  it('caps a long list', () => {
    const wins = Array.from({ length: 14 }, (_, i) => win(String(i), BigInt(10_000_000 + i)));
    const [embed] = moneyEmbeds({ wins, profits: [], holds: [] }).map((e) => e.toJSON());
    const lines = (embed?.description ?? '').split('\n');
    assert.equal(lines.length, 11);
    assert.equal(lines.at(-1), '…and 4 more');
  });
});
