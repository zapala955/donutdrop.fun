import { createHash, createHmac } from 'node:crypto';

const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 10_000;
const MAX_CANONICAL_COLLECTION_SIZE = 512;

/** This must remain byte-for-byte compatible with the API canonicalizer. */
export function canonicalJson(value: unknown): string {
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) throw new TypeError('Canonical JSON is too large');
    if (depth > MAX_CANONICAL_DEPTH) throw new TypeError('Canonical JSON is too deep');

    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new TypeError('Canonical JSON contains a non-finite number');
      }
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') {
      throw new TypeError('Canonical JSON contains an unsupported value');
    }
    if (ancestors.has(current)) throw new TypeError('Canonical JSON contains a cycle');

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(current)) {
      throw new TypeError('Canonical JSON contains a non-plain object');
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > MAX_CANONICAL_COLLECTION_SIZE) {
          throw new TypeError('Canonical JSON array is too large');
        }
        return `[${current.map((entry) => visit(entry, depth + 1)).join(',')}]`;
      }

      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.length > MAX_CANONICAL_COLLECTION_SIZE) {
        throw new TypeError('Canonical JSON object has too many keys');
      }
      return `{${keys
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(record, key);
          if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('Canonical JSON contains an accessor');
          }
          return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
        })
        .join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, 0);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacHex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
