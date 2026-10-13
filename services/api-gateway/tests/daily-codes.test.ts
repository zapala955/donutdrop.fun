import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import {
  PRIZE_TIERS,
  TOTAL_WEIGHT,
  expectedPrizeFraction,
  normalizeDailyCode,
  pickPrize,
} from '../src/lib/daily-codes.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');
const MAX = 100_000_000n;

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

describe('the prize table', () => {
  it('adds up to a hundred percent, from nothing up to the ceiling', () => {
    assert.equal(TOTAL_WEIGHT, 10_000);
    assert.equal(PRIZE_TIERS[0]?.fractionBps, 0);
    assert.equal(PRIZE_TIERS.at(-1)?.fractionBps, 10_000);
    const fractions = PRIZE_TIERS.map((tier) => tier.fractionBps);
    assert.deepEqual(
      fractions,
      [...fractions].sort((a, b) => a - b),
    );
  });

  it('maps every roll to a prize between nothing and the ceiling, edges included', () => {
    assert.equal(pickPrize(MAX, 0), 0n);
    assert.equal(pickPrize(MAX, 5_499), 0n, 'the last roll that wins nothing');
    assert.equal(pickPrize(MAX, 5_500), 100_000n, 'the first that wins something');
    assert.equal(pickPrize(MAX, 7_999), 100_000n);
    assert.equal(pickPrize(MAX, 8_000), 500_000n);
    assert.equal(pickPrize(MAX, 9_994), 50_000_000n);
    assert.equal(pickPrize(MAX, 9_995), MAX, 'the top prize, five rolls in ten thousand');
    assert.equal(pickPrize(MAX, 9_999), MAX);
    for (let roll = 0; roll < TOTAL_WEIGHT; roll += 1) {
      const prize = pickPrize(MAX, roll);
      assert.ok(prize >= 0n && prize <= MAX, `roll ${roll} paid ${prize}`);
    }
  });

  it('scales with the ceiling and pays nothing without one', () => {
    assert.equal(pickPrize(10_000_000n, 9_999), 10_000_000n);
    assert.equal(pickPrize(10_000_000n, 5_500), 10_000n);
    assert.equal(pickPrize(0n, 9_999), 0n);
  });

  it('averages about half a percent of the ceiling, and most codes win nothing', () => {
    let total = 0n;
    let nothing = 0;
    for (let roll = 0; roll < TOTAL_WEIGHT; roll += 1) {
      const prize = pickPrize(MAX, roll);
      total += prize;
      if (prize === 0n) nothing += 1;
    }
    const average = Number(total) / TOTAL_WEIGHT / Number(MAX);
    assert.ok(Math.abs(average - expectedPrizeFraction()) < 1e-9);
    assert.ok(average > 0.005 && average < 0.0065, `average ${average}`);
    assert.ok(nothing / TOTAL_WEIGHT > 0.5, 'over half win nothing');
  });
});

describe('reading a code', () => {
  it('takes it in any case, with a dash or spaces, and refuses anything else', () => {
    assert.equal(normalizeDailyCode('abcd-efgh'), 'ABCDEFGH');
    assert.equal(normalizeDailyCode(' ABCD EFGH\n'), 'ABCDEFGH');
    assert.equal(normalizeDailyCode('ab23-cdkm'), 'AB23CDKM');
    for (const bad of [
      '',
      'ABCDEFG',
      'ABCDEFGHJ',
      'ABCD-EFG0',
      'ABCD-EFGI',
      'ABCD-EFGO',
      'ABCD-EFG1',
      'hello world',
    ]) {
      assert.equal(normalizeDailyCode(bad), null, bad);
    }
  });
});

describe('the daily code settings', () => {
  it('ship with a 100M ceiling, a 150M daily budget and redemption on', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.dailyCodesEnabled, true);
    assert.equal(config.dailyCodeMaxPrizeMinor, 100_000_000n);
    assert.equal(config.dailyCodeBudgetMinor, 150_000_000n);
  });

  it('refuse a budget smaller than the top prize', () => {
    assert.throws(
      () =>
        loadConfig({
          ...baseEnv,
          DAILY_CODE_MAX_PRIZE_MINOR: '200',
          DAILY_CODE_DAILY_BUDGET_MINOR: '100',
        }),
      /DAILY_CODE_DAILY_BUDGET_MINOR/,
    );
  });

  it('can be changed live from the System tab', () => {
    for (const key of [
      'dailyCodesEnabled',
      'dailyCodeMaxPrizeMinor',
      'dailyCodeBudgetMinor',
    ] as const) {
      assert.ok(key in runtimeSettingDefinitions, key);
      assert.equal(runtimeSettingDefinitions[key].group, 'dailycodes');
    }
  });
});

