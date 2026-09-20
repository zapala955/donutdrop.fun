import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  accrualFactorBps,
  computeYield,
  elapsedWholeDays,
} from '../src/lib/vault-yield.js';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/011_vault_yield_and_piggy_bank.sql',
);
const routePath = path.resolve(import.meta.dirname, '../src/routes/vault.ts');

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.UTC(2026, 0, 1) + days * DAY);

describe('vault yield accrual', () => {
  it('pays for whole days only, so the number never moves on a reload', () => {
    assert.equal(elapsedWholeDays(at(0), at(0)), 0);
    assert.equal(elapsedWholeDays(at(0), new Date(at(0).getTime() + DAY - 1)), 0);
    assert.equal(elapsedWholeDays(at(0), at(1)), 1);
    assert.equal(elapsedWholeDays(at(0), new Date(at(0).getTime() + DAY * 2 - 1)), 1);
    // a clock that went backwards must never owe money
    assert.equal(elapsedWholeDays(at(5), at(0)), 0);
  });

  it('compounds daily and stops dead at the cap', () => {
    // +1% a day, compounding: day one is exactly 100bps, day two is 201bps
    assert.equal(accrualFactorBps(100, 3000, 1), 100n);
    assert.equal(accrualFactorBps(100, 3000, 2), 201n);
    assert.equal(accrualFactorBps(100, 3000, 3), 303n);

    // 30% is reached in 27 days and never exceeded, however long the lot sits
    assert.equal(accrualFactorBps(100, 3000, 27) >= 3000n, true);
    assert.equal(accrualFactorBps(100, 3000, 27), 3000n);
    assert.equal(accrualFactorBps(100, 3000, 1000), 3000n);
    assert.equal(accrualFactorBps(100, 3000, 100_000), 3000n);
  });

  it('refuses to accrue anything without a rate, a cap, or elapsed time', () => {
    assert.equal(accrualFactorBps(0, 3000, 10), 0n);
    assert.equal(accrualFactorBps(100, 0, 10), 0n);
    assert.equal(accrualFactorBps(100, 3000, 0), 0n);
    assert.equal(accrualFactorBps(100, 3000, -5), 0n);
  });

  it('credits a held lot its daily percentage of the fixed catalog price', () => {
    const result = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 1,
      anchorAt: at(0),
      now: at(10),
      claimedMinor: 0n,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    assert.equal(result.elapsedDays, 10);
    /* 1045bps, not the 1046 that 1.01^10 gives in floating point. Each day is floored into whole
     * basis points before the next compounds on it, so the integer path rounds a hair in the
     * house's favour and — more importantly — lands on the same value on every machine. */
    assert.equal(result.grossMinor, 104_500n);
    assert.equal(result.claimableMinor, 104_500n);
    assert.equal(result.capMinor, 300_000n);
    assert.equal(result.capped, false);
  });

  it('counts the whole lot, not one unit of it', () => {
    const single = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 1,
      anchorAt: at(0),
      now: at(5),
      claimedMinor: 0n,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    const stacked = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 7,
      anchorAt: at(0),
      now: at(5),
      claimedMinor: 0n,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    assert.equal(stacked.claimableMinor, single.claimableMinor * 7n);
  });

  it('never pays the same day twice across repeated claims', () => {
    const first = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 1,
      anchorAt: at(0),
      now: at(10),
      claimedMinor: 0n,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    // the anchor advances by exactly the days paid for, and the paid total carries forward
    const second = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 1,
      anchorAt: at(10),
      now: at(20),
      claimedMinor: first.claimableMinor,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    // claiming twice at day 10 must not beat holding once to day 20
    const held = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 1,
      anchorAt: at(0),
      now: at(20),
      claimedMinor: 0n,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    assert.equal(first.claimableMinor + second.claimableMinor <= held.claimableMinor, true);
  });

  it('caps lifetime earnings per lot, not per claim', () => {
    const result = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 1,
      anchorAt: at(0),
      now: at(400),
      claimedMinor: 250_000n,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    // 300_000 ceiling, 250_000 already paid: only the remaining 50_000 is owed
    assert.equal(result.capMinor, 300_000n);
    assert.equal(result.claimableMinor, 50_000n);
    assert.equal(result.capped, true);
  });

  it('never owes a negative amount when a lot shrinks below what it already earned', () => {
    // a stack that claimed near its cap and was then partly sold has a smaller cap than its
    // paid total; the answer is zero owed, never a clawback and never a negative credit
    const result = computeYield({
      baselineValueMinor: 1_000_000n,
      quantity: 1,
      anchorAt: at(0),
      now: at(400),
      claimedMinor: 900_000n,
      ratePerDayBps: 100,
      capBps: 3000,
    });
    assert.equal(result.claimableMinor, 0n);
    assert.equal(result.capped, true);
  });

});

