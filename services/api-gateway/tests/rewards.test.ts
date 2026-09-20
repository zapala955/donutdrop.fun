import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  RAKEBACK_TIERS,
  TIER_COOLDOWN_MS,
  houseMarginMinor,
  isValidCurve,
  prizeForRank,
  rakebackMinor,
  tierViews,
} from '../src/lib/rewards.js';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/017_rakeback_races_creators.sql',
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
  RAKEBACK_ENABLED: 'true',
  RACES_ENABLED: 'true',
  CREATOR_PROGRAMME_ENABLED: 'true',
};

const config = (overrides: Record<string, string> = {}): AppConfig =>
  loadConfig({ ...baseEnv, ...overrides });

describe('rakeback rates', () => {
  it('pays a share of the house margin, never a share of the wager', () => {
    const settings = config();
    // A 1,000,000 wager at a 10% edge earns the house 100,000.
    assert.equal(houseMarginMinor(settings, 1_000_000n), 100_000n);
    // The instant tier's "10%" is 10% of THAT, which is 10,000 — not 100,000.
    assert.equal(rakebackMinor(settings, 'instant', 1_000_000n), 10_000n);
    assert.notEqual(rakebackMinor(settings, 'instant', 1_000_000n), 100_000n);
  });

  it('keeps the four tiers together well inside the margin they are drawn from', () => {
    const settings = config();
    const wager = 10_000_000n;
    const margin = houseMarginMinor(settings, wager);
    const total = RAKEBACK_TIERS.reduce(
      (sum, tier) => sum + rakebackMinor(settings, tier, wager),
      0n,
    );
    // 10 + 5 + 3 + 2 = 20% of the margin. The house keeps the other 80%.
    assert.equal(total, margin / 5n);
    assert.equal(total < margin, true);
  });

  it('truncates rather than rounding a fraction of a unit up', () => {
    const settings = config();
    assert.equal(rakebackMinor(settings, 'monthly', 100n), 0n);
    assert.equal(rakebackMinor(settings, 'instant', 0n), 0n);
    assert.equal(rakebackMinor(settings, 'instant', -5n), 0n);
  });

  it('refuses a combined rate that would outpay the margin', () => {
    assert.throws(() =>
      loadConfig({
        ...baseEnv,
        RAKEBACK_INSTANT_BPS: '5000',
        RAKEBACK_DAILY_BPS: '4000',
        RAKEBACK_WEEKLY_BPS: '3000',
        RAKEBACK_MONTHLY_BPS: '1000',
      }),
    );
  });

  it('allows an overlarge combined rate only while the programme is off', () => {
    assert.doesNotThrow(() =>
      loadConfig({
        ...baseEnv,
        RAKEBACK_ENABLED: 'false',
        RAKEBACK_INSTANT_BPS: '9000',
        RAKEBACK_DAILY_BPS: '9000',
      }),
    );
  });
});

describe('rakeback tier views', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('reports a claimable balance and no clock on a tier never claimed', () => {
    const views = tierViews(
      config(),
      [{ tier: 'instant', accrued_minor: '5000', claimed_minor: '0', last_claim_at: null }],
      now,
    );
    const instant = views.find((view) => view.tier === 'instant');
    assert.equal(instant?.claimableMinor, '5000');
    assert.equal(instant?.claimable, true);
    assert.equal(instant?.availableAt, null);
  });

  it('holds a tier shut until its cooldown expires', () => {
    const justClaimed = new Date(now.getTime() - 60_000);
    const views = tierViews(
      config(),
      [{ tier: 'daily', accrued_minor: '9000', claimed_minor: '1000', last_claim_at: justClaimed }],
      now,
    );
    const daily = views.find((view) => view.tier === 'daily');
    assert.equal(daily?.claimableMinor, '8000');
    // Money has accrued since the claim, but the clock has not run out.
    assert.equal(daily?.claimable, false);
    assert.equal(
      daily?.availableAt,
      new Date(justClaimed.getTime() + TIER_COOLDOWN_MS.daily).toISOString(),
    );
  });

  it('reopens a tier once the cooldown has passed', () => {
    const longAgo = new Date(now.getTime() - TIER_COOLDOWN_MS.weekly - 1000);
    const views = tierViews(
      config(),
      [{ tier: 'weekly', accrued_minor: '400', claimed_minor: '100', last_claim_at: longAgo }],
      now,
    );
    const weekly = views.find((view) => view.tier === 'weekly');
    assert.equal(weekly?.claimable, true);
    assert.equal(weekly?.availableAt, null);
  });

  it('always returns all four tiers, even for a player with no rows at all', () => {
    const views = tierViews(config(), [], now);
    assert.deepEqual(
      views.map((view) => view.tier),
      [...RAKEBACK_TIERS],
    );
    assert.equal(
      views.every((view) => view.claimableMinor === '0'),
      true,
    );
    assert.equal(
      views.some((view) => view.claimable),
      false,
    );
  });

  it('never offers a negative balance when a tier is fully claimed', () => {
    const views = tierViews(
      config(),
      [{ tier: 'instant', accrued_minor: '7000', claimed_minor: '7000', last_claim_at: now }],
      now,
    );
    assert.equal(views.find((view) => view.tier === 'instant')?.claimableMinor, '0');
    assert.equal(views.find((view) => view.tier === 'instant')?.claimable, false);
  });
});

