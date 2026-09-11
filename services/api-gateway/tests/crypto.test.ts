import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, decryptSecret, encryptSecret } from '../src/lib/crypto.js';

describe('security crypto helpers', () => {
  it('round-trips an encrypted secret only under the same context', () => {
    const key = Buffer.alloc(32, 7);
    const encrypted = encryptSecret('sensitive', key, 'fairness:user:seed');
    assert.ok(!encrypted.includes('sensitive'));
    assert.equal(decryptSecret(encrypted, key, 'fairness:user:seed'), 'sensitive');
    assert.throws(() => decryptSecret(encrypted, key, 'fairness:other:seed'));
  });

  it('canonicalizes object keys recursively', () => {
    assert.equal(
      canonicalJson({ z: [3, { b: 2, a: 1 }], a: true }),
      '{"a":true,"z":[3,{"a":1,"b":2}]}',
    );
  });

  it('rejects structures that could exhaust the signature verifier', () => {
    let deep: unknown = null;
    for (let index = 0; index < 40; index += 1) deep = { child: deep };

    assert.throws(() => canonicalJson(deep), /too deep/);
    assert.throws(() => canonicalJson(Array.from({ length: 513 }, () => null)), /too large/);
  });

  it('rejects values that are not unambiguous JSON', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    assert.throws(() => canonicalJson(cyclic), /cycle/);
    assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite/);
    assert.throws(() => canonicalJson({ value: undefined }), /unsupported/);
  });
});
