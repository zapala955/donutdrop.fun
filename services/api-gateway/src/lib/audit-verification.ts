import { canonicalJson, hmacHex, safeEqualText } from './crypto.js';

export interface AuditVerificationRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  details: unknown;
  previous_hash: string | null;
  entry_hash: string;
  key_id: string;
  sequence_no: string;
  created_at: Date | string;
}

export interface AuditVerificationState {
  readonly nextSequence: bigint;
  readonly previousHash: string | null;
  readonly entryCount: bigint;
}

export const INITIAL_AUDIT_VERIFICATION_STATE: AuditVerificationState = Object.freeze({
  nextSequence: 1n,
  previousHash: null,
  entryCount: 0n,
});

function isoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Audit row has an invalid timestamp');
  return date.toISOString();
}

export function verifyAuditRow(
  row: AuditVerificationRow,
  state: AuditVerificationState,
  keys: ReadonlyMap<string, string>,
): AuditVerificationState {
  if (!/^[1-9]\d*$/.test(row.sequence_no) || BigInt(row.sequence_no) !== state.nextSequence) {
    throw new Error(`Audit sequence mismatch at ${row.id}`);
  }
  if (row.previous_hash !== state.previousHash) {
    throw new Error(`Audit predecessor mismatch at sequence ${row.sequence_no}`);
  }
  if (!/^[a-f0-9]{64}$/.test(row.entry_hash)) {
    throw new Error(`Audit entry hash is malformed at sequence ${row.sequence_no}`);
  }

  const key = keys.get(row.key_id);
  if (!key) throw new Error(`No verification key is available for audit key ${row.key_id}`);

  const basePayload = {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    details: row.details,
    previousHash: row.previous_hash,
    createdAt: isoTimestamp(row.created_at),
  };
  const payload =
    row.key_id === 'legacy-v1'
      ? canonicalJson(basePayload)
      : canonicalJson({
          ...basePayload,
          keyId: row.key_id,
          sequenceNo: row.sequence_no,
        });
  const expectedHash = hmacHex(key, payload);
  if (!safeEqualText(expectedHash, row.entry_hash)) {
    throw new Error(`Audit signature mismatch at sequence ${row.sequence_no}`);
  }

  return Object.freeze({
    nextSequence: state.nextSequence + 1n,
    previousHash: row.entry_hash,
    entryCount: state.entryCount + 1n,
  });
}
