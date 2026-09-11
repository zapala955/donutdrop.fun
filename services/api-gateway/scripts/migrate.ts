import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';
import { readOneLineSetting } from '../src/lib/audit-checkpoint-config.js';
import { assertMigratorDatabaseRole } from '../src/lib/database-role.js';

const databaseUrl = await readOneLineSetting('DATABASE_URL');
if (new URL(databaseUrl).protocol !== 'postgresql:') {
  throw new Error('DATABASE_URL must use postgresql://');
}
const databaseSsl = process.env['DATABASE_SSL'] ?? 'false';
if (databaseSsl !== 'true' && databaseSsl !== 'false') {
  throw new Error('DATABASE_SSL must be true or false');
}

const migrationsDirectory = path.resolve(import.meta.dirname, '../../../packages/db/migrations');
const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 300_000,
  application_name: 'donut-upgrader-migrator',
  options: '-c timezone=UTC',
  ...(databaseSsl === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
});

function withoutLegacyTransactionWrapper(sql: string): string {
  return sql.replace(/^\s*BEGIN\s*;\s*/i, '').replace(/\s*COMMIT\s*;\s*$/i, '');
}

const client = await pool.connect();
try {
  await assertMigratorDatabaseRole(client);
  // A session-level lock serializes all migrator processes. Each migration and
  // its checksum are committed together, so neither can exist without the other.
  await client.query('SELECT pg_advisory_lock(142857, 424242)');
  await client.query('BEGIN');
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_checksums (
      version text PRIMARY KEY,
      sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query('COMMIT');

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDirectory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await client.query('BEGIN');
    try {
      const existing = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM schema_migration_checksums WHERE version = $1 FOR UPDATE',
        [file],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.sha256 !== checksum)
          throw new Error(`Migration changed after apply: ${file}`);
        await client.query('COMMIT');
        continue;
      }

      // Version 001 predates atomic checksum tracking. If its own legacy marker
      // is present, recover a run that committed the schema but lost its checksum.
      if (file === '001_initial.sql') {
        const legacyTable = await client.query<{ table_name: string | null }>(
          `SELECT to_regclass('public.schema_migrations')::text AS table_name`,
        );
        const legacy = legacyTable.rows[0]?.table_name
          ? await client.query<{ applied: boolean }>(
              `SELECT EXISTS (
                 SELECT 1 FROM schema_migrations WHERE version = '001_initial'
               ) AS applied`,
            )
          : undefined;
        if (legacy?.rows[0]?.applied) {
          await client.query(
            'INSERT INTO schema_migration_checksums(version, sha256) VALUES ($1, $2)',
            [file, checksum],
          );
          await client.query('COMMIT');
          process.stdout.write(`Recovered checksum for ${file}\n`);
          continue;
        }
      }

      await client.query(withoutLegacyTransactionWrapper(sql));
      await client.query(
        'INSERT INTO schema_migration_checksums(version, sha256) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
      process.stdout.write(`Applied ${file}\n`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(142857, 424242)').catch(() => undefined);
  client.release();
  await pool.end();
}
