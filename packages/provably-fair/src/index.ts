import { createHash, createHmac, randomBytes } from 'node:crypto';

export const ROLL_SCALE = 1_000_000;
const MAX_CLIENT_SEED_BYTES = 128;
const TWO_POW_52 = 4_503_599_627_370_496;

export interface FairRoll {
  digest: string;
  rollPpm: number;
  roll: number;
}

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function hashServerSeed(serverSeed: string): string {
  assertServerSeed(serverSeed);
  return createHash('sha256').update(serverSeed, 'utf8').digest('hex');
}

export function createFairRoll(serverSeed: string, clientSeed: string, nonce: number): FairRoll {
  assertServerSeed(serverSeed);
  assertClientSeed(clientSeed);
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new RangeError('nonce must be a non-negative safe integer');
  }

  const message = `${clientSeed}:${nonce}`;
  const digest = createHmac('sha256', serverSeed).update(message, 'utf8').digest('hex');
  // Thirteen hex digits are exactly 52 bits, so conversion remains lossless in a JS number.
  const sample = Number.parseInt(digest.slice(0, 13), 16);
  const roll = sample / TWO_POW_52;
  return { digest, rollPpm: Math.floor(roll * ROLL_SCALE), roll };
}

export function calculateWinChancePpm(
  stakeMinor: bigint,
  targetMinor: bigint,
  houseEdgeBps: number,
  maxWinChancePpm: number,
): number {
  if (stakeMinor <= 0n || targetMinor <= 0n) {
    throw new RangeError('stake and target values must be positive');
  }
  if (!Number.isInteger(houseEdgeBps) || houseEdgeBps < 0 || houseEdgeBps >= 10_000) {
    throw new RangeError('houseEdgeBps must be an integer between 0 and 9999');
  }
  if (!Number.isInteger(maxWinChancePpm) || maxWinChancePpm <= 0 || maxWinChancePpm > ROLL_SCALE) {
    throw new RangeError('maxWinChancePpm must be between 1 and 1000000');
  }

  const numerator = stakeMinor * BigInt(10_000 - houseEdgeBps) * BigInt(ROLL_SCALE);
  const raw = numerator / (targetMinor * 10_000n);
  return Number(raw > BigInt(maxWinChancePpm) ? BigInt(maxWinChancePpm) : raw);
}

function assertServerSeed(serverSeed: string): void {
  if (!/^[a-f0-9]{64}$/.test(serverSeed)) {
    throw new TypeError('serverSeed must be 32 bytes encoded as lowercase hex');
  }
}

function assertClientSeed(clientSeed: string): void {
  const bytes = Buffer.byteLength(clientSeed, 'utf8');
  const hasControlCharacter = [...clientSeed].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (bytes < 1 || bytes > MAX_CLIENT_SEED_BYTES || hasControlCharacter) {
    throw new TypeError('clientSeed must contain 1-128 UTF-8 bytes and no control characters');
  }
}
