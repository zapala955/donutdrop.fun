import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { describe, it } from 'node:test';
import { assertAuditDatabaseRole, assertRuntimeDatabaseRole } from '../src/lib/database-role.js';
import { maintainDepositIntents } from '../src/lib/deposit-maintenance.js';

const databaseUrl = process.env['TEST_DATABASE_URL'];

async function verifyTelemetryRetention(runtime: pg.Pool): Promise<void> {
  const client = await runtime.connect();
  const botId = '70000000-0000-4000-8000-000000000001';
  const deletedEventIds = new Set([
    '70000000-0000-4000-8000-000000000101',
    '70000000-0000-4000-8000-000000000105',
    '70000000-0000-4000-8000-000000000107',
  ]);
  const retainedEventIds = new Set([
    '70000000-0000-4000-8000-000000000102',
    '70000000-0000-4000-8000-000000000103',
    '70000000-0000-4000-8000-000000000104',
    '70000000-0000-4000-8000-000000000106',
    '70000000-0000-4000-8000-000000000108',
    '70000000-0000-4000-8000-000000000109',
  ]);

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO bot_accounts(id, username, server_host)
       VALUES ($1, 'RetentionBot', 'donutsmp.invalid')`,
      [botId],
    );
    await client.query(
      `INSERT INTO inbound_bot_events
         (event_id, bot_id, event_type, body_hash, response_body, processed_at)
       VALUES
         ('70000000-0000-4000-8000-000000000101', $1, 'heartbeat', repeat('a', 64), NULL,
          now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000102', $1, 'link_confirmation', repeat('b', 64), NULL,
          now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000103', $1, 'deposit_confirmed', repeat('c', 64), NULL,
          now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000104', $1, 'job_result', repeat('d', 64), NULL,
          now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000105', $1, 'job_claim', repeat('e', 64),
          '{"job": null}'::jsonb, now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000106', $1, 'job_claim', repeat('f', 64),
          '{"job": {"id": "70000000-0000-4000-8000-000000000301"}}'::jsonb,
          now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000107', $1, 'inventory_snapshot', repeat('1', 64), NULL,
          now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000108', $1, 'inventory_snapshot', repeat('2', 64), NULL,
          now() - interval '45 days'),
         ('70000000-0000-4000-8000-000000000109', $1, 'inventory_snapshot', repeat('3', 64), NULL,
          now() - interval '40 days')`,
      [botId],
    );
    await client.query(
      `INSERT INTO bot_inventory_snapshots(id, bot_id, event_id, totals, matched, created_at)
       VALUES
         ('70000000-0000-4000-8000-000000000201', $1,
          '70000000-0000-4000-8000-000000000107', '{}', true, now() - interval '50 days'),
         ('70000000-0000-4000-8000-000000000202', $1,
          '70000000-0000-4000-8000-000000000108', '{}', false, now() - interval '45 days'),
         ('70000000-0000-4000-8000-000000000203', $1,
          '70000000-0000-4000-8000-000000000109', '{}', true, now() - interval '40 days')`,
      [botId],
    );

    const pruned = await client.query<{
      inbound_events_deleted: string;
      inventory_snapshots_deleted: string;
    }>('SELECT * FROM public.donut_prune_bot_telemetry()');
    assert.deepEqual(pruned.rows[0], {
      inbound_events_deleted: '3',
      inventory_snapshots_deleted: '1',
    });

    const remainingEvents = await client.query<{ event_id: string }>(
      'SELECT event_id FROM inbound_bot_events WHERE bot_id = $1',
      [botId],
    );
    const remainingEventIds = new Set(remainingEvents.rows.map((row) => row.event_id));
    for (const eventId of deletedEventIds) assert.equal(remainingEventIds.has(eventId), false);
    for (const eventId of retainedEventIds) assert.equal(remainingEventIds.has(eventId), true);

    const remainingSnapshots = await client.query<{ id: string }>(
      'SELECT id FROM bot_inventory_snapshots WHERE bot_id = $1 ORDER BY id',
      [botId],
    );
    assert.deepEqual(
      remainingSnapshots.rows.map((row) => row.id),
      ['70000000-0000-4000-8000-000000000202', '70000000-0000-4000-8000-000000000203'],
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function verifyDepositAuthorizationLeases(runtime: pg.Pool): Promise<void> {
  const client = await runtime.connect();
  const botId = '71000000-0000-4000-8000-000000000001';
  const userId = '71000000-0000-4000-8000-000000000010';
  const firstDepositId = '71000000-0000-4000-8000-000000000021';
  const secondDepositId = '71000000-0000-4000-8000-000000000022';
  const thirdDepositId = '71000000-0000-4000-8000-000000000023';
  const firstEventId = '71000000-0000-4000-8000-000000000101';
  const duplicateEventId = '71000000-0000-4000-8000-000000000102';
  const deferredEventId = '71000000-0000-4000-8000-000000000103';
  const invalidHashEventId = '71000000-0000-4000-8000-000000000104';

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO bot_accounts(id, username, server_host)
       VALUES ($1, 'LeaseBot', 'donutsmp.invalid')`,
      [botId],
    );
    await client.query(
      `INSERT INTO users(id, minecraft_identity, minecraft_username, normalized_username)
       VALUES ($1, 'lease-test-identity', 'LeasePlayer', 'leaseplayer')`,
      [userId],
    );
    await client.query(
      `INSERT INTO deposit_intents
         (id, user_id, bot_id, deposit_code, idempotency_key, request_hash, expires_at)
       VALUES
         ($1, $4, $5, 'LEASE-CODE-1', 'lease-idempotency-1', repeat('a', 64),
          now() + interval '1 hour'),
         ($2, $4, $5, 'LEASE-CODE-2', 'lease-idempotency-2', repeat('b', 64),
          now() + interval '1 hour'),
         ($3, $4, $5, 'LEASE-CODE-3', 'lease-idempotency-3', repeat('c', 64),
          now() + interval '1 hour')`,
      [firstDepositId, secondDepositId, thirdDepositId, userId, botId],
    );
    await client.query(
      `INSERT INTO inbound_bot_events(event_id, bot_id, event_type, body_hash)
       VALUES
         ($1, $3, 'deposit_authorization', repeat('d', 64)),
         ($2, $3, 'deposit_authorization', repeat('e', 64))`,
      [firstEventId, duplicateEventId, botId],
    );
    await client.query(
      `INSERT INTO deposit_authorization_leases
         (authorization_event_id, deposit_id, bot_id, token_hash, issued_at, expires_at)
       VALUES ($1, $2, $3, decode(repeat('ab', 32), 'hex'), now(),
               now() + interval '120 seconds')`,
      [firstEventId, firstDepositId, botId],
    );

    await client.query('SAVEPOINT duplicate_deposit_lease');
    await assert.rejects(
      client.query(
        `INSERT INTO deposit_authorization_leases
           (authorization_event_id, deposit_id, bot_id, token_hash, issued_at, expires_at)
         VALUES ($1, $2, $3, decode(repeat('cd', 32), 'hex'), now(),
                 now() + interval '120 seconds')`,
        [duplicateEventId, firstDepositId, botId],
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await client.query('ROLLBACK TO SAVEPOINT duplicate_deposit_lease');

    // The event journal write may occur after the lease insert in the same
    // transaction. The deferred foreign key makes that ordering atomic.
    await client.query(
      `INSERT INTO deposit_authorization_leases
         (authorization_event_id, deposit_id, bot_id, token_hash, issued_at, expires_at)
       VALUES ($1, $2, $3, decode(repeat('ef', 32), 'hex'), now(),
               now() + interval '120 seconds')`,
      [deferredEventId, secondDepositId, botId],
    );
    await client.query(
      `INSERT INTO inbound_bot_events(event_id, bot_id, event_type, body_hash)
       VALUES ($1, $2, 'deposit_authorization', repeat('f', 64))`,
      [deferredEventId, botId],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    await client.query(
      `INSERT INTO inbound_bot_events(event_id, bot_id, event_type, body_hash)
       VALUES ($1, $2, 'deposit_authorization', repeat('1', 64))`,
      [invalidHashEventId, botId],
    );
    await client.query('SAVEPOINT invalid_lease_hash');
    await assert.rejects(
      client.query(
        `INSERT INTO deposit_authorization_leases
           (authorization_event_id, deposit_id, bot_id, token_hash, issued_at, expires_at)
         VALUES ($1, $2, $3, decode(repeat('12', 31), 'hex'), now(),
                 now() + interval '120 seconds')`,
        [invalidHashEventId, thirdDepositId, botId],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    );
    await client.query('ROLLBACK TO SAVEPOINT invalid_lease_hash');

    const stored = await client.query<{
      authorization_event_id: string;
      hash_bytes: number;
    }>(
      `SELECT authorization_event_id, octet_length(token_hash)::integer AS hash_bytes
         FROM deposit_authorization_leases
        ORDER BY authorization_event_id`,
    );
    assert.deepEqual(stored.rows, [
      { authorization_event_id: firstEventId, hash_bytes: 32 },
      { authorization_event_id: deferredEventId, hash_bytes: 32 },
    ]);

    const privileges = await client.query<{ privilege_type: string }>(
      `SELECT DISTINCT privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name = 'deposit_authorization_leases'
        ORDER BY privilege_type`,
    );
    assert.deepEqual(
      privileges.rows.map((row) => row.privilege_type),
      ['INSERT', 'SELECT'],
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function verifyDepositMaintenance(runtime: pg.Pool): Promise<void> {
  const client = await runtime.connect();
  const botId = '72000000-0000-4000-8000-000000000001';
  const userId = '72000000-0000-4000-8000-000000000010';
  const depositIds = {
    expiredUnleased: '72000000-0000-4000-8000-000000000021',
    expiredLease: '72000000-0000-4000-8000-000000000022',
    expiredIntent: '72000000-0000-4000-8000-000000000023',
    activeLeased: '72000000-0000-4000-8000-000000000024',
    activeUnleased: '72000000-0000-4000-8000-000000000025',
  } as const;
  const eventIds = {
    expiredLease: '72000000-0000-4000-8000-000000000101',
    expiredIntent: '72000000-0000-4000-8000-000000000102',
    activeLeased: '72000000-0000-4000-8000-000000000103',
  } as const;

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO bot_accounts(id, username, server_host)
       VALUES ($1, 'MaintenanceBot', 'donutsmp.invalid')`,
      [botId],
    );
    await client.query(
      `INSERT INTO users(id, minecraft_identity, minecraft_username, normalized_username)
       VALUES ($1, 'maintenance-test-identity', 'MaintPlayer', 'maintplayer')`,
      [userId],
    );
    await client.query(
      `INSERT INTO deposit_intents
         (id, user_id, bot_id, deposit_code, idempotency_key, request_hash, expires_at)
       VALUES
         ($1, $6, $7, 'MAINT-CODE-1', 'maintenance-idempotency-1', repeat('1', 64),
          now() - interval '5 minutes'),
         ($2, $6, $7, 'MAINT-CODE-2', 'maintenance-idempotency-2', repeat('2', 64),
          now() + interval '1 hour'),
         ($3, $6, $7, 'MAINT-CODE-3', 'maintenance-idempotency-3', repeat('3', 64),
          now() - interval '5 seconds'),
         ($4, $6, $7, 'MAINT-CODE-4', 'maintenance-idempotency-4', repeat('4', 64),
          now() + interval '1 hour'),
         ($5, $6, $7, 'MAINT-CODE-5', 'maintenance-idempotency-5', repeat('5', 64),
          now() + interval '1 hour')`,
      [
        depositIds.expiredUnleased,
        depositIds.expiredLease,
        depositIds.expiredIntent,
        depositIds.activeLeased,
        depositIds.activeUnleased,
        userId,
        botId,
      ],
    );
    await client.query(
      `INSERT INTO inbound_bot_events(event_id, bot_id, event_type, body_hash)
       VALUES
         ($1, $4, 'deposit_authorization', repeat('6', 64)),
         ($2, $4, 'deposit_authorization', repeat('7', 64)),
         ($3, $4, 'deposit_authorization', repeat('8', 64))`,
      [eventIds.expiredLease, eventIds.expiredIntent, eventIds.activeLeased, botId],
    );
    await client.query(
      `INSERT INTO deposit_authorization_leases
         (authorization_event_id, deposit_id, bot_id, token_hash, issued_at, expires_at)
       VALUES
         ($1, $4, $7, decode(repeat('21', 32), 'hex'),
          now() - interval '120 seconds', now() - interval '1 second'),
         ($2, $5, $7, decode(repeat('22', 32), 'hex'),
          now() - interval '60 seconds', now() + interval '60 seconds'),
         ($3, $6, $7, decode(repeat('23', 32), 'hex'),
          now(), now() + interval '120 seconds')`,
      [
        eventIds.expiredLease,
        eventIds.expiredIntent,
        eventIds.activeLeased,
        depositIds.expiredLease,
        depositIds.expiredIntent,
        depositIds.activeLeased,
        botId,
      ],
    );

    assert.deepEqual(await maintainDepositIntents(client), {
      expiredDeposits: 1,
      depositsManualReview: 2,
    });

    const statuses = await client.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM deposit_intents
        WHERE user_id = $1
        ORDER BY id`,
      [userId],
    );
    assert.deepEqual(statuses.rows, [
      { id: depositIds.expiredUnleased, status: 'expired' },
      { id: depositIds.expiredLease, status: 'manual_review' },
      { id: depositIds.expiredIntent, status: 'manual_review' },
      { id: depositIds.activeLeased, status: 'pending' },
      { id: depositIds.activeUnleased, status: 'pending' },
    ]);
    assert.deepEqual(await maintainDepositIntents(client), {
      expiredDeposits: 0,
      depositsManualReview: 0,
    });
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

void describe('PostgreSQL migration and runtime isolation', { skip: !databaseUrl }, () => {
  void it('applies every migration and confines the API login', async () => {
    if (!databaseUrl) return;
    const parsed = new URL(databaseUrl);
    if (!/(?:test|ci)/i.test(parsed.pathname)) {
      throw new Error('TEST_DATABASE_URL must name a dedicated test or CI database');
    }

    const owner = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const testPassword = 'ci-only-runtime-password-4c31a76f';
    try {
      /* Read from disk, not from a list kept by hand.
       *
       * This assertion used to name every migration file as a literal array. It stopped at 027
       * while the directory went on to 031, so it had been failing since 028 was written — which
       * nobody discovered, because the CI account was locked and the job never started. A test
       * that must be edited alongside every migration is a test that silently rots the moment
       * anything stops watching it.
       *
       * Comparing the directory against `schema_migration_checksums` keeps the guarantee the test
       * name actually claims — every migration on disk has been applied, in order, and nothing was
       * applied that is not on disk — and it cannot go stale. */
      const migrationsDirectory = path.resolve(import.meta.dirname, '../../../packages/db/migrations');
      const onDisk = (await readdir(migrationsDirectory))
        .filter((name) => name.endsWith('.sql'))
        .sort();
      assert.ok(onDisk.length > 0, 'there must be migrations to apply');

      const migrations = await owner.query<{ version: string }>(
        'SELECT version FROM schema_migration_checksums ORDER BY version',
      );
      assert.deepEqual(
        migrations.rows.map((row) => row.version),
        onDisk,
      );

      const columns = await owner.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (table_name, column_name) IN (
             ('upgrader_rounds', 'request_hash'),
             ('withdrawals', 'request_hash'),
             ('admin_commands', 'request_hash'),
             ('bot_accounts', 'transfer_capable'),
             ('inbound_bot_events', 'response_body'),
             ('auth_link_challenges', 'bot_id'),
             ('audit_log', 'key_id'),
             ('audit_log', 'sequence_no'),
             ('sessions', 'admin_mfa_key_fingerprint'),
             ('deposit_authorization_leases', 'authorization_event_id'),
             ('deposit_authorization_leases', 'token_hash'),
             ('user_wallets', 'balance_minor'),
             ('case_rounds', 'pool_snapshot'),
             ('case_rounds', 'awarded_weight'),
             ('inventory_sales', 'proceeds_minor'),
             ('runtime_settings', 'value')
           )`,
      );
      assert.equal(columns.rowCount, 16);

      const removedComplianceColumns = await owner.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name IN ('kyc_status', 'country_code', 'age_verified_at',
                                'cooldown_until', 'self_excluded_until')`,
      );
      assert.equal(removedComplianceColumns.rowCount, 0);

      const ownership = await owner.query<{ tableowner: string }>(
        `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'`,
      );
      assert.ok(ownership.rows.every((row) => row.tableowner !== 'donut_api_runtime'));

      await owner.query(`
        DO $block$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_ci_runtime_login') THEN
            CREATE ROLE donut_ci_runtime_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
              PASSWORD 'ci-only-runtime-password-4c31a76f';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_ci_audit_login') THEN
            CREATE ROLE donut_ci_audit_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
              PASSWORD 'ci-only-audit-password-53ae91b8';
          END IF;
        END
        $block$;
        GRANT donut_api_runtime TO donut_ci_runtime_login;
        GRANT donut_audit_reader TO donut_ci_audit_login;
        ALTER ROLE donut_ci_audit_login SET default_transaction_read_only = on;
      `);

      const runtimeUrl = new URL(databaseUrl);
      runtimeUrl.username = 'donut_ci_runtime_login';
      runtimeUrl.password = testPassword;
      const runtime = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 1 });
      try {
        await assertRuntimeDatabaseRole(runtime);
        await assert.doesNotReject(runtime.query('SELECT count(*) FROM audit_log'));
        const readiness = await runtime.query<{ ready: boolean }>(
          'SELECT public.donut_schema_ready_v42() AS ready',
        );
        assert.equal(readiness.rows[0]?.ready, true);
        // Parse and execute the two operational queries that previously survived unit tests while
        // selecting columns migration 036 had removed. LIMIT 0/WHERE false still makes PostgreSQL
        // resolve every relation and column without needing fixture rows.
        await assert.doesNotReject(
          runtime.query(
            `SELECT u.id, u.minecraft_username, u.role, u.status,
                    u.created_at, u.last_login_at,
                    COALESCE(w.balance_minor, 0)::text AS balance_minor
               FROM users u LEFT JOIN user_wallets w ON w.user_id = u.id
              WHERE false LIMIT 0`,
          ),
        );
        await assert.doesNotReject(
          runtime.query(
            `SELECT d.id, d.user_id, d.bot_id, d.status AS deposit_status, d.expires_at,
                    u.normalized_username, u.minecraft_identity, u.status, u.terms_accepted_at,
                    b.status AS bot_status, b.reconciliation_status, b.transfer_capable,
                    b.last_heartbeat_at, b.last_snapshot_at,
                    lease.authorization_event_id AS lease_id, lease.bot_id AS lease_bot_id,
                    lease.token_hash AS lease_token_hash, lease.expires_at AS lease_expires_at
               FROM deposit_intents d
               JOIN users u ON u.id = d.user_id
               JOIN bot_accounts b ON b.id = d.bot_id
               LEFT JOIN deposit_authorization_leases lease ON lease.deposit_id = d.id
              WHERE false LIMIT 0`,
          ),
        );

        for (const statement of [
          'ALTER TABLE audit_log ADD COLUMN privilege_escape text',
          'UPDATE audit_log SET details = details WHERE false',
          'DELETE FROM custody_movements WHERE false',
          'DELETE FROM inbound_bot_events WHERE false',
          'DELETE FROM bot_inventory_snapshots WHERE false',
          'DELETE FROM wallet_transactions WHERE false',
          'UPDATE case_rounds SET price_minor = price_minor WHERE false',
          'DELETE FROM inventory_sales WHERE false',
          'UPDATE deposit_authorization_leases SET expires_at = expires_at WHERE false',
          'DELETE FROM deposit_authorization_leases WHERE false',
          'SELECT * FROM schema_migration_checksums',
          'CREATE TEMP TABLE privilege_escape_temp(id integer)',
        ]) {
          await assert.rejects(
            runtime.query(statement),
            (error: unknown) => (error as { code?: string }).code === '42501',
          );
        }
        await assert.doesNotReject(runtime.query('SELECT * FROM donut_prune_bot_telemetry()'));
        await verifyTelemetryRetention(runtime);
        await verifyDepositAuthorizationLeases(runtime);
        await verifyDepositMaintenance(runtime);
      } finally {
        await runtime.end();
      }

      const auditUrl = new URL(databaseUrl);
      auditUrl.username = 'donut_ci_audit_login';
      auditUrl.password = 'ci-only-audit-password-53ae91b8';
      const auditReader = new pg.Pool({ connectionString: auditUrl.toString(), max: 1 });
      try {
        await assertAuditDatabaseRole(auditReader);
        await assert.doesNotReject(auditReader.query('SELECT count(*) FROM audit_log'));

        // default_transaction_read_only is defence in depth only: the audit login may clear it
        // on its own session. Assert the default is active, then clear it deliberately so the
        // statements below prove the grant-level confinement, which is the control that still
        // holds once an attacker drives the session. Without this the read-only default masks
        // the privilege check and reports 25006 instead of 42501.
        const auditSession = await auditReader.connect();
        try {
          const readOnlyDefault = await auditSession.query<{ setting: string }>(
            "SELECT current_setting('default_transaction_read_only') AS setting",
          );
          assert.equal(readOnlyDefault.rows[0]?.setting, 'on');
          await auditSession.query('SET default_transaction_read_only = off');
          for (const statement of [
            'SELECT count(*) FROM users',
            `INSERT INTO audit_log
               (id, actor_user_id, action, target_type, target_id, details, previous_hash,
                entry_hash, key_id, sequence_no, created_at)
             VALUES ('10000000-0000-4000-8000-000000000001', NULL, 'test', 'test', 'test',
                     '{}', NULL, repeat('a', 64), 'ci-v1', 1, now())`,
          ]) {
            await assert.rejects(
              auditSession.query(statement),
              (error: unknown) => (error as { code?: string }).code === '42501',
            );
          }
        } finally {
          auditSession.release();
        }
      } finally {
        await auditReader.end();
      }
    } finally {
      await owner.end();
    }
  });
});