describe('race payout curve', () => {
  it('pays each rank its share of the pool', () => {
    const pool = 1_000_000_000n;
    const curve = [3000, 2000, 1200];
    assert.equal(prizeForRank(pool, curve, 1), 300_000_000n);
    assert.equal(prizeForRank(pool, curve, 2), 200_000_000n);
    assert.equal(prizeForRank(pool, curve, 3), 120_000_000n);
  });

  it('pays nothing past the end of the curve, which is what makes 50 places affordable', () => {
    assert.equal(prizeForRank(1_000_000_000n, [3000, 2000], 3), 0n);
    assert.equal(prizeForRank(1_000_000_000n, [3000, 2000], 50), 0n);
  });

  it('never distributes more than the pool it is drawn from', () => {
    const pool = 1_000_000_000n;
    const curve = [3000, 2000, 1200, 900, 700, 600, 500, 400, 400, 300];
    const total = curve.reduce((sum, _, index) => sum + prizeForRank(pool, curve, index + 1), 0n);
    assert.equal(total <= pool, true);
  });

  it('rejects a curve that would pay out more than the pool', () => {
    assert.equal(isValidCurve([6000, 5000]), false);
    assert.equal(isValidCurve([3000, 2000, 1200]), true);
    assert.equal(isValidCurve([]), false);
    assert.equal(isValidCurve('nope'), false);
    assert.equal(isValidCurve([-100, 500]), false);
    assert.equal(isValidCurve([1.5, 500]), false);
  });
});

describe('rewards schema and wiring', () => {
  it('keeps every payout append-only and one-per-placing', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE TRIGGER rakeback_claims_append_only/);
    assert.match(sql, /CREATE TRIGGER wager_race_payouts_append_only/);
    assert.match(sql, /UNIQUE \(race_id, user_id\)/);
    assert.match(sql, /UNIQUE \(race_id, rank\)/);
    // A tier can never have paid out more than it took in.
    assert.match(sql, /CHECK \(claimed_minor <= accrued_minor\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v17\(\) RETURNS boolean/);
  });

  it('allows one open creator application per account and no more', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE UNIQUE INDEX creator_applications_one_open_idx/);
    assert.match(sql, /WHERE status = 'pending'/);
    // A reviewed row records who reviewed it and when, or it is still pending.
    assert.match(sql, /CHECK \(\(status = 'pending'\) = \(reviewed_at IS NULL\)\)/);
  });

  it('accrues from the one place every game route settles a wager through', async () => {
    const source = await readFile(settlementPath, 'utf8');
    /* The trailing argument is optional and only skill duels pass it: their margin is a rake on a
     * pot rather than an edge on a wager, so deriving it would credit rakeback against revenue the
     * house never collected. The guard still pins down what matters — that recordWager accrues
     * rakeback, and that it accrues against the player's real wager. */
    assert.match(source, /await accrueRakeback\(client, config, userId, amountMinor(, marginMinor)?\)/);
    assert.match(source, /await recordRaceWager\(client, config, userId, amountMinor\)/);
  });

  it('keeps rakeback and race money on the same wallet ledger as everything else', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /'rakeback_claim', 'race_payout'/);
  });
});
