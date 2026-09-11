import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { canonicalJson, hmacHex } from './crypto.js';

export async function appendAudit(
  client: DbClient,
  config: AppConfig,
  entry: {
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    details: unknown;
  },
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(904211771)`);
  const previous = await client.query<{ entry_hash: string; sequence_no: string }>(
    'SELECT entry_hash, sequence_no FROM audit_log ORDER BY sequence_no DESC LIMIT 1',
  );
  const previousHash = previous.rows[0]?.entry_hash ?? null;
  const sequenceNo = (BigInt(previous.rows[0]?.sequence_no ?? '0') + 1n).toString();
  if (BigInt(sequenceNo) > 9_223_372_036_854_775_807n) {
    throw new Error('Audit sequence exhausted');
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const keyId = config.auditLogKeyId;
  const payload = canonicalJson({ id, ...entry, previousHash, keyId, sequenceNo, createdAt });
  const entryHash = hmacHex(config.auditLogHmacKey, payload);
  await client.query(
    `INSERT INTO audit_log
       (id, actor_user_id, action, target_type, target_id, details,
        previous_hash, entry_hash, key_id, sequence_no, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      entry.actorUserId,
      entry.action,
      entry.targetType,
      entry.targetId,
      JSON.stringify(entry.details),
      previousHash,
      entryHash,
      keyId,
      sequenceNo,
      createdAt,
    ],
  );
}
