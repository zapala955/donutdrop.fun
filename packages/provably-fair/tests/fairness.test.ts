import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateWinChancePpm, createFairRoll, hashServerSeed } from '../src/index.js';

describe('provably fair primitives', () => {
  const serverSeed = '0123456789abcdef'.repeat(4);

  it('has stable commitment and roll vectors', () => {
    assert.equal(
      hashServerSeed(serverSeed),
      'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e',
    );
    assert.deepEqual(createFairRoll(serverSeed, 'player-seed', 0), {
      digest: 'c1cf9f12120c4118d0c4debe6496e03f98fd115b76717a61c405503386bc287c',
      rollPpm: 757074,
      roll: 0.7570743006818228,
    });
  });

  it('calculates integer-only odds and applies the cap', () => {
    assert.equal(calculateWinChancePpm(10_000n, 20_000n, 500, 750_000), 475_000);
    assert.equal(calculateWinChancePpm(19_000n, 20_000n, 0, 750_000), 750_000);
  });

  it('rejects malformed inputs', () => {
    assert.throws(() => createFairRoll('bad', 'seed', 0));
    assert.throws(() => createFairRoll(serverSeed, '', 0));
    assert.throws(() => createFairRoll(serverSeed, 'seed', -1));
  });

  it('always returns values inside the defined roll range', () => {
    for (let nonce = 0; nonce < 1000; nonce += 1) {
      const roll = createFairRoll(serverSeed, 'range-check', nonce);
      assert.ok(roll.roll >= 0);
      assert.ok(roll.roll < 1);
      assert.ok(roll.rollPpm >= 0);
      assert.ok(roll.rollPpm < 1_000_000);
    }
  });
});
