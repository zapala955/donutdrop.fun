import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_ONE_LINE_SETTING_BYTES,
  parseAuditVerificationKeys,
  readOneLineSetting,
} from '../src/lib/audit-checkpoint-config.js';

function secret(index: number): string {
  return `audit-secret-${index.toString().padStart(6, '0')}-${'x'.repeat(32)}`;
}

void describe('audit checkpoint configuration', () => {
  void it('retains rotation histories larger than the former 64-key limit', () => {
    const source = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`rotation-${index}`, secret(index)]),
    );

    const keys = parseAuditVerificationKeys(JSON.stringify(source));

    assert.equal(keys.size, 256);
    assert.equal(keys.get('rotation-0'), secret(0));
    assert.equal(keys.get('rotation-255'), secret(255));
  });

  void it('rejects reuse of one effective HMAC secret under multiple key IDs', () => {
    const shared = secret(1);
    assert.throws(
      () => parseAuditVerificationKeys(JSON.stringify({ 'old-v1': shared, 'current-v2': shared })),
      /distinct secret/,
    );

    const firstMalformedUtf16 = '\ud800'.repeat(32);
    const secondMalformedUtf16 = '\ud801'.repeat(32);
    assert.notEqual(firstMalformedUtf16, secondMalformedUtf16);
    assert.throws(
      () =>
        parseAuditVerificationKeys(
          JSON.stringify({ first: firstMalformedUtf16, second: secondMalformedUtf16 }),
        ),
      /distinct secret/,
    );
  });

  void it('rejects oversized direct settings before parsing', async () => {
    await assert.rejects(
      readOneLineSetting('AUDIT_VERIFICATION_KEYS_JSON', {
        AUDIT_VERIFICATION_KEYS_JSON: 'x'.repeat(MAX_ONE_LINE_SETTING_BYTES + 1),
      }),
      /maximum allowed size/,
    );
  });

  void it('reads bounded secret files and rejects oversized files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'donut-audit-config-'));
    const validPath = path.join(directory, 'valid');
    const oversizedPath = path.join(directory, 'oversized');
    try {
      await writeFile(validPath, '{"key-v1":"abcdefghijklmnopqrstuvwxyz123456"}\n', 'utf8');
      await writeFile(oversizedPath, Buffer.alloc(MAX_ONE_LINE_SETTING_BYTES + 1, 0x78));

      assert.equal(
        await readOneLineSetting('AUDIT_VERIFICATION_KEYS_JSON', {
          AUDIT_VERIFICATION_KEYS_JSON_FILE: validPath,
        }),
        '{"key-v1":"abcdefghijklmnopqrstuvwxyz123456"}',
      );
      await assert.rejects(
        readOneLineSetting('AUDIT_VERIFICATION_KEYS_JSON', {
          AUDIT_VERIFICATION_KEYS_JSON_FILE: oversizedPath,
        }),
        /maximum allowed size/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
