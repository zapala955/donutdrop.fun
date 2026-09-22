import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/001_initial.sql',
);
const depositLeaseMigrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/007_deposit_authorization_leases.sql',
);
const economyMigrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/008_cases_wallets_and_sales.sql',
);

/**
 * A narrowed CHECK has to be reconciled with every writer, and a column DEFAULT is a writer.
 *
 * Migration 036 narrowed `users.status` and updated the existing rows, but left the default from
 * migration 001 naming a status it had just removed. Nothing selected it and no row contained it,
 * so nothing failed until the next person signed up -- and they had already paid the login nonce
 * by the time the insert hit the constraint. This is the second time a narrowed CHECK has taken
 * production down here; it is cheap to assert and expensive to rediscover.
 */
describe('narrowed CHECKs and the defaults that feed them', () => {
  const statusValues = ['active', 'suspended', 'closed'];

  it('leaves users.status with a default its own CHECK admits', async () => {
    const [initial, compliance, repair] = await Promise.all([
      readFile(migrationPath, 'utf8'),
      readFile(
        path.resolve(
          import.meta.dirname,
          '../../../packages/db/migrations/036_remove_compliance_apparatus.sql',
        ),
        'utf8',
      ),
      readFile(
        path.resolve(
          import.meta.dirname,
          '../../../packages/db/migrations/043_fix_new_user_default_status.sql',
        ),
        'utf8',
      ),
    ]);

    // The shape of the original mistake, kept so the assertion below has something to bite on.
    assert.match(initial, /status varchar\(24\) NOT NULL DEFAULT 'pending_compliance'/);
    assert.match(compliance, /CHECK \(status IN \('active', 'suspended', 'closed'\)\)/);

    // The repair, and the only thing that actually matters: the default is now an allowed value.
    const setDefault = /ALTER TABLE users ALTER COLUMN status SET DEFAULT '([a-z_]+)'/.exec(repair);
    assert.ok(setDefault, 'migration 043 does not reset the users.status default');
    assert.ok(
      statusValues.includes(setDefault[1]!),
      `users.status defaults to ${setDefault[1]}, which its CHECK does not allow`,
    );
  });

  /* Belt to the migration's braces. Even with the default repaired, the one insert that creates a
   * player should not be depending on a column default to produce a legal row. */
  it('names status explicitly when creating a player, rather than trusting the default', async () => {
    const route = await readFile(
      path.resolve(import.meta.dirname, '../src/routes/auth.ts'),
      'utf8',
    );
    const insert = route.slice(route.indexOf('INSERT INTO users'));
    const columns = insert.slice(0, insert.indexOf('VALUES'));
    assert.match(columns, /status/, 'the signup insert still relies on the users.status default');
    assert.match(insert, /'active'/);
  });
});

describe('database safety invariants', () => {
  it('keeps critical records append-only and idempotent', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.match(sql, /CREATE TRIGGER upgrader_rounds_append_only/);
    assert.match(sql, /CREATE TRIGGER custody_movements_append_only/);
    assert.match(sql, /CREATE TRIGGER audit_log_append_only/);
    assert.match(sql, /UNIQUE \(user_id, idempotency_key\)/);
    assert.match(sql, /fairness_one_active_per_user_idx/);
    assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  });

  it('keeps item values server-priced and wallet changes ledger-backed', async () => {
    const initialSql = await readFile(migrationPath, 'utf8');
    const economySql = await readFile(economyMigrationPath, 'utf8');
    assert.match(initialSql, /unit_value_minor bigint NOT NULL CHECK \(unit_value_minor > 0\)/);
    assert.match(economySql, /CREATE TABLE user_wallets/);
    assert.match(economySql, /balance_minor bigint NOT NULL DEFAULT 0 CHECK \(balance_minor >= 0\)/);
    assert.match(economySql, /CREATE TABLE wallet_transactions/);
    assert.match(economySql, /CREATE TRIGGER wallet_transactions_append_only/);
    assert.match(economySql, /CREATE TRIGGER case_rounds_append_only/);
    assert.match(economySql, /CREATE TRIGGER inventory_sales_append_only/);
    assert.match(economySql, /UNIQUE \(user_id, idempotency_key\)/);
    assert.match(economySql, /CREATE FUNCTION donut_schema_ready_v8\(\) RETURNS boolean/);
  });

  it('makes deposit authorization a short-lived append-only capability', async () => {
    const sql = await readFile(depositLeaseMigrationPath, 'utf8');

    assert.match(sql, /CREATE TABLE deposit_authorization_leases/);
    assert.match(
      sql,
      /authorization_event_id uuid PRIMARY KEY\s+REFERENCES inbound_bot_events\(event_id\) DEFERRABLE INITIALLY DEFERRED/,
    );
    assert.match(sql, /deposit_id uuid NOT NULL UNIQUE REFERENCES deposit_intents\(id\)/);
    assert.match(sql, /bot_id uuid NOT NULL REFERENCES bot_accounts\(id\)/);
    assert.match(sql, /octet_length\(token_hash\) = 32/);
    assert.match(sql, /CHECK \(expires_at > issued_at\)/);
    assert.match(sql, /CHECK \(expires_at <= issued_at \+ interval '150 seconds'\)/);
    assert.match(sql, /CREATE TRIGGER deposit_authorization_leases_append_only/);
    assert.match(
      sql,
      /GRANT SELECT, INSERT ON TABLE deposit_authorization_leases TO donut_api_runtime;/,
    );
    assert.doesNotMatch(
      sql,
      /GRANT (?:UPDATE|DELETE|ALL)[^;]*deposit_authorization_leases[^;]*TO donut_api_runtime;/,
    );
    assert.doesNotMatch(sql, /\blease_token\b/i);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v7\(\) RETURNS boolean/);
    assert.match(sql, /REVOKE ALL ON FUNCTION donut_schema_ready_v7\(\) FROM PUBLIC;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION donut_schema_ready_v7\(\) TO donut_api_runtime;/);
  });
});
