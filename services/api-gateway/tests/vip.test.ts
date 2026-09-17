import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  LADDER,
  MAX_RATE,
  RATE_SCALE,
  SUB_LEVELS,
  TIERS,
  assertVipSolvency,
  levelFor,
  nextLevelFor,
  progressFor,
  vipRakebackMinor,
} from '../src/lib/vip.js';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/019_vip_levels.sql',
);
const settlementPath = path.resolve(import.meta.dirname, '../src/lib/cash-settlement.ts');

const baseEnv = {
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
  VIP_ENABLED: 'true',
};

const config = (overrides: Record<string, string> = {}): AppConfig =>
  loadConfig({ ...baseEnv, ...overrides });

/** Percent as a plain number, for readable assertions. 2.00% -> 2. */
const pct = (rate: number): number => rate / Number(RATE_SCALE / 100n);

describe('vip ladder shape', () => {
  it('is exactly six tiers of five sub-levels', () => {
    assert.equal(LADDER.length, 30);
    assert.equal(TIERS.length, 6);
    assert.equal(SUB_LEVELS.length, 5);
    for (const tier of TIERS) {
      assert.equal(LADDER.filter((level) => level.tier === tier).length, 5);
    }
  });

  it('numbers levels 1-30 in order', () => {
    LADDER.forEach((level, index) => assert.equal(level.level, index + 1));
  });

  it('has strictly ascending thresholds, so no two levels can tie', () => {
    for (let index = 1; index < LADDER.length; index += 1) {
      assert.equal(
        LADDER[index]!.thresholdMinor > LADDER[index - 1]!.thresholdMinor,
        true,
        `threshold ${index + 1} must exceed ${index}`,
      );
    }
  });

  it('has strictly ascending rates, so levelling up can never pay less', () => {
    for (let index = 1; index < LADDER.length; index += 1) {
      assert.equal(LADDER[index]!.rakebackBps > LADDER[index - 1]!.rakebackBps, true);
    }
  });

  it('starts at 0.10% and caps at exactly 2.00%', () => {
    assert.equal(pct(LADDER[0]!.rakebackBps), 0.1);
    assert.equal(pct(MAX_RATE), 2);
    assert.equal(LADDER[0]!.label, 'Bronze I');
    assert.equal(LADDER[29]!.label, 'High Roller V');
    // Bronze I is reachable by everybody, including an account that has never wagered.
    assert.equal(LADDER[0]!.thresholdMinor, 0n);
  });

  it('never exceeds the 2.00% ceiling anywhere on the ladder', () => {
    for (const level of LADDER) assert.equal(level.rakebackBps <= MAX_RATE, true);
  });

  it('matches every specified per-tier rate scale exactly', () => {
    const expected: Record<string, readonly number[]> = {
      bronze: [0.1, 0.14, 0.18, 0.22, 0.26],
      silver: [0.3, 0.35, 0.4, 0.45, 0.5],
      gold: [0.55, 0.625, 0.7, 0.775, 0.85],
      platinum: [0.9, 0.975, 1.05, 1.125, 1.2],
      diamond: [1.25, 1.3375, 1.425, 1.5125, 1.6],
      high_roller: [1.65, 1.7375, 1.825, 1.9125, 2],
    };
    for (const [tier, rates] of Object.entries(expected)) {
      const actual = LADDER.filter((level) => level.tier === tier).map((level) =>
        pct(level.rakebackBps),
      );
      assert.deepEqual(actual, rates, `${tier} rate scale`);
    }
  });

  it('opens each tier at its specified wager band', () => {
    const entry = (tier: string) => LADDER.find((level) => level.tier === tier)!.thresholdMinor;
    assert.equal(entry('bronze'), 0n);
    assert.equal(entry('silver'), 50_000_000n);
    assert.equal(entry('gold'), 250_000_000n);
    assert.equal(entry('platinum'), 1_250_000_000n);
    assert.equal(entry('diamond'), 5_000_000_000n);
    assert.equal(entry('high_roller'), 25_000_000_000n);
  });
});

describe('vip level resolution', () => {
  it('puts a brand new account at the bottom rather than nowhere', () => {
    assert.equal(levelFor(0n).label, 'Bronze I');
    assert.equal(levelFor(1n).label, 'Bronze I');
  });

  it('awards a level at its threshold, not one unit past it', () => {
    assert.equal(levelFor(50_000_000n).label, 'Silver I');
    assert.equal(levelFor(49_999_999n).label, 'Bronze V');
    assert.equal(levelFor(250_000_000n).label, 'Gold I');
    assert.equal(levelFor(25_000_000_000n).label, 'High Roller I');
  });

  it('keeps the lower level between two thresholds', () => {
    // Halfway between Gold I (250M) and Gold II (345M) is still Gold I.
    assert.equal(levelFor(300_000_000n).label, 'Gold I');
  });

  it('tops out and stays there however large the total gets', () => {
    assert.equal(levelFor(76_000_000_000n).label, 'High Roller V');
    assert.equal(levelFor(100_000_000_000n).label, 'High Roller V');
    assert.equal(levelFor(9_000_000_000_000n).label, 'High Roller V');
    assert.equal(nextLevelFor(100_000_000_000n), null);
  });

  it('reports progress toward the next level, and a full bar at the top', () => {
    // Gold I spans 250M -> 345M. At 297.5M that is exactly half.
    const mid = progressFor(297_500_000n);
    assert.equal(mid.current.label, 'Gold I');
    assert.equal(mid.next?.label, 'Gold II');
    assert.equal(Math.round(mid.ratio * 100), 50);
    assert.equal(mid.remainingMinor, 47_500_000n);

    const top = progressFor(200_000_000_000n);
    assert.equal(top.next, null);
    assert.equal(top.ratio, 1);
    assert.equal(top.remainingMinor, 0n);
  });
});

