/**
 * Pressing a button in a dialog the server showed, the way a game client does.
 *
 * DonutSMP's /stats is a dialog whose "View Full Profile" button is a custom action: pressing it sends
 * the serverbound custom_click_action packet with the button's id and payload. The protocol library
 * (minecraft-data 3.116, 26.1) describes that packet as an id and an *optional* NBT, and writes it so;
 * the server reads an id, a VarInt byte count and then the NBT (minecraft.wiki, Java Edition
 * protocol, Custom Click Action), and kicked the stats bot with "Failed to decode packet
 * 'serverbound/minecraft:custom_click_action'" on 2026-11-17. So the packet is built here, byte for
 * byte, and sent raw: the packet id from the bot's own protocol data, then id, size, payload.
 */

type NbtNode = { type: string; value: unknown };

const TAG: Record<string, number> = {
  end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7,
  string: 8, list: 9, compound: 10, intArray: 11, longArray: 12,
};

function varInt(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

function tagOf(type: string): number {
  const tag = TAG[type];
  if (tag === undefined) throw new Error(`NBT type ${type} cannot be written`);
  return tag;
}

function string(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > 0xffff) throw new Error('NBT string too long');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function number(type: string, value: unknown): Buffer {
  const out = Buffer.alloc(type === 'byte' ? 1 : type === 'short' ? 2 : type === 'int' || type === 'float' ? 4 : 8);
  if (type === 'byte') out.writeInt8(Number(value));
  else if (type === 'short') out.writeInt16BE(Number(value));
  else if (type === 'int') out.writeInt32BE(Number(value));
  else if (type === 'float') out.writeFloatBE(Number(value));
  else if (type === 'double') out.writeDoubleBE(Number(value));
  else if (Array.isArray(value)) {
    // A long as prismarine-nbt hands it over: [high, low].
    out.writeInt32BE(Number(value[0]));
    out.writeInt32BE(Number(value[1]), 4);
  } else out.writeBigInt64BE(BigInt(value as bigint | number));
  return out;
}

/** One NBT payload (without its tag byte), from the { type, value } form the server's NBT arrives in. */
function payload(node: NbtNode): Buffer {
  const { type, value } = node;
  switch (type) {
    case 'byte': case 'short': case 'int': case 'long': case 'float': case 'double':
      return number(type, value);
    case 'string':
      return string(String(value));
    case 'byteArray': case 'intArray': case 'longArray': {
      const items = value as unknown[];
      const count = Buffer.alloc(4);
      count.writeInt32BE(items.length);
      const element = type === 'byteArray' ? 'byte' : type === 'intArray' ? 'int' : 'long';
      return Buffer.concat([count, ...items.map((item) => number(element, item))]);
    }
    case 'list': {
      const list = value as { type: string; value: unknown[] };
      const count = Buffer.alloc(4);
      count.writeInt32BE(list.value.length);
      return Buffer.concat([
        Buffer.from([list.value.length ? tagOf(list.type) : 0]),
        count,
        ...list.value.map((item) => payload({ type: list.type, value: item })),
      ]);
    }
    case 'compound': {
      const parts: Buffer[] = [];
      for (const [name, child] of Object.entries(value as Record<string, NbtNode>)) {
        parts.push(Buffer.from([tagOf(child.type)]), string(name), payload(child));
      }
      parts.push(Buffer.from([0]));
      return Buffer.concat(parts);
    }
    default:
      throw new Error(`NBT type ${type} cannot be written`);
  }
}

/** NBT as the network carries it since 1.20.2: the tag type, no root name, the payload. */
export function anonymousNbt(node: unknown): Buffer {
  if (node === undefined || node === null) return Buffer.from([0]);
  const nbt = node as NbtNode;
  return Buffer.concat([Buffer.from([tagOf(nbt.type)]), payload(nbt)]);
}

/** The custom_click_action packet's id in the bot's protocol (0x44 in 26.1), or undefined. */
export function customClickActionId(registry: unknown): number | undefined {
  const packet = (registry as { protocol?: { play?: { toServer?: { types?: { packet?: unknown } } } } } | undefined)
    ?.protocol?.play?.toServer?.types?.packet as [string, Array<{ type?: [string, { mappings?: Record<string, string> }] }>] | undefined;
  const mappings = packet?.[1]?.[0]?.type?.[1]?.mappings;
  if (!mappings) return undefined;
  const key = Object.keys(mappings).find((code) => mappings[code] === 'custom_click_action');
  return key === undefined ? undefined : Number.parseInt(key, 16);
}

/** The whole packet, ready for writeRaw: packet id, the action's id, the payload's size, the payload. */
export function customClickActionPacket(packetId: number, id: string, nbt: unknown): Buffer {
  const name = Buffer.from(id, 'utf8');
  const body = anonymousNbt(nbt);
  if (body.length > 65_536) throw new Error('custom click payload too large');
  return Buffer.concat([varInt(packetId), varInt(name.length), name, varInt(body.length), body]);
}
