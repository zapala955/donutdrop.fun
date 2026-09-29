import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  PLINKO_HOUSE_EDGE_BPS,
  PLINKO_MAX_ROWS,
  PLINKO_MIN_ROWS,
  PLINKO_RISKS,
  maxMultiplierBps,
  maxStakeFor,
  multipliersFor,
  payoutFor,
  plinkoPath,
  slotOf,
} from '../src/lib/plinko.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const route = () => read('services/api-gateway/src/routes/plinko.ts');

function binomial(n: number, k: number): bigint {
  let result = 1n;
  for (let i = 0; i < k; i += 1) result = (result * BigInt(n - i)) / BigInt(i + 1);
  return result;
}

const boards = PLINKO_RISKS.flatMap((risk) =>
  Array.from({ length: PLINKO_MAX_ROWS - PLINKO_MIN_ROWS + 1 }, (_, i) => ({ rows: PLINKO_MIN_ROWS + i, risk })),
);

describe('plinko engine', () => {
  it('returns between 89.7% and 90% on every board, in exact integers', () => {
    const ninety = BigInt(10_000 - PLINKO_HOUSE_EDGE_BPS);
    for (const { rows, risk } of boards) {
      const table = multipliersFor(rows, risk);
      assert.equal(table.length, rows + 1, `${rows} ${risk} has the wrong number of slots`);
      // Σ C(n, k) · m_k over 2^n, compared in basis points without dividing.
      const weighted = table.reduce((sum, bps, k) => sum + binomial(rows, k) * BigInt(bps), 0n);
      const whole = 1n << BigInt(rows);
      assert.ok(weighted <= ninety * whole, `${rows} rows ${risk} returns more than 90%`);
      assert.ok(weighted >= 8_970n * whole, `${rows} rows ${risk} returns under 89.7%`);
    }
  });

  it('pays the same either side, and less towards the centre', () => {
    for (const { rows, risk } of boards) {
      const table = multipliersFor(rows, risk);
      assert.deepEqual([...table].reverse(), [...table], `${rows} ${risk} is not symmetric`);
      for (let k = 1; k <= rows / 2; k += 1) {
        assert.ok(table[k]! <= table[k - 1]!, `${rows} ${risk} slot ${k} pays more than the slot outside it`);
      }
      assert.ok(table.every((bps) => bps > 0));
    }
  });

  it('draws the path from the committed seed, exactly as a player can check it', () => {
    const seed = 'ab'.repeat(32);
    const path16 = plinkoPath(seed, 'client', 3, 16);
    assert.deepEqual(plinkoPath(seed, 'client', 3, 16), path16);
    assert.equal(path16.length, 16);
    // An independent re-implementation of the published recipe agrees.
    const digest = createHmac('sha256', seed).update('client:3').digest();
    const bits = Array.from({ length: 16 }, (_, i) => (digest[Math.floor(i / 8)]! >> (7 - (i % 8))) & 1);
    assert.deepEqual(path16, bits);
    // Fewer rows read a prefix of the same bits.
    assert.deepEqual(plinkoPath(seed, 'client', 3, 8), bits.slice(0, 8));
    assert.equal(slotOf(path16), bits.reduce((a, b) => a + b, 0));
    assert.notDeepEqual(plinkoPath(seed, 'other', 3, 16), path16);
  });

  it('lands in the slots a fair board would', () => {
    const rows = 12;
    const drops = 40_000;
    const counts = new Array(rows + 1).fill(0);
    for (let i = 0; i < drops; i += 1) counts[slotOf(plinkoPath(randomBytes(32).toString('hex'), 'c', 0, rows))] += 1;
    for (let k = 3; k <= rows - 3; k += 1) {
      const expected = (drops * Number(binomial(rows, k))) / 2 ** rows;
      assert.ok(Math.abs(counts[k] - expected) < expected * 0.1, `slot ${k}: ${counts[k]} vs ${expected}`);
    }
  });

  it('floors payouts and sizes the largest ball to the payout ceiling', () => {
    assert.equal(payoutFor(1_000_000n, 16, 'high', 0), 911_000_000n);
    assert.equal(payoutFor(1_000_000n, 16, 'high', 8), 180_000n);
    assert.equal(payoutFor(7n, 8, 'low', 4), 3n); // 7 · 0.47, floored
    assert.equal(maxMultiplierBps(16, 'high'), 9_110_000);
    const ceiling = 50_000_000_000n;
    const max = maxStakeFor(16, 'high', ceiling);
    assert.ok(payoutFor(max, 16, 'high', 0) <= ceiling);
    assert.ok(payoutFor(max + 1n, 16, 'high', 0) > ceiling);
    assert.throws(() => multipliersFor(7, 'low'));
    assert.throws(() => multipliersFor(17, 'low'));
  });
});

