import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CRASH_HOUSE_EDGE_BPS,
  CRASH_MAX_MULTIPLIER_X100,
  CRASH_MIN_TARGET_X100,
  crashPoint,
  crashPointFromSample,
  effectiveTarget,
  limitFor,
  multiplierAt,
  payoutAt,
  secondsToReach,
} from '../src/lib/crash.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const route = () => read('services/api-gateway/src/routes/crash.ts');

const SPACE = 2n ** 52n;
/** Exactly how many of the 2^52 equally likely samples bust at or above `k` hundredths. */
const survivors = (k: number) => (BigInt(10_000 - CRASH_HOUSE_EDGE_BPS) * SPACE) / (100n * BigInt(k));
/** The first sample that reaches `k`: every sample from here up survives to k, none below does. */
const threshold = (k: number) => SPACE - survivors(k);

describe('crash engine', () => {
  it('draws exactly the distribution the edge is built on', () => {
    for (const k of [101, 102, 110, 125, 150, 199, 200, 247, 333, 500, 1000, 5000, 10_000, 50_000, 100_000]) {
      const h = threshold(k);
      assert.ok(crashPointFromSample(h) >= k, `the first surviving sample for ${k} busts below it`);
      assert.ok(crashPointFromSample(h - 1n) < k, `the sample before the threshold for ${k} survives`);
    }
    assert.equal(crashPointFromSample(0n), 100);
    assert.equal(crashPointFromSample(SPACE - 1n), CRASH_MAX_MULTIPLIER_X100);
  });

  it('returns at most 90% for every target, and never less than a hair under it', () => {
    // P(C ≥ k) is survivors(k) / 2^52 exactly (proved against the implementation above), so the
    // expected return of cashing out at k is k/100 · survivors(k) / 2^52. Checked in exact integers.
    for (let k = CRASH_MIN_TARGET_X100; k <= CRASH_MAX_MULTIPLIER_X100; k += k < 1000 ? 1 : 997) {
      const returned = BigInt(k) * survivors(k); // scaled by 100 · 2^52
      const ninety = 90n * SPACE; // 0.9 on the same scale
      assert.ok(returned <= ninety, `cashing out at ${k / 100}x returns more than 90%`);
      assert.ok(ninety - returned < BigInt(k), `cashing out at ${k / 100}x returns well under 90%`);
    }
  });

  it('busts instantly in about one round in nine, which is where the edge lives', () => {
    const instant = Number(threshold(CRASH_MIN_TARGET_X100)) / Number(SPACE);
    assert.ok(Math.abs(instant - (1 - 0.9 / 1.01)) < 1e-12);
  });

  it('pays a manual cash-out strictly less than 90%, because it must beat the bust', () => {
    // Clicking at y wins only when the round goes on past y, i.e. C ≥ y + 0.01.
    for (const y of [100, 101, 150, 200, 1000, 99_999]) {
      const returned = Number(BigInt(y) * survivors(y + 1)) / (100 * Number(SPACE));
      assert.ok(returned < 0.9, `a manual cash-out at ${y / 100}x returns ${returned}`);
    }
  });

  it('agrees with a blind simulation', () => {
    let staked = 0;
    let returned = 0;
    for (let round = 0; round < 200_000; round += 1) {
      const h = BigInt(`0x${randomBytes(7).toString('hex')}`) >> 4n; // 52 random bits
      const point = crashPointFromSample(h);
      staked += 1;
      if (point >= 200) returned += 2;
    }
    const rtp = returned / staked;
    assert.ok(rtp > 0.88 && rtp < 0.92, `simulated return at 2x was ${rtp}`);
  });

  it('derives the point from the published seed, exactly as a player can check it', () => {
    const seed = 'ab'.repeat(32);
    const roundId = '11111111-1111-4111-8111-111111111111';
    const digest = createHmac('sha256', seed).update(`${roundId}:0`).digest('hex');
    const expected = crashPointFromSample(BigInt(`0x${digest.slice(0, 13)}`));
    assert.deepEqual(crashPoint(seed, roundId), { crashPointX100: expected, digest });
  });

  it('draws the same curve the browser draws, and reaches each point when it says it will', () => {
    assert.equal(multiplierAt(0), 100);
    assert.equal(multiplierAt(-3), 100);
    for (const k of [101, 150, 200, 1000, 12_345, 100_000]) {
      assert.equal(multiplierAt(secondsToReach(k)), k);
      assert.ok(multiplierAt(secondsToReach(k) - 0.01) < k);
    }
    assert.ok(Math.abs(secondsToReach(200) - Math.log(2) / 0.07) < 1e-9);
  });

  it('caps each bet where its payout would pass the maximum', () => {
    assert.equal(limitFor(1_000_000_000n, 50_000_000_000n), 5000); // $1B may ride to 50x
    assert.equal(limitFor(10_000_000n, 50_000_000_000n), CRASH_MAX_MULTIPLIER_X100);
    assert.equal(limitFor(50_000_000_000n, 50_000_000_000n), null); // cannot even win 1.01x
    assert.equal(effectiveTarget(null, 5000), 5000);
    assert.equal(effectiveTarget(250, 5000), 250);
    assert.equal(effectiveTarget(9000, 5000), 5000);
    assert.equal(payoutAt(1_000_000n, 247), 2_470_000n);
    assert.equal(payoutAt(333n, 150), 499n); // rounds down, never up
  });
});

