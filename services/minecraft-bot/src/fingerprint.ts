import { canonicalJson, sha256Hex } from './canonical.js';

const MAX_ITEM_DATA_DEPTH = 32;
const MAX_ITEM_DATA_NODES = 10_000;
const MAX_ITEM_DATA_COLLECTION_SIZE = 512;
const MAX_ITEM_DATA_BINARY_BYTES = 64 * 1024;
const MAX_ITEM_DATA_STRING_BYTES = 64 * 1024;

export interface MineflayerItemLike {
  name: string;
  metadata: number;
  nbt?: unknown;
  components?: unknown;
  removedComponents?: unknown;
}

type TaggedItemData = readonly unknown[];

/**
 * Prismarine NBT may contain Buffer, bigint, and typed-array values, none of
 * which have an unambiguous JSON representation. Tag every value type before
 * canonicalization so distinct NBT values cannot collapse to the same hash.
 */
function normalizeItemData(value: unknown): TaggedItemData {
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): TaggedItemData => {
    nodes += 1;
    if (nodes > MAX_ITEM_DATA_NODES) throw new TypeError('Minecraft item data is too large');
    if (depth > MAX_ITEM_DATA_DEPTH) throw new TypeError('Minecraft item data is too deep');

    if (current === null) return ['null'];
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > MAX_ITEM_DATA_STRING_BYTES) {
        throw new TypeError('Minecraft item data contains an oversized string');
      }
      return ['string', current];
    }
    if (typeof current === 'boolean') return ['boolean', current];
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new TypeError('Minecraft item data contains a non-finite number');
      }
      return ['number', Object.is(current, -0) ? '-0' : current.toString()];
    }
    if (typeof current === 'bigint') return ['bigint', current.toString()];
    if (typeof current !== 'object') {
      throw new TypeError('Minecraft item data contains an unsupported value');
    }
    if (ancestors.has(current)) throw new TypeError('Minecraft item data contains a cycle');

    if (Buffer.isBuffer(current)) {
      if (current.byteLength > MAX_ITEM_DATA_BINARY_BYTES) {
        throw new TypeError('Minecraft item data contains oversized binary data');
      }
      return ['buffer', current.toString('base64')];
    }
    if (current instanceof ArrayBuffer) {
      if (current.byteLength > MAX_ITEM_DATA_BINARY_BYTES) {
        throw new TypeError('Minecraft item data contains oversized binary data');
      }
      return ['array-buffer', Buffer.from(current).toString('base64')];
    }
    if (ArrayBuffer.isView(current)) {
      if (current.byteLength > MAX_ITEM_DATA_BINARY_BYTES) {
        throw new TypeError('Minecraft item data contains oversized binary data');
      }
      const constructorName = current.constructor.name;
      if (current instanceof DataView) {
        return [
          'data-view',
          Buffer.from(current.buffer, current.byteOffset, current.byteLength).toString('base64'),
        ];
      }
      const entries = Array.from(current as unknown as ArrayLike<number | bigint>);
      if (entries.length > MAX_ITEM_DATA_COLLECTION_SIZE) {
        throw new TypeError('Minecraft item data typed array is too large');
      }
      return [
        'typed-array',
        constructorName,
        entries.map((entry) =>
          typeof entry === 'bigint'
            ? (['bigint', entry.toString()] as const)
            : (['number', Object.is(entry, -0) ? '-0' : entry.toString()] as const),
        ),
      ];
    }

    const prototype: unknown = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(current)) {
      throw new TypeError('Minecraft item data contains a non-plain object');
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_ITEM_DATA_COLLECTION_SIZE) {
          throw new TypeError('Minecraft item data array is too large');
        }
        return ['array', current.map((entry) => visit(entry, depth + 1))];
      }

      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.length > MAX_ITEM_DATA_COLLECTION_SIZE) {
        throw new TypeError('Minecraft item data object has too many keys');
      }
      if (
        Reflect.ownKeys(record).some((key) =>
          typeof key === 'symbol' ? true : !Object.prototype.propertyIsEnumerable.call(record, key),
        )
      ) {
        throw new TypeError('Minecraft item data contains hidden properties');
      }
      return [
        'object',
        keys.map((key) => {
          if (Buffer.byteLength(key, 'utf8') > MAX_ITEM_DATA_STRING_BYTES) {
            throw new TypeError('Minecraft item data contains an oversized key');
          }
          const descriptor = Object.getOwnPropertyDescriptor(record, key);
          if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('Minecraft item data contains an accessor');
          }
          return [key, visit(descriptor.value, depth + 1)] as const;
        }),
      ];
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, 0);
}

/** Count and slot are intentionally excluded; all item-defining data is included. */
export function itemFingerprint(item: MineflayerItemLike): string {
  if (!item.name || !Number.isInteger(item.metadata)) {
    throw new TypeError('Minecraft item identity is malformed');
  }
  return sha256Hex(
    canonicalJson({
      version: 3,
      name: item.name,
      metadata: item.metadata,
      nbt: normalizeItemData(item.nbt ?? null),
      components: normalizeItemData(item.components ?? null),
      removedComponents: normalizeItemData(item.removedComponents ?? null),
    }),
  );
}
