import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readOneLineSetting } from '../src/lib/audit-checkpoint-config.js';
import { assertRuntimeDatabaseRole } from '../src/lib/database-role.js';
import { maintainDepositIntents } from '../src/lib/deposit-maintenance.js';
import { sweepDiscordControl } from '../src/lib/discord-control.js';

interface MaintenanceResult {
  status: 'completed' | 'skipped';
  expiredDeposits?: number;
  depositsManualReview?: number;
  expiredLeases?: string;
  sessionsRemoved?: number;
  challengesRemoved?: number;
  inboundEventsRemoved?: string;
  inventorySnapshotsRemoved?: string;
  discordLinksRemoved?: number;
  discordConfirmationsRemoved?: number;
  discordBudgetsRemoved?: number;
}

function maintenanceIntervalSeconds(): number {
  const raw = process.env['MAINTENANCE_INTERVAL_SECONDS'] ?? '0';
  if (!/^\d{1,5}$/.test(raw)) throw new Error('MAINTENANCE_INTERVAL_SECONDS is invalid');
  const seconds = Number(raw);
  if (seconds !== 0 && (seconds < 60 || seconds > 86_400)) {
    throw new Error('MAINTENANCE_INTERVAL_SECONDS must be 0 or between 60 and 86400');
  }
  return seconds;
}

async function runMaintenance(pool: pg.Pool): Promise<MaintenanceResult> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const maintenanceLock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(142857, 515151) AS acquired',
    );
    if (!maintenanceLock.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return { status: 'skipped' };
    }
    const depositMaintenance = await maintainDepositIntents(client);
    const expiredLeases = await client.query<{ count: string }>(
      `WITH expired AS (
         UPDATE bot_jobs
            SET status = 'dead_letter', last_error_code = 'LEASE_EXPIRED', updated_at = now()
          WHERE status = 'leased' AND lease_expires_at < now()
          RETURNING reference_id
       ), reviewed AS (
         UPDATE withdrawals AS withdrawal
            SET status = 'manual_review', error_code = 'LEASE_EXPIRED', updated_at = now()
           FROM expired
          WHERE withdrawal.id = expired.reference_id AND withdrawal.status = 'processing'
          RETURNING withdrawal.id
       )
       SELECT count(*)::text AS count FROM expired`,
    );
    const sessions = await client.query(
      `DELETE FROM sessions
        WHERE expires_at < now() - interval '7 days'
           OR revoked_at < now() - interval '7 days'`,
    );
    const challenges = await client.query(
      "DELETE FROM auth_link_challenges WHERE expires_at < now() - interval '1 day'",
    );
    const telemetry = await client.query<{
      inbound_events_deleted: string;
      inventory_snapshots_deleted: string;
    }>('SELECT * FROM public.donut_prune_bot_telemetry()');
    const telemetryCounts = telemetry.rows[0];
    /* Expired links, spent confirmations and stale budget windows are reconstructible noise. The
     * Discord COMMAND LOG is deliberately not swept: it has no DELETE grant at all, because it is
     * the record of who asked for what. */
    const discord = await sweepDiscordControl(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      status: 'completed',
      expiredDeposits: depositMaintenance.expiredDeposits,
      depositsManualReview: depositMaintenance.depositsManualReview,
      expiredLeases: expiredLeases.rows[0]?.count ?? '0',
      sessionsRemoved: sessions.rowCount ?? 0,
      challengesRemoved: challenges.rowCount ?? 0,
      inboundEventsRemoved: telemetryCounts?.inbound_events_deleted ?? '0',
      inventorySnapshotsRemoved: telemetryCounts?.inventory_snapshots_deleted ?? '0',
      discordLinksRemoved: discord.linksRemoved,
      discordConfirmationsRemoved: discord.confirmationsRemoved,
      discordBudgetsRemoved: discord.budgetsRemoved,
    };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const databaseUrl = await readOneLineSetting('DATABASE_URL');
  if (new URL(databaseUrl).protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgresql://');
  }
  const databaseSsl = process.env['DATABASE_SSL'] ?? 'false';
  if (databaseSsl !== 'true' && databaseSsl !== 'false') {
    throw new Error('DATABASE_SSL must be true or false');
  }
  const intervalSeconds = maintenanceIntervalSeconds();
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: 'donut-upgrader-maintenance',
    options: '-c timezone=UTC',
    ...(databaseSsl === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    await assertRuntimeDatabaseRole(pool);
    do {
      process.stdout.write(`${JSON.stringify(await runMaintenance(pool))}\n`);
      if (intervalSeconds > 0) await delay(intervalSeconds * 1000);
    } while (intervalSeconds > 0);
  } finally {
    await pool.end();
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown maintenance failure';
  process.stderr.write(`Maintenance failed: ${message}\n`);
  process.exitCode = 1;
});
