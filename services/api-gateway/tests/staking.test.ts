import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  effectiveShareBps,
  lotResult,
  nextDay,
  poolResultFor,
  utcDay,
} from '../src/lib/staking.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');
const front = (relative: string) => read(`../../../DONUTDROP FRONTEND/Donut Drop/${relative}`);

const baseEnv = {
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
  GAME_CURRENCY_ONLY: 'true',
  LOG_LEVEL: 'silent',
};

const B = 1_000_000_000n;

describe('the pool maths', () => {
  it('gives a full pool the whole share, and a part-full one the same share per unit', () => {
    assert.equal(poolResultFor(500_000_000n, 2_000, 10n * B, 10n * B), 100_000_000n);
    assert.equal(poolResultFor(500_000_000n, 2_000, 4n * B, 10n * B), 40_000_000n);
    // Per 1B staked the result is the same whatever the fill: 10M here.
    assert.equal(poolResultFor(500_000_000n, 2_000, 1n * B, 10n * B), 10_000_000n);
    // Over the cap the pool still gets only the whole share.
    assert.equal(poolResultFor(500_000_000n, 2_000, 20n * B, 10n * B), 100_000_000n);
  });

  it('shares losing days the same way, and nothing without stakes or a share', () => {
    assert.equal(poolResultFor(-1_000_000_000n, 2_000, 4n * B, 10n * B), -80_000_000n);
    assert.equal(poolResultFor(500_000_000n, 2_000, 0n, 10n * B), 0n);
    assert.equal(poolResultFor(500_000_000n, 0, 4n * B, 10n * B), 0n);
  });

  it('splits by stake, rounds toward zero, and never takes more than a stake holds', () => {
    assert.equal(lotResult(40_000_000n, 3n * B, 4n * B), 30_000_000n);
    assert.equal(lotResult(40_000_000n, 1n * B, 4n * B), 10_000_000n);
    assert.equal(lotResult(-80_000_000n, 3n * B, 4n * B), -60_000_000n);
    assert.equal(lotResult(10n, 1n, 3n), 3n);
    assert.equal(lotResult(-10n, 1n, 3n), -1n);
    assert.equal(lotResult(-1_000n, 5n, 6n), -5n, 'a loss is capped at the stake');
  });

  it('reports the effective share for the page', () => {
    assert.equal(effectiveShareBps(2_000, 4n * B, 10n * B), 800);
    assert.equal(effectiveShareBps(2_000, 20n * B, 10n * B), 2_000);
    assert.equal(effectiveShareBps(2_000, 0n, 10n * B), 0);
  });

  it('walks UTC days', () => {
    assert.equal(utcDay(new Date('2026-10-20T23:59:59Z')), '2026-10-20');
    assert.equal(nextDay('2026-10-31'), '2026-11-01');
    assert.equal(nextDay('2026-12-31'), '2027-01-01');
  });
});

describe('the settings', () => {
  it('ship closed, 20% of a full pool, a 50B cap, 10M to 5B a player and a 48h cool-down', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.stakingEnabled, false);
    assert.equal(config.stakingShareBps, 2_000);
    assert.equal(config.stakingPoolCapMinor, 50n * B);
    assert.equal(config.stakingMinStakeMinor, 10_000_000n);
    assert.equal(config.stakingMaxPerPlayerMinor, 5n * B);
    assert.equal(config.stakingUnstakeHours, 48);
    assert.throws(() => loadConfig({ ...baseEnv, STAKING_SHARE_BPS: '5001' }), /STAKING_SHARE_BPS/);
  });

  it('can be changed live from the System tab, all but the sweep interval', () => {
    for (const key of [
      'stakingEnabled',
      'stakingShareBps',
      'stakingPoolCapMinor',
      'stakingMinStakeMinor',
      'stakingMaxPerPlayerMinor',
      'stakingUnstakeHours',
    ] as const) {
      assert.ok(key in runtimeSettingDefinitions, key);
      assert.equal(runtimeSettingDefinitions[key].group, 'staking');
    }
    assert.ok(!('stakingSweepSeconds' in runtimeSettingDefinitions));
  });
});

