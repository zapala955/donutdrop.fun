import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function safeEqualBuffer(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encryptSecret(plaintext: string, key: Buffer, context: string): string {
  if (key.length !== 32) throw new Error('AES-256 key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, key: Buffer, context: string): string {
  const [version, ivValue, ciphertextValue, tagValue, ...rest] = encoded.split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue || !tagValue || rest.length) {
    throw new Error('Invalid encrypted value');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 10_000;
const MAX_CANONICAL_COLLECTION_SIZE = 512;

/**
 * Produce deterministic JSON for signatures and audit records while placing hard
 * limits on attacker-controlled structure. Only values representable by parsed
 * JSON are accepted; this intentionally rejects accessors, class instances,
 * cycles, bigint, undefined, and non-finite numbers.
 */
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
      if (!Number.isFinite(current)) throw new TypeError('Canonical JSON contains a non-finite number');
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
