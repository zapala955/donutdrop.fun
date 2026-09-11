import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCanonicalBase32, verifyAdminTotp } from '../src/lib/totp.js';

const RFC_SHA256_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';

describe('administrator TOTP', () => {
  it('matches the RFC 6238 SHA-256 vector and rejects counter replay', () => {
    const secret = decodeCanonicalBase32(RFC_SHA256_SECRET);
    assert.ok(secret);
    assert.equal(verifyAdminTotp(secret, '46119246', null, 59_000), 1n);
    assert.equal(verifyAdminTotp(secret, '46119246', 1n, 59_000), undefined);
  });

  it('rejects malformed and non-canonical base32 secrets', () => {
    assert.equal(decodeCanonicalBase32('lowercase'), undefined);
    assert.equal(decodeCanonicalBase32('A'.repeat(31)), undefined);
    assert.equal(decodeCanonicalBase32(`${RFC_SHA256_SECRET}=`), undefined);
  });

  it('rejects a redundant trailing zero group that would encode no additional byte', () => {
    const canonicalZeroKey = 'A'.repeat(32);
    assert.deepEqual(decodeCanonicalBase32(canonicalZeroKey), Buffer.alloc(20));
    assert.equal(decodeCanonicalBase32(`${canonicalZeroKey}A`), undefined);
  });
});