describe('crash routes', () => {
  it('never tells a browser the crash point before the curve has passed it', async () => {
    const source = await route();
    const view = source.slice(source.indexOf('function roundView('), source.indexOf('function historyView('));
    assert.match(view, /crashPointX100: busted \? round\.crash_point_x100 : null/);
    assert.match(view, /crashedAt: busted \? round\.crashes_at\.toISOString\(\) : null/);
    assert.doesNotMatch(view, /crashesAt/);
  });

  it('judges a cash-out on the database clock, after its bet is locked', async () => {
    const source = await route();
    const cashout = source.slice(source.indexOf("'/v1/crash/cashout'"), source.indexOf('── the scheduler ──'));
    const lock = cashout.indexOf('FOR UPDATE');
    const clock = cashout.indexOf('clock_timestamp() < crashes_at AS alive');
    assert.ok(lock > 0 && clock > lock, 'the clock must be read after the bet row is locked');
    assert.match(cashout, /if \(!round\.alive\) conflict\('ROUND_CRASHED'/);
    // Paid below the crash point, and never below the stake.
    assert.match(cashout, /Math\.max\(100, Math\.min\(reached, round\.crash_point_x100 - 1\)\)/);
    // A second click returns the first result instead of paying twice.
    assert.match(cashout, /if \(bet\.status === 'cashed_out'\) return \{ bet, paid: null \};/);
  });

  it('pays a bet at most once, whichever path reaches it first', async () => {
    const source = await route();
    const cashOut = source.slice(source.indexOf('async function cashOut('), source.indexOf('async function usernames('));
    assert.match(cashOut, /WHERE id = \$1 AND status = 'active'/);
    assert.match(cashOut, /if \(!row\) return null;/);
    assert.match(cashOut, /creditWallet\(client, bet\.user_id, payout, 'crash_payout', bet\.id\)/);
  });

  it('closes betting on the database clock and lets the bust wait for every accepted bet', async () => {
    const source = await route();
    const bets = source.slice(source.indexOf("'/v1/crash/bets'"), source.indexOf("'/v1/crash/cashout'"));
    assert.match(bets, /WHERE id = \$1 AND status = 'open' FOR SHARE/);
    assert.match(bets, /clock_timestamp\(\) < \$1::timestamptz AS open/);
    assert.match(bets, /recordWager\(client, config, userId, stake, 'crash', id/);
    // No write to the round row while bets hold share locks on it: two such bets would deadlock.
    assert.doesNotMatch(bets, /UPDATE crash_rounds/);
  });

  it('busts, auto-pays and cashes out at READ COMMITTED, so a bust sees every bet that got in', async () => {
    const source = await route();
    const advance = source.slice(source.indexOf('async function advance('), source.indexOf('/** Pays every auto cash-out'));
    assert.match(advance, /return readCommitted\(db, async \(client\) =>/);
    // The round is locked before the bets are read, and the lock waits for every bet in flight.
    assert.ok(advance.indexOf('FOR UPDATE') < advance.indexOf('settleRound('));
    assert.match(source, /BEGIN ISOLATION LEVEL READ COMMITTED/);
    const cashout = source.slice(source.indexOf("'/v1/crash/cashout'"), source.indexOf('── the scheduler ──'));
    assert.match(cashout, /await readCommitted\(db, async \(client\) =>/);
    // Placing a bet stays SERIALIZABLE (the wager hooks), with room to retry a crowded close.
    const bets = source.slice(source.indexOf("'/v1/crash/bets'"), source.indexOf("'/v1/crash/cashout'"));
    assert.match(bets, /\}, 8\);/);
  });

  it('settles a round against the seed it committed to', async () => {
    const source = await route();
    const settle = source.slice(source.indexOf('async function settleRound('), source.indexOf('async function currentRound('));
    assert.match(settle, /hashServerSeed\(seed\) !== round\.server_seed_hash/);
    assert.match(settle, /crashPoint\(seed, round\.id, round\.house_edge_bps\)\.crashPointX100 !== round\.crash_point_x100/);
    assert.match(settle, /if \(target <= round\.crash_point_x100\)/);
  });

  it('only widens the constraints it touches', async () => {
    const kinds = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/050_crash.sql');
    const previous = await read('packages/db/migrations/049_blackjack.sql');
    for (const constraint of [
      'wallet_transactions_kind_check',
      'wager_events_source_check',
      'faction_contributions_source_check',
      'referral_earnings_source_check',
    ]) {
      const before = kinds(previous, constraint);
      const after = kinds(migration, constraint);
      for (const value of before) assert.ok(after.has(value), `050 drops ${value} from ${constraint}`);
    }
    assert.ok(kinds(migration, 'wallet_transactions_kind_check').has('crash_payout'));
    assert.ok(kinds(migration, 'wager_events_source_check').has('crash'));
    assert.match(migration, /CREATE UNIQUE INDEX crash_one_open_round_idx ON crash_rounds \(status\) WHERE status = 'open'/);
    assert.match(migration, /UNIQUE \(round_id, user_id\)/);
  });

  it('puts blackjack hands and crash bets in the live feed', async () => {
    const activity = await read('services/api-gateway/src/routes/activity.ts');
    assert.match(activity, /FROM blackjack_hands h[\s\S]*?WHERE h\.status = 'settled'/);
    assert.match(activity, /FROM crash_bets b[\s\S]*?WHERE b\.status <> 'active'/);
    const blackjack = await read('services/api-gateway/src/routes/blackjack.ts');
    assert.match(blackjack, /publishLiveSoon\('activity'\)/);
  });
});
