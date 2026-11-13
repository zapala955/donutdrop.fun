import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  effectiveLeverage,
  epochPath,
  epochPathAsync,
  liquidationLevels,
  openPosition,
  outcomeInTick,
  payoutAt,
  paceOf,
  STOCKS_MIN_LEVERAGE,
  STOCKS_PACE_BLOCK_TICKS,
  STOCKS_PACES,
  STOCKS_SPIKE_FACTOR,
  STOCKS_STEP_PPM,
  tickMoveCount,
  tickMoves,
  upThreshold,
  type Side,
} from '../src/lib/stocks.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

/*
 * Stocks (2026-11-13). The owner: "its basically like a chart that goes up and down yk like crypto
 * or stocks and ppl can long or short it with a leverage of up to 1000x", a 10% edge, the payout cap
 * of the other games, "way more volatile ... made to trade on 1s timeframes". Recorded and checked
 * end to end against a real database before shipping; these pin the maths and the structure.
 */

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFile(path.resolve(root, file), 'utf8');
const U = 1 + STOCKS_STEP_PPM / 1_000_000;
const SEED = 'ab'.repeat(32);

describe('the chart', () => {
  it('is a martingale: each move keeps the expected price where it is', () => {
    const q = upThreshold() / 2 ** 32;
    assert.ok(Math.abs(q * U + (1 - q) / U - 1) < 1e-9);
  });

  it('is fixed by its seed, and every tick replays move by move', () => {
    const a = epochPath(SEED, 'epoch-1', 0, 200);
    const b = epochPath(SEED, 'epoch-1', 0, 200);
    assert.deepEqual([...a.close], [...b.close]);
    assert.notDeepEqual([...epochPath(SEED, 'epoch-2', 0, 200).close], [...a.close]);
    for (const tick of [1, 7, 199]) {
      const moves = tickMoves(SEED, 'epoch-1', tick, a.close[tick - 1]!);
      assert.equal(moves.length, tickMoveCount(SEED, 'epoch-1', tick));
      assert.equal(moves[moves.length - 1], a.close[tick]);
      assert.equal(Math.min(...moves, a.close[tick - 1]!), Math.min(a.low[tick]!, a.close[tick - 1]!));
      assert.equal(Math.max(...moves), Math.max(...moves) <= a.high[tick]! ? Math.max(...moves) : NaN);
      let previous = a.close[tick - 1]!;
      for (const level of moves) {
        assert.equal(Math.abs(level - previous), 1, 'a move is always exactly one level');
        previous = level;
      }
    }
  });

  it('moves about 0.7% a second, in moods from calm to frenzy, with spikes: "volatile asf"', () => {
    const perSecond: number[] = [];
    const blocks: number[] = [];
    for (const epoch of ['vol-1', 'vol-2', 'vol-3']) {
      const path = epochPath(SEED, epoch, 0, 1200);
      for (let t = 10; t < 1200; t += 10) perSecond.push((path.close[t]! - path.close[t - 10]!) * (STOCKS_STEP_PPM / 1e6));
      for (let b = STOCKS_PACE_BLOCK_TICKS; b < 1200; b += STOCKS_PACE_BLOCK_TICKS) {
        let sum = 0;
        for (let t = b - STOCKS_PACE_BLOCK_TICKS + 1; t <= b; t += 1) sum += (path.close[t]! - path.close[t - 1]!) ** 2;
        blocks.push(sum);
      }
    }
    const sd = Math.sqrt(perSecond.reduce((s, x) => s + x * x, 0) / perSecond.length);
    assert.ok(sd > 0.0045 && sd < 0.011, `a second moves ${(sd * 100).toFixed(3)}%`);
    blocks.sort((a, b) => a - b);
    assert.ok(blocks.at(-1)! > 6 * blocks[0]!, 'the wildest 4 seconds are far wilder than the calmest');
    // Each mood turns up, in about its share, and spikes happen.
    const seen = new Map<number, number>();
    let spikes = 0;
    for (let tick = 1; tick < 1200 * 20; tick += 1) {
      const pace = paceOf(SEED, 'moods', tick);
      if (tick % STOCKS_PACE_BLOCK_TICKS === 0) seen.set(pace, (seen.get(pace) ?? 0) + 1);
      if (tickMoveCount(SEED, 'moods', tick) === pace * STOCKS_SPIKE_FACTOR) spikes += 1;
    }
    for (const [chance, moves] of STOCKS_PACES) {
      const share = (seen.get(moves) ?? 0) / (24_000 / STOCKS_PACE_BLOCK_TICKS);
      assert.ok(Math.abs(share - chance) < 0.06, `${moves} moves a tick: ${share}`);
    }
    assert.ok(spikes > 200 && spikes < 520, `${spikes} spikes in 24,000 ticks`);
  });

  it('builds the same path a few milliseconds at a time as all at once', async () => {
    const whole = epochPath(SEED, 'chunked', 7, 300);
    const chunked = await epochPathAsync(SEED, 'chunked', 7, 300);
    assert.deepEqual([...chunked.close], [...whole.close]);
    assert.deepEqual([...chunked.low], [...whole.low]);
    assert.deepEqual([...chunked.high], [...whole.high]);
  });
});

