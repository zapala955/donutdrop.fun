import process from 'node:process';
import pg from 'pg';
import {
  INITIAL_AUDIT_VERIFICATION_STATE,
  verifyAuditRow,
  type AuditVerificationRow,
} from '../src/lib/audit-verification.js';
import { canonicalJson, hmacHex } from '../src/lib/crypto.js';
import { assertAuditDatabaseRole } from '../src/lib/database-role.js';
import {
  areHmacSecretsEquivalent,
  isValidAuditKeyId,
  parseAuditVerificationKeys,
  readOneLineSetting,
} from '../src/lib/audit-checkpoint-config.js';

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

async function main(): Promise<void> {
  const databaseUrl = await readOneLineSetting('DATABASE_URL');
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (parsedDatabaseUrl.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgresql://');
  }
  const databaseSsl = process.env['DATABASE_SSL'] ?? 'false';
  if (databaseSsl !== 'true' && databaseSsl !== 'false') {
    throw new Error('DATABASE_SSL must be true or false');
  }
  const keys = parseAuditVerificationKeys(await readOneLineSetting('AUDIT_VERIFICATION_KEYS_JSON'));
  const checkpointKey = await readOneLineSetting('AUDIT_CHECKPOINT_HMAC_KEY');
  const checkpointKeyId = await readOneLineSetting('AUDIT_CHECKPOINT_KEY_ID');
  if (checkpointKey.length < 32 || !isValidAuditKeyId(checkpointKeyId)) {
    throw new Error('The checkpoint key or key ID is invalid');
  }
  if ([...keys.values()].some((auditKey) => areHmacSecretsEquivalent(auditKey, checkpointKey))) {
    throw new Error('The checkpoint key must be independent from every audit-log key');
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: 'donut-upgrader-audit-verifier',
    options: '-c timezone=UTC',
    ...(databaseSsl === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  const client = await pool.connect();
  let state = INITIAL_AUDIT_VERIFICATION_STATE;
  try {
    await assertAuditDatabaseRole(client);
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (;;) {
      const page = await client.query<AuditVerificationRow>(
        `SELECT id, actor_user_id, action, target_type, target_id, details,
                previous_hash, entry_hash, key_id, sequence_no, created_at
         FROM audit_log
         WHERE sequence_no >= $1
         ORDER BY sequence_no
         LIMIT 1000`,
        [state.nextSequence.toString()],
      );
      if (!page.rowCount) break;
      for (const row of page.rows) state = verifyAuditRow(row, state, keys);
      if (state.nextSequence > POSTGRES_BIGINT_MAX) break;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  const checkpoint = Object.freeze({
    version: 1,
    checkpointKeyId,
    entryCount: state.entryCount.toString(),
    headSequenceNo: state.entryCount === 0n ? null : (state.nextSequence - 1n).toString(),
    headHash: state.previousHash,
    verifiedAt: new Date().toISOString(),
  });
  const signature = hmacHex(checkpointKey, canonicalJson(checkpoint));
  process.stdout.write(
    `${JSON.stringify({ checkpoint, signatureAlgorithm: 'hmac-sha256', signature })}\n`,
  );
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown audit verification failure';
  process.stderr.write(`Audit verification failed: ${message}\n`);
  process.exitCode = 1;
});
