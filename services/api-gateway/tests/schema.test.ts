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

  it('has no currency wallet or client-priced stake table', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    assert.doesNotMatch(sql, /CREATE TABLE (wallet|balances|payments)/i);
    assert.match(sql, /unit_value_minor bigint NOT NULL CHECK \(unit_value_minor > 0\)/);
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
