import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const retentionMigrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/005_bot_telemetry_retention.sql',
);
const privilegeMigrationPath = path.resolve(
  import.meta.dirname,
  '../../../packages/db/migrations/002_security_hardening.sql',
);
const maintenancePath = path.resolve(import.meta.dirname, '../scripts/maintenance.ts');
const depositMaintenancePath = path.resolve(
  import.meta.dirname,
  '../src/lib/deposit-maintenance.ts',
);

void describe('bot telemetry retention security', () => {
  void it('exposes only a fixed-policy security-definer function to the runtime role', async () => {
    const [retentionSql, privilegeSql] = await Promise.all([
      readFile(retentionMigrationPath, 'utf8'),
      readFile(privilegeMigrationPath, 'utf8'),
    ]);

    assert.match(
      retentionSql,
      /CREATE FUNCTION donut_prune_bot_telemetry\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, public/,
    );
    assert.match(retentionSql, /REVOKE ALL ON FUNCTION donut_prune_bot_telemetry\(\) FROM PUBLIC;/);
    assert.match(
      retentionSql,
      /GRANT EXECUTE ON FUNCTION donut_prune_bot_telemetry\(\) TO donut_api_runtime;/,
    );
    assert.match(
      retentionSql,
      /REVOKE ALL ON FUNCTION guard_inbound_bot_event_retention\(\) FROM PUBLIC;/,
    );
    assert.match(
      retentionSql,
      /REVOKE ALL ON FUNCTION guard_bot_inventory_snapshot_retention\(\) FROM PUBLIC;/,
    );

    const deleteGrant = /GRANT DELETE ON([\s\S]*?)TO donut_api_runtime;/m.exec(privilegeSql)?.[1];
    assert.ok(deleteGrant, 'the runtime DELETE grant must be explicit');
    assert.match(deleteGrant, /^\s*sessions, auth_link_challenges\s+$/);
    assert.doesNotMatch(deleteGrant, /inbound_bot_events|bot_inventory_snapshots/);
  });

  void it('keeps custody and identity events permanently append-only', async () => {
    const sql = await readFile(retentionMigrationPath, 'utf8');
    const allowedTypeClauses = [
      ...sql.matchAll(/event_type IN \('heartbeat', 'inventory_snapshot'\)/g),
    ];
    const emptyClaimClauses = [
      ...sql.matchAll(
        /event_type = 'job_claim'[\s\S]{0,120}response_body = '\{"job": null\}'::jsonb/g,
      ),
    ];

    assert.equal(allowedTypeClauses.length, 2, 'guard and deletion query must share the allowlist');
    assert.equal(emptyClaimClauses.length, 2, 'only empty job-claim responses may expire');
    for (const durableEventType of [
      'link_confirmation',
      'deposit_confirmed',
      'deposit_authorization',
      'job_result',
    ]) {
      assert.doesNotMatch(
        sql,
        new RegExp(`event_type(?:\\s+IN\\s*\\([^)]*|\\s*=\\s*)[^\\n]*${durableEventType}`),
      );
    }
  });

  void it('bounds deletion and preserves the newest snapshot evidence per bot', async () => {
    const sql = await readFile(retentionMigrationPath, 'utf8');

    assert.equal((sql.match(/interval '30 days'/g) ?? []).length, 4);
    assert.equal((sql.match(/LIMIT 25000/g) ?? []).length, 2);
    assert.equal((sql.match(/SKIP LOCKED/g) ?? []).length, 2);
    assert.match(sql, /pg_try_advisory_xact_lock\(142857, 515151\)/);
    assert.match(sql, /SELECT DISTINCT ON \(snapshot\.bot_id\) snapshot\.id/);
    assert.match(sql, /SELECT DISTINCT ON \(snapshot\.bot_id\) snapshot\.event_id/);
    assert.ok(
      (sql.match(/WHERE NOT snapshot\.matched/g) ?? []).length >= 2,
      'both snapshot and event pruning must retain the latest mismatch',
    );
    assert.ok(
      (sql.match(/current_user = table_owner/g) ?? []).length >= 2,
      'retention trigger exceptions must be limited to the table owner',
    );
    assert.doesNotMatch(sql, /DISABLE TRIGGER/);
  });

  void it('runs maintenance under the checked runtime role and never directly deletes telemetry', async () => {
    const script = await readFile(maintenancePath, 'utf8');
    const roleCheck = script.indexOf('await assertRuntimeDatabaseRole(pool)');
    const maintenanceLoop = script.indexOf('do {');

    assert.ok(roleCheck >= 0 && maintenanceLoop > roleCheck);
    assert.match(script, /MAINTENANCE_INTERVAL_SECONDS must be 0 or between 60 and 86400/);
    assert.match(script, /SELECT pg_try_advisory_xact_lock\(142857, 515151\) AS acquired/);
    assert.match(script, /await maintainDepositIntents\(client\)/);
    assert.match(script, /SELECT \* FROM public\.donut_prune_bot_telemetry\(\)/);
    assert.match(script, /DELETE FROM sessions[\s\S]*interval '7 days'/);
    assert.match(script, /DELETE FROM auth_link_challenges[\s\S]*interval '1 day'/);
    assert.doesNotMatch(script, /DELETE FROM (?:public\.)?inbound_bot_events/);
    assert.doesNotMatch(script, /DELETE FROM (?:public\.)?bot_inventory_snapshots/);
  });

  void it('never silently expires a deposit after a bot handoff was authorized', async () => {
    const implementation = await readFile(depositMaintenancePath, 'utf8');
    const manualReviewUpdate = implementation.indexOf("SET status = 'manual_review'");
    const unleasedExpiryUpdate = implementation.indexOf("SET status = 'expired'");

    assert.ok(manualReviewUpdate >= 0);
    assert.ok(unleasedExpiryUpdate > manualReviewUpdate);
    assert.match(
      implementation,
      /SET status = 'manual_review'[\s\S]*?FROM deposit_authorization_leases AS lease[\s\S]*?lease\.expires_at <= now\(\) OR deposit\.expires_at <= now\(\)/,
    );
    assert.match(
      implementation,
      /SET status = 'expired'[\s\S]*?deposit\.expires_at <= now\(\)[\s\S]*?NOT EXISTS \([\s\S]*?FROM deposit_authorization_leases AS lease/,
    );
    assert.match(implementation, /depositsManualReview: depositsManualReview\.rowCount \?\? 0/);
  });

  void it('requires schema version five before the API becomes ready', async () => {
    const sql = await readFile(retentionMigrationPath, 'utf8');
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v5\(\) RETURNS boolean/);
    assert.match(sql, /REVOKE ALL ON FUNCTION donut_schema_ready_v5\(\) FROM PUBLIC;/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION donut_schema_ready_v5\(\) TO donut_api_runtime;/);
  });
});