describe('how it is kept', () => {
  it('settles a day once, from the ledger, with staff out, under one lock', async () => {
    const source = await read('../src/lib/staking.ts');
    assert.match(source, /WHERE t\.kind IN \(\$\{GAME_KINDS_SQL\}\)/);
    assert.match(source, /AND NOT \$\{staffPredicate\('u'\)\}/);
    assert.match(source, /pg_advisory_xact_lock\(hashtextextended\('staking-settle', 0\)\)/);
    assert.match(source, /SELECT 1 FROM staking_days WHERE day = \$1::date/);
    assert.match(source, /export const SETTLE_DELAY_MS = 10 \* 60_000;/);
  });

  it('counts only stakes in for the whole day', async () => {
    const source = await read('../src/lib/staking.ts');
    assert.match(
      source,
      /earning_from <= \$1::date\s+AND \(unlocks_at IS NULL OR unlocks_at >= \$2\)/,
    );
    assert.match(
      source,
      /\(now\(\) AT TIME ZONE 'UTC'\)::date \+ 1/,
      'a stake earns from the next day',
    );
  });

  it('pays through the ledger and takes losses off the stake', async () => {
    const source = await read('../src/lib/staking.ts');
    assert.match(source, /creditWallet\(client, lot\.user_id, slice, 'staking_reward', id\)/);
    assert.match(
      source,
      /UPDATE staking_lots SET principal_minor = principal_minor \+ \$2 WHERE id = \$1/,
    );
    assert.match(source, /creditWallet\(client, lot\.user_id, amount, 'staking_release', lotId\)/);
  });

  it('refuses bonus money, and caps both the player and the pool', async () => {
    const source = await read('../src/lib/staking.ts');
    assert.match(source, /assertWagerRequirementMet\(client, userId, 'staking'\)/);
    assert.match(source, /'STAKE_LIMIT'/);
    assert.match(source, /'STAKING_POOL_FULL'/);
    assert.match(source, /pg_advisory_xact_lock\(hashtextextended\('staking-pool', 0\)\)/);
  });

  it("is started with the app, and the routes are the player's own", async () => {
    const app = await read('../src/app.ts');
    assert.match(app, /startStakingJobs\(app, db, config\);/);
    assert.match(app, /await registerStakingRoutes\(app, db, config\);/);
    const routes = await read('../src/routes/staking.ts');
    assert.match(routes, /'\/v1\/staking\/stake',\s+\{ preHandler: guards\.requireCsrf/);
    assert.match(
      routes,
      /'\/v1\/staking\/lots\/:id\/unstake',\s+\{ preHandler: guards\.requireCsrf/,
    );
  });
});

describe('the migration and the ledger', () => {
  it('adds three tables and three ledger kinds, and nothing destructive', async () => {
    const sql = await read('../../../packages/db/migrations/082_staking.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|ALTER COLUMN/i);
    for (const table of ['staking_lots', 'staking_days', 'staking_lot_days']) {
      assert.match(sql, new RegExp(`CREATE TABLE ${table}`), table);
    }
    assert.match(sql, /'bounty_reward',\s*'staking_stake', 'staking_release', 'staking_reward'/);
    // The list is rebuilt in full: every kind 076-081 added has to survive it.
    for (const kind of ['fishing_stake', 'fishing_payout', 'ice_fishing_stake', 'ice_fishing_payout', 'derby_stake', 'derby_payout']) {
      assert.match(sql, new RegExp(`'${kind}'`), `${kind} would be dropped from the ledger`);
    }
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v82\(\) RETURNS boolean/);
  });

  it('names the kinds everywhere a kind has to be named', async () => {
    const wallet = await read('../src/lib/wallet.ts');
    for (const kind of ['staking_stake', 'staking_release', 'staking_reward']) {
      assert.match(wallet, new RegExp(`\\| '${kind}'`), kind);
    }
    assert.match(await read('../src/lib/admin-stats.ts'), /staking_reward: 'House pool'/);
    const account = await front('assets/js/account.js');
    assert.match(account, /staking_stake: 'House pool stake'/);
    assert.match(account, /staking_reward: 'House pool profit'/);
  });

  it('shows the operator what is staked, as owed', async () => {
    const admin = await read('../src/routes/admin-operations.ts');
    assert.match(
      admin,
      /FROM staking_lots WHERE status <> 'closed'\)::text\s+AS staked_total_minor/,
    );
    assert.match(
      await front('admin/admin.js'),
      /'House pool',\s+compactAmount\(m\.staked_total_minor \?\? 0\)/,
    );
  });
});

describe('what the player sees', () => {
  it('the Rewards page carries the pool, and the bell reports each day', async () => {
    const html = await front('index.html');
    assert.match(html, /<div class="pool" id="stakingRoot"><\/div>/);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/staking\.css" \/>/);
    assert.match(
      await front('assets/js/rakeback.js'),
      /mountStaking\(\$\('#stakingRoot', view\)\);/,
    );
    const lib = await read('../src/lib/notifications.ts');
    assert.match(lib, /kind: 'staking_day'/);
    assert.match(lib, /kind: 'staking_released'/);
    const page = await front('assets/js/notices.js');
    assert.match(page, /staking_day: \{/);
    assert.match(page, /staking_released: \{/);
  });
});