describe('a position', () => {
  it('pays back exactly 90% the moment it opens, at every leverage, long and short: a 10% fee', () => {
    for (const side of ['long', 'short'] as Side[]) {
      for (let leverage = 1; leverage <= 1000; leverage += 1) {
        const p = openPosition({ side, stakeMinor: 1_000_000_000n, leverage, openLevel: 0, maxPayoutMinor: 50_000_000_000n });
        assert.equal(p.feePpm, 100_000);
        const back = Number(payoutAt(p, 0));
        assert.ok(Math.abs(back - 900_000_000) <= 1, `${side} ${leverage}x opens at ${back}`);
        assert.ok(Math.abs(p.effectiveLeverage / leverage - 1) < 0.02, `${side} ${leverage}x runs at ${p.effectiveLeverage}`);
      }
    }
  });

  it('loses exactly the stake at its liquidation level, and not a level sooner', () => {
    for (const side of ['long', 'short'] as Side[]) {
      for (const leverage of [1, 2, 10, 100, 500, 1000]) {
        const p = openPosition({ side, stakeMinor: 1_000_000n, leverage, openLevel: 500, maxPayoutMinor: 50_000_000_000n });
        assert.equal(payoutAt(p, p.liquidationLevel), 0n);
        const before = side === 'long' ? p.liquidationLevel + 1 : p.liquidationLevel - 1;
        assert.ok(payoutAt(p, before) > 0n);
        assert.equal(liquidationLevels(side, leverage), Math.abs(p.liquidationLevel - 500));
      }
    }
  });

  /* Not a simulation: the exact expected payout over every path of the next 3,000 moves (three
   * ticks), liquidation absorbing. Optional stopping says it is 90% of the stake for any hold; this
   * checks the code does what the maths says, to nine decimal places. */
  it('is worth exactly 90% of its stake on average whenever it is closed, liquidations included', () => {
    const q = upThreshold() / 2 ** 32;
    for (const side of ['long', 'short'] as Side[]) {
      for (const leverage of [10, 100, 1000]) {
        const n = liquidationLevels(side, leverage)!;
        const L = effectiveLeverage(side, n);
        const R = 400;
        let p = new Float64Array(2 * R + 1);
        p[R] = 1;
        const dead = side === 'long' ? -n : n;
        for (let move = 0; move < 3000; move += 1) {
          const next = new Float64Array(2 * R + 1);
          for (let i = 0; i < p.length; i += 1) {
            const mass = p[i]!;
            if (!mass) continue;
            const offset = i - R;
            if (offset === dead) { next[i]! += mass; continue; } // liquidated: stays, pays 0
            if (i + 1 < p.length) next[i + 1]! += mass * q;
            if (i - 1 >= 0) next[i - 1]! += mass * (1 - q);
          }
          p = next;
        }
        let expected = 0;
        for (let i = 0; i < p.length; i += 1) {
          const d = i - R;
          if (d === dead) continue;
          const share = side === 'long' ? U ** d - U ** -n : U ** n - U ** d;
          expected += p[i]! * Math.max(0, L * share);
        }
        assert.ok(Math.abs(expected - 0.9) < 1e-6, `${side} ${leverage}x is worth ${expected}`);
      }
    }
  });

  it('closes at the cap, and a tick that touches both its cap and its liquidation goes to the first', () => {
    const p = openPosition({ side: 'long', stakeMinor: 49_000_000_000n, leverage: 1000, openLevel: 0, maxPayoutMinor: 50_000_000_000n });
    assert.ok(p.capLevel !== null && p.capLevel > 0);
    assert.equal(payoutAt(p, p.capLevel + 50), 50_000_000_000n, 'never more than the cap');
    const up = Int32Array.from([p.capLevel, p.liquidationLevel]);
    const down = Int32Array.from([p.liquidationLevel, p.capLevel]);
    assert.equal(outcomeInTick(p, p.liquidationLevel, p.capLevel, () => up), 'capped');
    assert.equal(outcomeInTick(p, p.liquidationLevel, p.capLevel, () => down), 'liquidated');
  });
});