describe('vault schema and routes', () => {
  it('accrues alongside the lot and never reprices the shared catalog item', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /ADD COLUMN yield_anchor_at timestamptz NOT NULL DEFAULT now\(\)/);
    assert.match(sql, /ADD COLUMN yield_claimed_minor bigint NOT NULL DEFAULT 0/);
    // the whole point: no migration may touch the fixed, shared item price
    assert.doesNotMatch(sql, /UPDATE catalog_items/);
    assert.doesNotMatch(sql, /ALTER TABLE catalog_items/);
  });

  it('keeps every payout on an append-only ledger', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE TABLE vault_yield_claims/);
    assert.match(sql, /CREATE TRIGGER vault_yield_claims_append_only/);
    /* The piggy bank is gone, but these ledger kinds are not, and must not be: the rows they
       name are still in an append-only table. Migration 032 explains why narrowing this CHECK
       would fail on exactly the databases that have any. */
    assert.match(
      sql,
      /'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break'/,
    );
  });

  it('pins the readiness probe to the schema the running API expects', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const health = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/health.ts'),
      'utf8',
    );
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v11\(\) RETURNS boolean/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION donut_schema_ready_v11\(\) TO donut_api_runtime;/);
    // 011 declares v11; the running API has since moved on to a later schema version, which is
    // asserted by the migration that introduced it rather than here.
    assert.match(health, /donut_schema_ready_v\d+\(\)/);
  });

  it('refuses a daily rate that has no ceiling', async () => {
    const config = await readFile(
      path.resolve(import.meta.dirname, '../src/config.ts'),
      'utf8',
    );
    assert.match(config, /VAULT_YIELD_BPS_PER_DAY/);
    assert.match(config, /VAULT_YIELD_CAP_BPS/);
    assert.match(config, /must be set when a daily vault yield is enabled/);
  });
});

describe('unlimited house stock', () => {
  it('cannot be enabled alongside physical custody', async () => {
    const config = await readFile(
      path.resolve(import.meta.dirname, '../src/config.ts'),
      'utf8',
    );
    assert.match(config, /HOUSE_STOCK_UNLIMITED: booleanString/);
    assert.match(config, /env\.HOUSE_STOCK_UNLIMITED && env\.PHYSICAL_CUSTODY_ENABLED/);
    assert.match(config, /minting unbacked items would break bot reconciliation/);
  });

  it('mints the award instead of drawing down a house lot', async () => {
    const upgrades = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/upgrades.ts'),
      'utf8',
    );
    const cases = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/cases.ts'),
      'utf8',
    );
    // the consume/decrement is skipped, never the award itself
    assert.match(upgrades, /if \(!config\.houseStockUnlimited\) \{\s*\n\s*if \(quantity === source\.quantity\)/);
    assert.match(cases, /if \(!config\.houseStockUnlimited\) \{\s*\n\s*if \(quantity === source\.quantity\)/);
    // an award still needs a live custody bot to hang off, unlimited or not
    assert.match(upgrades, /No custody bot is available/);
    assert.match(cases, /No custody bot is available/);
  });

  it('reports availability so the client stops hiding sellable targets', async () => {
    const catalog = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/catalog.ts'),
      'utf8',
    );
    assert.match(catalog, /CASE WHEN \$7::boolean THEN 1000000000::bigint/);
    assert.match(catalog, /config\.houseStockUnlimited/);
  });
});

describe('the piggy bank is gone', () => {
  it('leaves no route, no config and no client module behind', async () => {
    const route = await readFile(routePath, 'utf8');
    const config = await readFile(path.resolve(import.meta.dirname, '../src/config.ts'), 'utf8');
    assert.doesNotMatch(route, /piggy/i);
    assert.doesNotMatch(config, /PIGGY_BANK/);
    await assert.rejects(
      readFile(
        path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop/assets/js/piggy.js'),
        'utf8',
      ),
      /ENOENT/,
    );
  });

  it('refuses to drop the tables while a deposit still holds money', async () => {
    /* The routes that could pay an open deposit are already deleted, so a migration that dropped
     * the table quietly would destroy the only remaining record of a debt. It raises instead: a
     * failed migration stops the deploy, which is loud and recoverable. */
    const sql = await readFile(
      path.resolve(import.meta.dirname, '../../../packages/db/migrations/032_remove_piggy_bank.sql'),
      'utf8',
    );
    assert.match(sql, /WHERE claimed_at IS NULL AND broken_at IS NULL/);
    assert.match(sql, /RAISE EXCEPTION/);
    assert.match(sql, /DROP TABLE piggy_bank_events;/);
    assert.match(sql, /DROP TABLE piggy_bank_deposits;/);
    /* Events reference deposits, so the order is not cosmetic. */
    assert.ok(
      sql.indexOf('DROP TABLE piggy_bank_events;') < sql.indexOf('DROP TABLE piggy_bank_deposits;'),
    );
  });

  it('leaves the ledger kinds and the quest metric alone', async () => {
    /* Narrowing either CHECK would be validated against rows that already exist, which is how
     * migration 030 took production down. */
    const sql = await readFile(
      path.resolve(import.meta.dirname, '../../../packages/db/migrations/032_remove_piggy_bank.sql'),
      'utf8',
    );
    assert.doesNotMatch(sql, /wallet_transactions_kind_check/);
    assert.doesNotMatch(sql, /DROP CONSTRAINT/);
    // an uncompletable quest is switched off rather than left for a player to watch forever
    assert.match(sql, /UPDATE quest_definitions SET enabled = false WHERE metric = 'piggy_deposits'/);
  });

  it('pins readiness to the schema without the tables', async () => {
    const sql = await readFile(
      path.resolve(import.meta.dirname, '../../../packages/db/migrations/032_remove_piggy_bank.sql'),
      'utf8',
    );
    const health = await readFile(path.resolve(import.meta.dirname, '../src/routes/health.ts'), 'utf8');
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v32\(\) RETURNS boolean/);
    /* 032 declares v32; the running API has since moved on to a later marker, which is asserted by
       the migration that introduced it rather than pinned here. Naming a version in this test made
       every future migration fail a piggy-bank assertion, which tells nobody anything. */
    assert.match(health, /donut_schema_ready_v\d+\(\)/);
  });
});
