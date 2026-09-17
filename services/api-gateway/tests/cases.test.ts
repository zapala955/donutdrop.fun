import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scaleDigestToWeight } from '../src/routes/cases.js';

describe('case weighted RNG', () => {
  it('maps the full committed digest into the configured integer range', () => {
    assert.equal(scaleDigestToWeight('0'.repeat(64), 100n), 0n);
    assert.equal(scaleDigestToWeight('f'.repeat(64), 100n), 99n);
    assert.equal(scaleDigestToWeight('8' + '0'.repeat(63), 10_000n), 5000n);
  });

  it('rejects malformed digests and unsupported totals', () => {
    assert.throws(() => scaleDigestToWeight('not-a-digest', 100n));
    assert.throws(() => scaleDigestToWeight('0'.repeat(64), 0n));
    assert.throws(() => scaleDigestToWeight('0'.repeat(64), 9_223_372_036_854_775_808n));
  });
});