describe('plinko routes', () => {
  it('settles a ball in the request that places it, once', async () => {
    const source = await route();
    const bet = source.slice(source.indexOf("'/v1/plinko/bets',"), source.indexOf('async function debit('));
    // A retried request gets its first answer back and pays nothing again.
    assert.match(bet, /SELECT \* FROM plinko_bets WHERE user_id = \$1 AND idempotency_key = \$2/);
    assert.match(bet, /return \{ row: existing\.rows\[0\], wager: null/);
    // Stake first, refusing an overdraft; the payout is the only credit.
    assert.ok(bet.indexOf('await debit(') < bet.indexOf('creditWallet('));
    assert.match(source, /WHERE user_id = \$1 AND balance_minor >= \$2/);
    assert.equal(source.split('creditWallet(').length - 1, 1);
    assert.match(bet, /creditWallet\(client, userId, payout, 'plinko_payout', betId\)/);
    // Counted once, as Plinko, at Plinko's own edge.
    assert.match(bet, /recordWager\(\s*client,\s*config,\s*userId,\s*stake,\s*'plinko',\s*betId,/);
    assert.match(bet, /\(stake \* BigInt\(PLINKO_HOUSE_EDGE_BPS\)\) \/ 10_000n/);
    assert.doesNotMatch(source, /UPDATE plinko_bets/);
  });

  it('spends the seed with the bet and hands back the next commitment', async () => {
    const source = await route();
    assert.match(source, /FROM fairness_seeds WHERE user_id = \$1 AND used_at IS NULL FOR UPDATE/);
    assert.match(source, /UPDATE fairness_seeds SET used_at = now\(\) WHERE id = \$1/);
    assert.match(source, /await insertFairnessSeed\(client, config, userId\)/);
    assert.match(source, /conflict\('FAIRNESS_COMMITMENT_CHANGED'/);
    assert.match(source, /nextServerSeedHash: next/);
  });

  it('refuses a stake the payout ceiling could not cover, rather than capping it', async () => {
    const source = await route();
    assert.match(source, /const ceiling = maxStakeFor\(body\.rows, body\.risk, config\.plinkoMaxPayoutMinor\)/);
    assert.match(source, /if \(stake > ceiling\)/);
    assert.match(source, /'STAKE_OVER_PAYOUT_LIMIT'/);
  });

  it('only widens the constraints it touches, and never lets the runtime rewrite a bet', async () => {
    const kinds = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/052_plinko.sql');
    const previous = await read('packages/db/migrations/051_mines.sql');
    for (const constraint of [
      'wallet_transactions_kind_check',
      'wager_events_source_check',
      'faction_contributions_source_check',
      'referral_earnings_source_check',
    ]) {
      const before = kinds(previous, constraint);
      const after = kinds(migration, constraint);
      for (const value of before) assert.ok(after.has(value), `052 drops ${value} from ${constraint}`);
    }
    assert.ok(kinds(migration, 'wallet_transactions_kind_check').has('plinko_stake'));
    assert.ok(kinds(migration, 'wallet_transactions_kind_check').has('plinko_payout'));
    assert.ok(kinds(migration, 'wager_events_source_check').has('plinko'));
    assert.match(migration, /GRANT SELECT, INSERT ON TABLE plinko_bets TO donut_api_runtime;/);
    assert.match(migration, /UNIQUE \(fairness_seed_id\)/);
  });

  it('reads only the newest balls into the live feed', async () => {
    const activity = await read('services/api-gateway/src/routes/activity.ts');
    assert.match(activity, /FROM \(SELECT \* FROM plinko_bets ORDER BY created_at DESC LIMIT \$1\) b/);
  });
});
