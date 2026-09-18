import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '20000000-0000-4000-8000-000000000002': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  LOG_LEVEL: 'silent',
};

describe('upgrade stake ceiling', () => {
  it('defaults to a billion', () => {
    assert.equal(loadConfig({ ...base }).upgradeMaxStakeMinor, 1_000_000_000n);
  });

  it('is configurable and kept as a bigint', () => {
    /* A ceiling that round-trips through a JS number stops being exact somewhere above nine
     * quadrillion, and every other money figure in this service is a bigint for that reason. */
    const config = loadConfig({ ...base, UPGRADE_MAX_STAKE_MINOR: '250000000' });
    assert.equal(config.upgradeMaxStakeMinor, 250_000_000n);
    assert.equal(typeof config.upgradeMaxStakeMinor, 'bigint');
  });

  it('refuses a stake above the ceiling before the wallet is read', async () => {
    /* Order matters: checking the balance first would let an over-ceiling stake from an account
     * that cannot afford it come back as "insufficient balance", which sends the player off to
     * deposit money that would not have helped. */
    const source = await readFile(path.join(process.cwd(), 'src/routes/upgrades.ts'), 'utf8');
    const assign = source.indexOf('stakeValue = BigInt(body.balanceStake.balanceMinor)');
    const ceiling = source.indexOf('config.upgradeMaxStakeMinor', assign);
    const wallet = source.indexOf('SELECT balance_minor FROM user_wallets', assign);
    assert.ok(ceiling > assign, 'the route does not check the ceiling');
    assert.ok(ceiling < wallet, 'the ceiling is checked after the wallet is read');
    assert.match(source, /'STAKE_TOO_LARGE'/);
  });

  it('publishes the ceiling so the client can stop at it', async () => {
    /* The client clamps its stake field to this. A ceiling the server enforces but never states
     * is one the player only discovers by having a bet rejected. */
    const source = await readFile(path.join(process.cwd(), 'src/routes/upgrades.ts'), 'utf8');
    const endpoint = source.indexOf("'/v1/upgrades/config'");
    const published = source.indexOf('maxStakeMinor', endpoint);
    assert.ok(endpoint >= 0 && published > endpoint, 'the config endpoint does not publish it');
    // As a string: a billion fits a JS number, but the next operator to raise this should not have
    // to know where that stops being true.
    assert.match(source, /maxStakeMinor: config\.upgradeMaxStakeMinor\.toString\(\)/);
  });
});
