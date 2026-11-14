import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';
import { addRainLock, assertWagerRequirementMet } from '../src/lib/wager-requirements.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

const config = loadConfig({
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
});

/** A client that answers the gate's three reads: the wallet, the running figure and the rain lock. */
function gateClient(balance: string, rain: { held: string; remaining: string } | null, owed = '0') {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM user_wallets')) return { rows: [{ balance_minor: balance }], rowCount: 1 };
      if (sql.includes('FROM user_wager_requirements')) return { rows: [{ remaining_minor: owed }], rowCount: 1 };
      if (sql.includes('FROM user_rain_locks')) {
        return { rows: rain ? [{ held_minor: rain.held, remaining_minor: rain.remaining }] : [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DbClient;
}

describe('Lava Rain money, held on its own', () => {
  it('is held 20 times by default, a live setting in the rain group, 0 to let it go', () => {
    assert.equal(config.rainWagerMultiplier, 20);
    assert.equal(runtimeSettingDefinitions.rainWagerMultiplier.group, 'rain');
    assert.equal(runtimeSettingDefinitions.rainWagerMultiplier.min, 0n);
  });

  it('holds only the rain money: the rest of the balance can still leave', async () => {
    // $100M balance, $40M of it rain still to wager off: up to $60M may go, not a unit more.
    const client = gateClient('100000000', { held: '40000000', remaining: '800000000' });
    await assert.doesNotReject(assertWagerRequirementMet(client, 'u', 'withdrawing', 60_000_000n));
    await assert.rejects(assertWagerRequirementMet(client, 'u', 'withdrawing', 60_000_001n), (error: any) => {
      assert.equal(error.code, 'RAIN_WAGER_REQUIREMENT');
      assert.equal(error.details.freeMinor, '60000000');
      assert.equal(error.details.heldMinor, '40000000');
      assert.equal(error.details.remainingMinor, '800000000');
      return true;
    });
    // A tip and a stake are money leaving too.
    await assert.rejects(assertWagerRequirementMet(client, 'u', 'tipping', 70_000_000n), { code: 'RAIN_WAGER_REQUIREMENT' });
    await assert.rejects(assertWagerRequirementMet(client, 'u', 'staking', 70_000_000n), { code: 'RAIN_WAGER_REQUIREMENT' });
  });

  it('holds what is there when the rain money has been partly lost, and items wait for it', async () => {
    // $30M balance against $40M held: nothing may leave until it is wagered off.
    const client = gateClient('30000000', { held: '40000000', remaining: '100' });
    await assert.rejects(assertWagerRequirementMet(client, 'u', 'withdrawing', 1n), { code: 'RAIN_WAGER_REQUIREMENT' });
    // Items carry no amount: they could be rain money in another form.
    await assert.rejects(assertWagerRequirementMet(gateClient('100000000', { held: '1', remaining: '20' }), 'u', 'withdrawing'), {
      code: 'RAIN_WAGER_REQUIREMENT',
    });
  });

  it('lets everything go once it is wagered off, and never shadows the account\'s own requirement', async () => {
    await assert.doesNotReject(assertWagerRequirementMet(gateClient('5', { held: '40000000', remaining: '0' }), 'u', 'withdrawing', 5n));
    await assert.doesNotReject(assertWagerRequirementMet(gateClient('5', null), 'u', 'withdrawing'));
    await assert.rejects(
      assertWagerRequirementMet(gateClient('100000000', { held: '1', remaining: '1' }, '7'), 'u', 'withdrawing', 1n),
      { code: 'WAGER_REQUIREMENT' },
    );
  });

  it('adds the share and the share times the multiplier, and nothing at 0x', async () => {
    const calls: unknown[][] = [];
    const client = { query: async (_sql: string, values: unknown[]) => { calls.push(values); return { rows: [], rowCount: 1 }; } } as unknown as DbClient;
    await addRainLock(client, config, 'u', 5_000_000n);
    assert.deepEqual(calls[0], ['u', '5000000', '100000000']);
    await addRainLock(client, { ...config, rainWagerMultiplier: 0 } as typeof config, 'u', 5_000_000n);
    assert.equal(calls.length, 1);
  });

  it('is what a rain share gets, and the withdraw form caps at the rest of the balance', async () => {
    const [social, app, withdrawals, migration] = await Promise.all([
      read('services/api-gateway/src/routes/social.ts'),
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/app.js'),
      read('services/api-gateway/src/routes/cash-withdrawals.ts'),
      read('packages/db/migrations/097_rain_wager_lock.sql'),
    ]);
    assert.match(social, /await addRainLock\(client, config, claim\.user_id, each\);/);
    assert.doesNotMatch(social, /addWagerRequirement/);
    assert.match(withdrawals, /rainHeldMinor: rain\.heldMinor\.toString\(\),/);
    assert.match(app, /const most = Math\.max\(0, state\.balance - rainHeld\);/);
    assert.match(app, /input\.value = String\(most\);/);
    assert.match(migration, /CREATE TABLE user_rain_locks/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE user_rain_locks TO donut_api_runtime;/);
  });
});
