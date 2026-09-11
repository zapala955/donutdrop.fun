import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INITIAL_AUDIT_VERIFICATION_STATE,
  verifyAuditRow,
  type AuditVerificationRow,
} from '../src/lib/audit-verification.js';
import { canonicalJson, hmacHex } from '../src/lib/crypto.js';

const legacyKey = 'legacy-audit-key-with-at-least-thirty-two-bytes';
const currentKey = 'current-audit-key-with-at-least-thirty-two-bytes';
const keys = new Map([
  ['legacy-v1', legacyKey],
  ['prod-v2', currentKey],
]);

function signedRows(): [AuditVerificationRow, AuditVerificationRow] {
  const firstBase = {
    id: '00000000-0000-4000-8000-000000000001',
    actorUserId: null,
    action: 'system.started',
    targetType: 'system',
    targetId: 'api',
    details: { ready: true },
    previousHash: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const firstHash = hmacHex(legacyKey, canonicalJson(firstBase));
  const first: AuditVerificationRow = {
    id: firstBase.id,
    actor_user_id: null,
    action: firstBase.action,
    target_type: firstBase.targetType,
    target_id: firstBase.targetId,
    details: firstBase.details,
    previous_hash: null,
    entry_hash: firstHash,
    key_id: 'legacy-v1',
    sequence_no: '1',
    created_at: firstBase.createdAt,
  };
  const secondBase = {
    id: '00000000-0000-4000-8000-000000000002',
    actorUserId: null,
    action: 'system.checked',
    targetType: 'system',
    targetId: 'api',
    details: { count: 1 },
    previousHash: firstHash,
    createdAt: '2026-01-01T00:00:01.000Z',
  };
  const secondHash = hmacHex(
    currentKey,
    canonicalJson({ ...secondBase, keyId: 'prod-v2', sequenceNo: '2' }),
  );
  return [
    first,
    {
      id: secondBase.id,
      actor_user_id: null,
      action: secondBase.action,
      target_type: secondBase.targetType,
      target_id: secondBase.targetId,
      details: secondBase.details,
      previous_hash: firstHash,
      entry_hash: secondHash,
      key_id: 'prod-v2',
      sequence_no: '2',
      created_at: secondBase.createdAt,
    },
  ];
}

void describe('audit-chain verification', () => {
  void it('verifies legacy and key-versioned entries in sequence', () => {
    let state = INITIAL_AUDIT_VERIFICATION_STATE;
    for (const row of signedRows()) state = verifyAuditRow(row, state, keys);
    assert.equal(state.entryCount, 2n);
    assert.equal(state.nextSequence, 3n);
  });

  void it('detects mutation, deletion, reordering, and unavailable rotation keys', () => {
    const [first, second] = signedRows();
    const afterFirst = verifyAuditRow(first, INITIAL_AUDIT_VERIFICATION_STATE, keys);
    assert.throws(() => verifyAuditRow({ ...second, details: { count: 2 } }, afterFirst, keys));
    assert.throws(() => verifyAuditRow(second, INITIAL_AUDIT_VERIFICATION_STATE, keys));
    assert.throws(() => verifyAuditRow(second, afterFirst, new Map([['legacy-v1', legacyKey]])));
  });
});
