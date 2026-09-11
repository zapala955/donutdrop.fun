import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30n;
const TOTP_DIGITS = 8;

export function decodeCanonicalBase32(value: string): Buffer | undefined {
  if (!/^[A-Z2-7]{32,104}$/.test(value)) return undefined;
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) return undefined;
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && accumulator !== 0) return undefined;
  const decoded = Buffer.from(bytes);
  // Reject alternate encodings with redundant trailing zero groups. Without
  // this check, appending "A" to some valid values can decode to the same key.
  const canonicalLength = Math.ceil((decoded.length * 8) / 5);
  return decoded.length >= 20 && decoded.length <= 64 && value.length === canonicalLength
    ? decoded
    : undefined;
}

function codeForCounter(secret: Buffer, counter: bigint): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha256', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) >>>
    0;
  return (value % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/** Returns the accepted counter so it can be atomically persisted against replay. */
export function verifyAdminTotp(
  secret: Buffer,
  suppliedCode: string,
  lastAcceptedCounter: bigint | null,
  nowMs = Date.now(),
): bigint | undefined {
  if (!/^\d{8}$/.test(suppliedCode) || !Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
  const current = BigInt(Math.floor(nowMs / 1000)) / TOTP_STEP_SECONDS;
  for (const delta of [-1n, 0n, 1n]) {
    const counter = current + delta;
    if (counter < 0n || (lastAcceptedCounter !== null && counter <= lastAcceptedCounter)) continue;
    const expected = codeForCounter(secret, counter);
    if (timingSafeEqual(Buffer.from(suppliedCode), Buffer.from(expected))) return counter;
  }
  return undefined;
}