describe('how it is wired', () => {
  it('redeems on the site, for the signed-in player, and nowhere else', async () => {
    const source = await read('../src/routes/discord-rewards.ts');
    const route = source.slice(source.indexOf("'/v1/discord/daily-code/redeem'"));
    assert.match(route, /preHandler: guards\.requireCsrf/);
    assert.match(route, /rateLimit: \{ max: 20, timeWindow: '1 minute' \}/);
    assert.match(
      route,
      /SELECT discord_user_id FROM users WHERE id = \$1/,
      'the Discord account is the one linked to the session',
    );
    assert.ok(
      route.indexOf('SELECT discord_user_id FROM users') < route.indexOf('redeemDailyCode('),
      'the account is looked up before anything is redeemed',
    );
    assert.doesNotMatch(
      source.slice(0, source.indexOf("'/v1/discord/daily-code/redeem'")),
      /discordUserId: z\./,
      'the request cannot name a Discord account',
    );
    assert.match(
      source,
      /const redeemSchema = z\.object\(\{ code: z\.string\(\)\.min\(1\)\.max\(40\) \}\)\.strict\(\)/,
    );
    assert.match(source, /dailyCodes,/, 'the rewards read says what a code can be worth');
  });

  it('gives the bot no way to redeem a code', async () => {
    const source = await read('../src/routes/community-bot.ts');
    assert.doesNotMatch(source, /daily-code\/redeem|redeemDailyCode|redeemSchema/);
    assert.match(
      source,
      /dailyCodes: \{\s*enabled: config\.dailyCodesEnabled/,
      'it still reads the ceiling for the DM',
    );
  });

  it('pays through the ledger under the code’s own id, with the wager requirement every reward carries', async () => {
    const source = await read('../src/lib/daily-codes.ts');
    assert.match(source, /creditWallet\(client, user\.id, prize, 'daily_code_reward', row\.id\)/);
    assert.match(source, /requirementFor\(prize, config\.signupBonusWagerMultiplier\)/);
    assert.match(source, /pg_advisory_xact_lock\(hashtextextended\('daily-code-budget', 0\)\)/);
    assert.match(source, /FROM discord_daily_codes WHERE code = \$1 FOR UPDATE/);
    assert.match(source, /WHERE id = \$1 AND redeemed_at IS NULL/);
  });

  it('adds the ledger kind everywhere a kind has to be named', async () => {
    assert.match(await read('../src/lib/wallet.ts'), /\| 'daily_code_reward'/);
    assert.match(await read('../src/lib/admin-stats.ts'), /daily_code_reward: 'Daily codes'/);
    const sql = await read('../../../packages/db/migrations/064_daily_codes.sql');
    assert.match(
      sql,
      /'mines_duel_stake', 'mines_duel_win', 'mines_duel_refund',\s*'daily_code_reward'/,
    );
    const label = await read('../../../DONUTDROP FRONTEND/Donut Drop/assets/js/account.js');
    assert.match(label, /daily_code_reward: 'Daily code'/);
  });

  it('adds only new tables, two defaulted columns and one ledger kind', async () => {
    const sql = await read('../../../packages/db/migrations/064_daily_codes.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|ALTER COLUMN/i);
    assert.match(sql, /CREATE TABLE discord_daily_subscribers/);
    assert.match(sql, /CREATE TABLE discord_daily_codes/);
    assert.match(
      sql,
      /code varchar\(8\) NOT NULL UNIQUE CHECK \(code ~ '\^\[A-HJ-NP-Z2-9\]\{8\}\$'\)/,
    );
    assert.match(sql, /UNIQUE \(guild_id, discord_user_id, issued_on\)/);
    assert.match(sql, /ADD COLUMN daily_codes_enabled boolean NOT NULL DEFAULT false/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v64\(\) RETURNS boolean/);
  });

  it('is switched on and tuned from the dashboard, and sends nobody anything until it is', async () => {
    const route = await read('../src/routes/admin-discord.ts');
    assert.match(route, /dailyCodesEnabled: z\.boolean\(\)\.optional\(\)/);
    assert.match(
      route,
      /dailyCodesHour: z\.number\(\)\.int\(\)\.min\(0\)\.max\(23\)\.optional\(\)/,
    );
    assert.match(
      route,
      /dailyCodesEnabled: previous\.daily_codes_enabled/,
      'before and after are audited',
    );
    const js = await read('../../../DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(js, /name: 'dailyCodesEnabled'/);
    assert.match(js, /dailyCodesHour: hour/);
    const sql = await read('../../../packages/db/migrations/064_daily_codes.sql');
    assert.match(sql, /daily_codes_enabled boolean NOT NULL DEFAULT false/);
  });
});