describe('vip rakeback arithmetic', () => {
  it('pays a share of the wager, which is what the 2% ceiling is measured against', () => {
    // 2.00% of a 1,000,000 wager is 20,000.
    assert.equal(vipRakebackMinor(MAX_RATE, 1_000_000n), 20_000n);
    // Bronze I, 0.10%, is 1,000 on the same wager.
    assert.equal(vipRakebackMinor(LADDER[0]!.rakebackBps, 1_000_000n), 1_000n);
  });

  it('represents the fractional increments exactly, with no rounding drift', () => {
    // 0.0875% of 10,000,000 is 8,750 exactly — the increment that would be lost to whole bps.
    const diamondOne = LADDER.find((level) => level.label === 'Diamond I')!;
    const diamondTwo = LADDER.find((level) => level.label === 'Diamond II')!;
    assert.equal(diamondTwo.rakebackBps - diamondOne.rakebackBps, 875);
    assert.equal(vipRakebackMinor(875, 10_000_000n), 8_750n);
  });

  it('truncates rather than rounding a fraction of a unit up', () => {
    assert.equal(vipRakebackMinor(LADDER[0]!.rakebackBps, 100n), 0n);
    assert.equal(vipRakebackMinor(MAX_RATE, 0n), 0n);
    assert.equal(vipRakebackMinor(MAX_RATE, -5n), 0n);
    assert.equal(vipRakebackMinor(0, 1_000_000n), 0n);
  });

  it('leaves the house the larger share of the margin even at the ceiling', () => {
    /* The ceiling is specified as preserving a 10% edge. 2% of wager against a 10% edge is a fifth
     * of the margin; the house keeps four fifths before anything else is taken. */
    const wager = 1_000_000n;
    const crateMargin = (wager * 1_000n) / 10_000n; // 10% edge
    assert.equal(vipRakebackMinor(MAX_RATE, wager) * 5n, crateMargin);
  });
});

describe('vip solvency guard', () => {
  it('accepts the shipped ceiling against the platform default edge', () => {
    assert.doesNotThrow(() => assertVipSolvency(config()));
  });

  it('refuses a configuration whose combined giveback meets the edge it is paid from', () => {
    /* The upgrader's 5% edge is the binding one. Drop it to 2% and the 2% VIP ceiling alone
     * consumes the whole margin, which must be refused rather than discovered in a ledger. */
    assert.throws(() => assertVipSolvency(config({ HOUSE_EDGE_BPS: '200' })), /not solvent/);
  });

  it('counts the tier rakebacks and the referral share against the same margin', () => {
    /* At a 2.05% edge the VIP ceiling alone fits, but adding the margin-priced givebacks does not.
     * This is the case a per-programme check would miss and only a combined one catches. */
    assert.doesNotThrow(() =>
      assertVipSolvency(
        config({ HOUSE_EDGE_BPS: '205', RAKEBACK_ENABLED: 'false', REFERRALS_ENABLED: 'false' }),
      ),
    );
    assert.throws(
      () =>
        assertVipSolvency(
          config({
            HOUSE_EDGE_BPS: '205',
            RAKEBACK_ENABLED: 'true',
            RAKEBACK_INSTANT_BPS: '9000',
            RAKEBACK_DAILY_BPS: '500',
            RAKEBACK_WEEKLY_BPS: '300',
            RAKEBACK_MONTHLY_BPS: '200',
          }),
        ),
      /not solvent/,
    );
  });

  it('stays out of the way entirely when the programme is off', () => {
    assert.doesNotThrow(() =>
      assertVipSolvency(config({ VIP_ENABLED: 'false', HOUSE_EDGE_BPS: '1' })),
    );
  });
});

describe('vip schema and wiring', () => {
  it('keeps the lifetime total on one row rather than aggregating history', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE TABLE user_wager_totals/);
    assert.match(sql, /user_id uuid PRIMARY KEY REFERENCES users\(id\)/);
    assert.match(sql, /wagered_minor bigint NOT NULL DEFAULT 0 CHECK \(wagered_minor >= 0\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v19\(\) RETURNS boolean/);
  });

  it('adds the vip tier to both halves of the rakeback ledger', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /rakeback_accruals[\s\S]*?'instant', 'daily', 'weekly', 'monthly', 'vip'/);
    assert.match(sql, /rakeback_claims[\s\S]*?'instant', 'daily', 'weekly', 'monthly', 'vip'/);
  });

  it('accrues from the one place every game route settles a wager through', async () => {
    /* The assertion is that VIP accrual happens inside recordWager and nowhere else, not that it is
     * the last line of it. It stopped being the last line when the vault jackpot was added — that
     * draw also has to run on every wager — so the check is that the call is there, with the right
     * arguments, in this file. */
    const source = await readFile(settlementPath, 'utf8');
    assert.match(source, /await recordVipWager\(client, config, userId, amountMinor\)/);
    // And that the result still reaches the caller, which is how a level-up gets announced.
    assert.match(source, /return \{ vip, jackpot \}/);
  });
});
