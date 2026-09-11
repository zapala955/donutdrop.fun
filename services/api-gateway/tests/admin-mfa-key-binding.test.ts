import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/006_admin_mfa_key_binding.sql',
);

void describe('administrator MFA key binding migration', () => {
  void it('binds sessions to a validated key fingerprint and revokes legacy admin sessions', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    assert.match(sql, /ALTER TABLE sessions ADD COLUMN admin_mfa_key_fingerprint char\(64\)/);
    assert.match(sql, /admin_mfa_key_fingerprint ~ '\^\[a-f0-9\]\{64\}\$'/);
    assert.match(
      sql,
      /revoked_at IS NOT NULL[\s\S]*\(admin_mfa_verified_at IS NULL\) = \(admin_mfa_key_fingerprint IS NULL\)/,
    );
    assert.match(
      sql,
      /UPDATE sessions[\s\S]*SET revoked_at = COALESCE\(revoked_at, now\(\)\)[\s\S]*WHERE user_id IN \(SELECT id FROM users WHERE role = 'admin'\)/,
    );
    assert.ok(
      sql.indexOf('UPDATE sessions') <
        sql.indexOf('ADD CONSTRAINT sessions_active_admin_mfa_key_binding'),
      'legacy administrator sessions must be revoked before validating active key binding',
    );
  });

  void it('exposes the v6 readiness marker only to the runtime role', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v6\(\) RETURNS boolean/);
    assert.match(sql, /REVOKE ALL ON FUNCTION donut_schema_ready_v6\(\) FROM PUBLIC;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION donut_schema_ready_v6\(\) TO donut_api_runtime;/);
  });
});