describe('the game', () => {
  it('ships on, with the other games’ payout cap and 1000x, tunable live under its own heading', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      APP_ORIGIN: 'http://localhost:3000',
      COOKIE_SECRET: 'c'.repeat(32),
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      BOT_CREDENTIALS_JSON: JSON.stringify({ '00000000-0000-4000-8000-000000000001': { secret: Buffer.alloc(32, 2).toString('base64'), serverHost: 'donutsmp.net', username: 'DonutBot' } }),
      AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
      IP_HASH_KEY: 'i'.repeat(32),
    });
    assert.equal(config.stocksEnabled, true);
    assert.equal(config.stocksMaxLeverage, 1000);
    assert.equal(config.stocksMaxPayoutMinor, config.limboMaxPayoutMinor);
    for (const key of ['stocksEnabled', 'stocksMinStakeMinor', 'stocksMaxStakeMinor', 'stocksMaxPayoutMinor', 'stocksMaxLeverage'] as const) {
      assert.equal(runtimeSettingDefinitions[key].group, 'stocks', key);
    }
  });

  it('takes the price from the database clock inside the transaction, and ends a position once', async () => {
    const routes = await read('src/routes/stocks.ts');
    assert.match(routes, /const clock = await client\.query<\{ now: Date \}>\('SELECT clock_timestamp\(\) AS now'\);\s+const here = await locate\(client, clock\.rows\[0\]!\.now\);/);
    assert.match(routes, /WHERE id = \$1 AND status = 'open'\s+RETURNING \*/);
    assert.match(routes, /SELECT \* FROM stocks_positions WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
    // A close checks every tick the sweep has not, so a touched liquidation level is never escaped.
    assert.match(routes, /const from = swept && before\(opened, swept\) \? swept : opened;\s+const ended = before\(from, here\.ref\) \? await firstOutcome\(/);
    // Nothing under 10x ("not some 2x leverage shit").
    assert.equal(STOCKS_MIN_LEVERAGE, 10);
    assert.ok(routes.includes('leverage: z.number().int().min(STOCKS_MIN_LEVERAGE)'));
    // A player's own changes go to that player alone; settled trades go to everyone as data.
    assert.ok(!routes.includes("liveEvents.publish('stocks')"), 'a position change is sent to its owner only');
    assert.ok(routes.includes("liveEvents.publishData('stocks_feed', { rows: await feedRows(endedIds) });"));
    // One open at a time per player, queued outside the database.
    assert.match(routes, /oneAtATime\(`open:\$\{userId\}`, 1,/);
    assert.match(routes, /'stocks',\s+id,\s+\['wagered_minor'\],\s+\(stake \* BigInt\(STOCKS_EDGE_BPS\)\) \/ 10_000n,/);
    // Closing never depends on the game being switched on.
    const close = routes.slice(routes.indexOf("'/v1/stocks/close'"));
    assert.doesNotMatch(close.slice(0, close.indexOf('readCommitted')), /stocksEnabled/);
  });

  it('only ever publishes ticks the clock has reached', async () => {
    const routes = await read('src/routes/stocks.ts');
    // The offset is measured against the database every sweep, low by construction...
    assert.match(routes, /clockOffset = clock\.rows\[0\]!\.now\.getTime\(\) - Date\.now\(\);/);
    // ...and the broadcast runs 15ms behind that estimate, tick by tick.
    const broadcast = routes.slice(routes.indexOf('const broadcast = async'));
    assert.match(broadcast, /const here = await locate\(db, new Date\(Date\.now\(\) \+ clockOffset - 15\)\);/);
    assert.match(broadcast, /liveEvents\.publishData\('stocks_tick', \{ seq: here\.ref\.seq, tick: here\.ref\.tick,/);
    assert.match(routes, /const ticker = setInterval\(\(\) => void broadcast\(\), 50\);/);
  });

  it('adds its tables and its name to the four lists, and nothing else', async () => {
    const sql = await read('../../packages/db/migrations/093_stocks.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|^\s*UPDATE /im);
    for (const list of ['wallet_transactions_kind_check', 'wager_events_source_check', 'faction_contributions_source_check', 'referral_earnings_source_check']) {
      assert.match(sql, new RegExp(`ADD CONSTRAINT ${list}`));
    }
    assert.match(sql, /'stocks_stake', 'stocks_payout'/);
    assert.match(sql, /CHECK \(status <> 'liquidated' OR payout_minor = 0\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v93\(\) RETURNS boolean/);
  });
});
