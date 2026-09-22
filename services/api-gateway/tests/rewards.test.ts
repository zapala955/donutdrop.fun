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

  /* Three of the four tiers were retired in migration 042. What this still has to hold is the
   * property the four of them shared: rakeback is drawn from the margin and has to stay well
   * inside it, whatever the programme is made of. */
  it('keeps rakeback well inside the margin it is drawn from', () => {
    const settings = config();
    const wager = 10_000_000n;
    const margin = houseMarginMinor(settings, wager);
    const total = RAKEBACK_TIERS.reduce(
      (sum, tier) => sum + rakebackMinor(settings, tier, wager),
      0n,
    );
    // 10% of the margin, where the four together used to be 20%. The house keeps the rest.
    assert.equal(total, margin / 10n);
    assert.equal(total < margin, true);
  });

  it('retires the daily, weekly and monthly clocks', () => {
    assert.deepEqual([...RAKEBACK_TIERS], ['instant']);
    assert.deepEqual(Object.keys(TIER_COOLDOWN_MS), ['instant']);
    // The one tier left is the one that never made anybody wait.
    assert.equal(TIER_COOLDOWN_MS.instant, 0);
  });

  it('truncates rather than rounding a fraction of a unit up', () => {
    const settings = config();
    // 100 at a 10% edge is a margin of 10; 10% of that is 1 unit, and anything under rounds down.
    assert.equal(rakebackMinor(settings, 'instant', 9n), 0n);
    assert.equal(rakebackMinor(settings, 'instant', 0n), 0n);
    assert.equal(rakebackMinor(settings, 'instant', -5n), 0n);
  });

  it('refuses a rate that would outpay the margin it is drawn from', () => {
    // Past the field's own ceiling, so the schema refuses it before the programme check is reached.
    assert.throws(() => loadConfig({ ...baseEnv, RAKEBACK_INSTANT_BPS: '10001' }));
  });

  /* The rates the retired tiers used to carry are no longer part of the contract. An env file
   * left over from before must be ignored rather than silently resurrecting a second rate. */
  it('ignores the retired tier rates if a deployment still sets them', () => {
    const settings = loadConfig({
      ...baseEnv,
      RAKEBACK_DAILY_BPS: '9000',
      RAKEBACK_WEEKLY_BPS: '9000',
      RAKEBACK_MONTHLY_BPS: '9000',
    });
    assert.deepEqual(settings.rakebackTierBps, { instant: 1000 });
  });
});

/**
 * Migration 042 retires three of the four tiers, and the only thing that really matters about it
 * is that it does not take anybody's money on the way past.
 *
 * `accrued_minor - claimed_minor` on a retired tier is cash a player earned and has not been paid.
 * A monthly tier holds up to thirty days of it. Deleting those rows would have been the obvious
 * way to write this migration and would have quietly confiscated every one of those balances.
 */
describe('retiring the rakeback tiers', () => {
  const migration = () =>
    readFile(
      path.resolve(import.meta.dirname, '../../../packages/db/migrations/042_instant_rakeback_only.sql'),
      'utf8',
    );

  it('moves outstanding balances into the instant tier before deleting anything', async () => {
    const sql = await migration();
    const fold = sql.indexOf('INSERT INTO rakeback_accruals');
    const remove = sql.indexOf('DELETE FROM rakeback_accruals');
    assert.ok(fold > 0, 'migration does not fold the retired balances anywhere');
    assert.ok(remove > fold, 'migration deletes the retired rows before moving what they owe');
    // Only accrued_minor moves, so `claimed_minor <= accrued_minor` still holds afterwards.
    assert.match(sql, /accrued_minor = rakeback_accruals\.accrued_minor \+ EXCLUDED\.accrued_minor/);
    assert.match(sql, /sum\(accrued_minor - claimed_minor\)/);
  });

  /* Narrowing the tier CHECK is the tidy-looking move and the wrong one: migrations complete
   * before the new container starts, so the build that still credits four tiers is serving live
   * traffic while this runs, and a CHECK it violates aborts the settlement of every round. */
  it('leaves the tier CHECK wide so the previous build cannot fail live settlements', async () => {
    const sql = await migration();
    assert.doesNotMatch(sql, /ADD CONSTRAINT rakeback_accruals_tier_check/);
    assert.doesNotMatch(sql, /ADD CONSTRAINT rakeback_claims_tier_check/);
  });

  it('never touches the append-only claim history', async () => {
    const sql = await migration();
    assert.doesNotMatch(sql, /DELETE FROM rakeback_claims/);
    assert.doesNotMatch(sql, /UPDATE rakeback_claims/);
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

  /* There is no cooldown left to expire, which is the point of keeping only this tier: a balance
   * that exists is a balance that can be taken right now, however recently the last one was. */
  it('never holds the instant tier shut, however recently it was claimed', () => {
    const justClaimed = new Date(now.getTime() - 1000);
    const views = tierViews(
      config(),
      [
        {
          tier: 'instant',
          accrued_minor: '9000',
          claimed_minor: '1000',
          last_claim_at: justClaimed,
        },
      ],
      now,
    );
    const instant = views.find((view) => view.tier === 'instant');
    assert.equal(instant?.claimableMinor, '8000');
    assert.equal(instant?.claimable, true);
    assert.equal(instant?.availableAt, null);
  });

  /* Rows on the retired tiers are folded into instant by migration 042, but a deploy leaves a few
   * seconds in which the previous build can still write one. The view must not resurrect it as a
   * tier of its own. */
  it('ignores a leftover row on a retired tier', () => {
    const views = tierViews(
      config(),
      [{ tier: 'monthly', accrued_minor: '5000', claimed_minor: '0', last_claim_at: null }],
      now,
    );
    assert.deepEqual(
      views.map((view) => view.tier),
      ['instant'],
    );
    assert.equal(views[0]?.claimableMinor, '0');
  });

  it('always returns the tier, even for a player with no rows at all', () => {
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
