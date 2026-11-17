import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anonymousNbt, customClickActionId, customClickActionPacket } from '../src/dialog-click.js';

/* 2026-11-17: the library's custom_click_action got the stats bot kicked ("Failed to decode packet
 * 'serverbound/minecraft:custom_click_action'"). The server reads an id, a VarInt size and the NBT. */

const payload = {
  type: 'compound',
  value: { args: { type: 'string', value: 'full teexs' }, cmd: { type: 'string', value: 'stats' } },
};

describe('pressing a dialog button', () => {
  it('writes the payload as network NBT, byte for byte what prismarine-nbt writes', () => {
    // prismarine-nbt's anonymousNbt for the same compound, taken from the library on 2026-11-17.
    assert.equal(
      anonymousNbt(payload).toString('hex'),
      '0a08000461726773000a66756c6c207465657873080003636d640005737461747300',
    );
    assert.equal(anonymousNbt(undefined).toString('hex'), '00', 'no payload is TAG_END');
  });

  it('frames the packet as the server reads it: packet id, action id, payload size, payload', () => {
    const packet = customClickActionPacket(0x44, 'donutdialogues:action', payload);
    const name = Buffer.from('donutdialogues:action');
    const nbt = anonymousNbt(payload);
    assert.deepEqual(packet, Buffer.concat([Buffer.from([0x44, name.length]), name, Buffer.from([nbt.length]), nbt]));
  });

  it('finds the packet id in the bot’s own protocol data', () => {
    const registry = { protocol: { play: { toServer: { types: { packet: ['container', [{ name: 'name', type: ['mapper', { type: 'varint', mappings: { '0x12': 'window_click', '0x44': 'custom_click_action' } }] }]] } } } } };
    assert.equal(customClickActionId(registry), 0x44);
    assert.equal(customClickActionId({}), undefined);
  });

  it('writes other NBT kinds the server may put in a payload', () => {
    assert.equal(anonymousNbt({ type: 'compound', value: { n: { type: 'int', value: 200 } } }).toString('hex'), '0a0300016e000000c800');
    assert.equal(
      anonymousNbt({ type: 'list', value: { type: 'string', value: ['a'] } }).toString('hex'),
      '0908000000010001' + '61',
    );
  });
});
