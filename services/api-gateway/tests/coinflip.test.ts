import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/lib/db.js';
import { flipCoin, otherSide } from '../src/lib/coinflip.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    APP_ORIGIN: 'http://localhost:3000',
    COOKIE_SECRET: 'c'.repeat(32),
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    BOT_CREDENTIALS_JSON: JSON.stringify({
      '10000000-0000-4000-8000-000000000001': {
        secret: Buffer.alloc(32, 2).toString('base64'),
        serverHost: 'donutsmp.net',
        username: 'DonutBot',
      },
    }),
    AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
    IP_HASH_KEY: 'i'.repeat(32),
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

describe('the coin', () => {
  it('is exactly the published HMAC derivation', () => {
    const serverSeed = 'ab'.repeat(32);
    const digest = createHmac('sha256', serverSeed).update('coinflip:host-seed:opp-seed').digest();
    const flip = flipCoin(serverSeed, 'host-seed', 'opp-seed');
    assert.equal(flip.digestHex, digest.toString('hex'));
    assert.equal(flip.side, digest[0]! < 128 ? 'heads' : 'tails');
  });

  it('lands the same way for the same seeds, every time', () => {
    const first = flipCoin('s'.repeat(64), 'a', 'b');
    for (let index = 0; index < 20; index += 1) {
      assert.deepEqual(flipCoin('s'.repeat(64), 'a', 'b'), first);
    }
  });

  it('lets each of the three seeds move the result', () => {
    const sides = (vary: (n: number) => [string, string, string]) =>
      new Set(Array.from({ length: 64 }, (_, n) => flipCoin(...vary(n)).side));
    assert.equal(sides((n) => [`server-${n}`, 'host', 'opp']).size, 2);
    assert.equal(sides((n) => ['server', `host-${n}`, 'opp']).size, 2);
    assert.equal(sides((n) => ['server', 'host', `opp-${n}`]).size, 2);
  });

  it('is a fair coin', () => {
    let heads = 0;
    const flips = 20_000;
    for (let index = 0; index < flips; index += 1) {
      if (flipCoin(`seed-${index}`, 'host', 'opp').side === 'heads') heads += 1;
    }
    // Five standard deviations of a fair binomial at n = 20k is about ±354.
    assert.ok(Math.abs(heads - flips / 2) < 360, `heads ${heads} of ${flips}`);
  });

  it('gives the opponent the side the host did not take', () => {
    assert.equal(otherSide('heads'), 'tails');
    assert.equal(otherSide('tails'), 'heads');
  });
});

describe('the coinflip routes', () => {
  const route = () => read('services/api-gateway/src/routes/coinflip.ts');

  it('takes the stake, flips and pays in the one transaction that joins', async () => {
    const source = await route();
    const join = source.slice(
      source.indexOf("'/v1/coinflip/:code/join'"),
      source.indexOf("'/v1/coinflip/:code/cancel'"),
    );
    const order = [
      'assertGameEligible(client, userId)',
      'FOR UPDATE OF g',
      "debitStake(client, userId, stake, row.id, 'opponent')",
      'flipCoin(serverSeed, row.host_client_seed, opponentClientSeed)',
      "WHERE id = $1 AND status = 'open'",
      "'coinflip_win'",
      'recordWager(',
    ].map((needle) => {
      const at = join.indexOf(needle);
      assert.ok(at >= 0, `join is missing ${needle}`);
      return at;
    });
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      'join steps are out of order',
    );
    assert.match(join, /CANNOT_FLIP_SELF/);
  });

  it('never counts a stake that can still be refunded', async () => {
    const source = await route();
    const create = source.slice(
      source.indexOf("'/v1/coinflip',"),
      source.indexOf("'/v1/coinflip/:code/join'"),
    );
    const cancel = source.slice(source.indexOf("'/v1/coinflip/:code/cancel'"));
    assert.doesNotMatch(create, /recordWager\(/);
    assert.doesNotMatch(cancel, /recordWager\(/);
  });

  it('refunds a cancel and a lapse through the same guarded close', async () => {
    const source = await route();
    const refund = source.slice(source.indexOf('async function refundOpenGame('));
    assert.match(refund, /SET status = 'cancelled' WHERE id = \$1 AND status = 'open'/);
    assert.match(refund, /deterministicUuid\('coinflip_refund', row\.id, 'host'\)/);
    assert.equal(
      source.split('refundOpenGame(client,').length - 1,
      2,
      'cancel and sweep both refund',
    );
  });

  it('never publishes the sealed seed', async () => {
    const source = await route();
    const shape = source.slice(
      source.indexOf('function publicGame('),
      source.indexOf('async function debitStake('),
    );
    assert.doesNotMatch(shape, /server_seed_ciphertext/);
    assert.match(shape, /serverSeed: row\.server_seed_reveal/);
  });

  it('only widens the constraints it touches', async () => {
    const kinds = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set(
        [...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      );
    };
    const migration = await read('packages/db/migrations/054_coinflip.sql');
    const plinko = await read('packages/db/migrations/052_plinko.sql');
    for (const constraint of [
      'wallet_transactions_kind_check',
      'wager_events_source_check',
      'faction_contributions_source_check',
      'referral_earnings_source_check',
    ]) {
      const before = kinds(plinko, constraint);
      const after = kinds(migration, constraint);
      for (const value of before)
        assert.ok(after.has(value), `054 drops ${value} from ${constraint}`);
    }
    const ledger = kinds(migration, 'wallet_transactions_kind_check');
    assert.equal(ledger.size, kinds(plinko, 'wallet_transactions_kind_check').size + 3);
    assert.ok(kinds(migration, 'wager_events_source_check').has('coinflip'));
    assert.match(migration, /CONSTRAINT coinflip_open_holds_no_answer/);
  });

  it('serves the board to visitors who have not signed in', async () => {
    const database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => undefined,
    } as unknown as Database;
    const app = await buildApp(testConfig(), database);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/coinflip' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.rakeBps, 300);
      assert.equal(body.minStakeMinor, '100000');
      assert.deepEqual(body.games, []);
      assert.deepEqual(body.recent, []);
    } finally {
      await app.close();
    }
  });

  it('is absent when switched off', async () => {
    const database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => undefined,
    } as unknown as Database;
    const app = await buildApp(testConfig({ COINFLIP_ENABLED: 'false' }), database);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/coinflip' });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error?.code ?? response.json().code, 'COINFLIP_DISABLED');
    } finally {
      await app.close();
    }
  });
});

describe('coinflip configuration', () => {
  it('refuses a rake the VIP ladder would out-pay', () => {
    assert.throws(
      () => testConfig({ VIP_ENABLED: 'true', COINFLIP_RAKE_BPS: '200' }),
      /COINFLIP_RAKE_BPS/,
    );
  });

  it('refuses a minimum stake the rake would round to nothing on', () => {
    assert.throws(() => testConfig({ COINFLIP_MIN_STAKE_MINOR: '1' }), /COINFLIP_MIN_STAKE_MINOR/);
  });
});
