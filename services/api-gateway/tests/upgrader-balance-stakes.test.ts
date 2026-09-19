import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/010_upgrader_balance_stakes.sql',
);
const routePath = path.resolve(import.meta.dirname, '../src/routes/upgrades.ts');
const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');

describe('upgrader cash stakes', () => {
  it('records where a round got its value and can never describe both', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    assert.match(sql, /ADD COLUMN stake_kind varchar\(8\) NOT NULL DEFAULT 'item'/);
    assert.match(sql, /ADD COLUMN stake_balance_minor bigint NOT NULL DEFAULT 0/);
    assert.match(sql, /ADD COLUMN balance_after_minor bigint/);
    assert.match(sql, /CHECK \(stake_kind IN \('item', 'balance'\)\)/);

    // The two shapes are mutually exclusive: an item round carries no cash figures, and a cash
    // round's wagered value is exactly the debit, so the round can never disagree with itself.
    assert.match(sql, /upgrader_rounds_stake_shape_check/);
    assert.match(
      sql,
      /stake_kind = 'item'\s+AND stake_balance_minor = 0\s+AND balance_after_minor IS NULL/,
    );
    assert.match(
      sql,
      /stake_kind = 'balance'\s+AND stake_balance_minor = stake_value_minor\s+AND balance_after_minor IS NOT NULL/,
    );
  });

  it('keeps the cash debit in the same append-only wallet ledger as a case open', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(
      sql,
      /CHECK \(kind IN \('case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake'\)\)/,
    );
  });

  it('declares its own readiness version with the runtime grant locked down', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v10\(\) RETURNS boolean/);
    assert.match(sql, /REVOKE ALL ON FUNCTION donut_schema_ready_v10\(\) FROM PUBLIC;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION donut_schema_ready_v10\(\) TO donut_api_runtime;/);
  });

  it('accepts exactly one source of value per round', async () => {
    const route = await readFile(routePath, 'utf8');

    // Both would be two debits racing one chance figure; neither would be a free roll.
    assert.match(route, /\(body\.stakes === undefined\) !== \(body\.balanceStake === undefined\)/);
    assert.match(
      route,
      /stakes: z\.array\(inventorySelectionSchema\)\.min\(1\)\.max\(20\)\.optional\(\)/,
    );
    assert.match(route, /balanceStake: balanceSelectionSchema\.optional\(\)/);
  });

  it('checks the wallet under lock, debits last, and writes the ledger row', async () => {
    const route = await readFile(routePath, 'utf8');

    assert.match(route, /SELECT balance_minor FROM user_wallets WHERE user_id = \$1 FOR UPDATE/);
    assert.match(route, /INSUFFICIENT_BALANCE/);
    assert.match(route, /SET balance_minor = balance_minor - \$2, updated_at = now\(\)/);
    assert.match(route, /VALUES \(\$1, \$2, \$3, \$4, 'upgrade_stake', \$5\)/);

    /* The multiplier window is measured against the same single figure — stakeValue — that a cash
     * round and an item round both resolve to, so a cash round cannot slip past a bound an item
     * round is held to.
     *
     * The daily wager limit used to be asserted here beside it. That cap has been removed, both
     * the platform-wide ceiling and the per-player self-set limit, so there is no longer a
     * turnover bound to check. The multiplier window is now the only bound on stakeValue, which
     * makes asserting it here more important rather than less. */
    assert.match(
      route,
      /targetValue \* 10_000n < stakeValue \* BigInt\(config\.minMultiplierBps\)/,
    );
    assert.match(
      route,
      /targetValue \* 10_000n > stakeValue \* BigInt\(config\.maxMultiplierBps\)/,
    );
  });

  it('tells the client the cash route exists before it offers it', async () => {
    const route = await readFile(routePath, 'utf8');
    assert.match(route, /balanceStakesEnabled: true/);
  });

  it('sends a cash stake as minor units and re-reads the balance afterwards', async () => {
    const store = await readFile(path.join(frontend, 'assets/js/store.js'), 'utf8');

    assert.match(store, /export async function runBalanceUpgrade/);
    assert.match(store, /balanceStake: \{ balanceMinor: String\(stakeMinor\) \}/);
    assert.match(store, /refreshBalance\(false\)/);
  });

  it('prices both stake modes from one figure in the browser', async () => {
    const upgrader = await readFile(path.join(frontend, 'assets/js/upgrader.js'), 'utf8');

    assert.match(upgrader, /function stakeMinor\(\)/);
    /* Not pinned to the full argument list. This test is about the figure the stake is priced
       from, and pinning the call broke it when the settlement gained a defer option that has
       nothing to do with pricing. */
    assert.match(upgrader, /await runBalanceUpgrade\(\s*wagered\.toString\(\), destination/);
    // The quote and the eligible-target window must both read stakeMinor(), never a mode-specific
    // value, or the two modes can be priced differently from the server.
    assert.match(upgrader, /const raw = \(stakeMinor\(\) \* edge \* 1_000_000n\)/);
    assert.match(upgrader, /const source = stakeMinor\(\);/);
  });
});
