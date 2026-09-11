import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { itemFingerprint } from '../src/fingerprint.js';

describe('Minecraft item fingerprint', () => {
  it('matches the versioned catalog test vector', () => {
    assert.equal(
      itemFingerprint({ name: 'diamond_sword', metadata: 0, nbt: null }),
      'bb243bc076b9320fba3b4e47d88f6acb7390010254633fa93daa9153b8bb3753',
    );
  });

  it('is independent of property ordering', () => {
    const left = itemFingerprint({
      name: 'diamond_sword',
      metadata: 0,
      nbt: { value: { Damage: { type: 'int', value: 2 }, custom: { type: 'string', value: 'x' } } },
    });
    const right = itemFingerprint({
      name: 'diamond_sword',
      metadata: 0,
      nbt: { value: { custom: { value: 'x', type: 'string' }, Damage: { value: 2, type: 'int' } } },
    });
    assert.equal(left, right);
  });

  it('changes for item-defining NBT', () => {
    const pristine = itemFingerprint({ name: 'diamond_sword', metadata: 0, nbt: null });
    const damaged = itemFingerprint({ name: 'diamond_sword', metadata: 0, nbt: { Damage: 1 } });
    assert.notEqual(pristine, damaged);
  });

  it('supports binary, typed-array, and bigint NBT without type collisions', () => {
    const buffer = itemFingerprint({
      name: 'player_head',
      metadata: 0,
      nbt: { bytes: Buffer.from([0, 1, 255]), owner: 9_223_372_036_854_775_807n },
    });
    const byteArray = itemFingerprint({
      name: 'player_head',
      metadata: 0,
      nbt: { bytes: new Uint8Array([0, 1, 255]), owner: 9_223_372_036_854_775_807n },
    });
    const plainObject = itemFingerprint({
      name: 'player_head',
      metadata: 0,
      nbt: { bytes: { type: 'Buffer', data: [0, 1, 255] }, owner: '9223372036854775807' },
    });

    assert.notEqual(buffer, byteArray);
    assert.notEqual(buffer, plainObject);
    assert.notEqual(byteArray, plainObject);
  });

  it('includes modern removed-components state', () => {
    const normal = itemFingerprint({
      name: 'diamond_sword',
      metadata: 0,
      components: [{ type: 7, data: { value: 1 } }],
      removedComponents: [],
    });
    const removed = itemFingerprint({
      name: 'diamond_sword',
      metadata: 0,
      components: [{ type: 7, data: { value: 1 } }],
      removedComponents: [7],
    });
    assert.notEqual(normal, removed);
  });

  it('rejects cycles and oversized binary data', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    assert.throws(
      () => itemFingerprint({ name: 'stone', metadata: 0, nbt: cycle }),
      /cycle/,
    );
    assert.throws(
      () =>
        itemFingerprint({
          name: 'stone',
          metadata: 0,
          nbt: Buffer.alloc(64 * 1024 + 1),
        }),
      /oversized binary data/,
    );
  });
});
