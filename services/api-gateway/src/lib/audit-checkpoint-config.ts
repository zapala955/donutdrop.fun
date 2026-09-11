import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

export const MAX_ONE_LINE_SETTING_BYTES = 1024 * 1024;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function encodedSecret(secret: string): string {
  return Buffer.from(secret, 'utf8').toString('base64');
}

async function readBoundedUtf8File(path: string, settingName: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`${settingName}_FILE must identify a regular file`);
    }
    if (metadata.size > MAX_ONE_LINE_SETTING_BYTES) {
      throw new Error(`${settingName}_FILE exceeds the maximum allowed size`);
    }

    // Read at most one byte beyond the limit. This keeps the check safe if a file
    // grows after stat() and avoids loading an attacker-controlled file unboundedly.
    const bytes = Buffer.allocUnsafe(MAX_ONE_LINE_SETTING_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_ONE_LINE_SETTING_BYTES) {
      throw new Error(`${settingName}_FILE exceeds the maximum allowed size`);
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new Error(`${settingName}_FILE must contain valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

export async function readOneLineSetting(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const direct = environment[name];
  const file = environment[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Set only one of ${name} or ${name}_FILE`);
  }

  if (direct !== undefined && Buffer.byteLength(direct, 'utf8') > MAX_ONE_LINE_SETTING_BYTES) {
    throw new Error(`${name} exceeds the maximum allowed size`);
  }

  const value = file ? (await readBoundedUtf8File(file, name)).replace(/\r?\n$/, '') : direct;
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must contain exactly one non-empty line`);
  }
  return value;
}

export function parseAuditVerificationKeys(value: string): ReadonlyMap<string, string> {
  if (Buffer.byteLength(value, 'utf8') > MAX_ONE_LINE_SETTING_BYTES) {
    throw new Error('AUDIT_VERIFICATION_KEYS_JSON exceeds the maximum allowed size');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error('AUDIT_VERIFICATION_KEYS_JSON must be valid JSON');
  }
  if (!decoded || Array.isArray(decoded) || typeof decoded !== 'object') {
    throw new Error('AUDIT_VERIFICATION_KEYS_JSON must map key IDs to secrets');
  }

  const entries = Object.entries(decoded as Record<string, unknown>);
  if (!entries.length) {
    throw new Error('AUDIT_VERIFICATION_KEYS_JSON must contain at least one key');
  }

  const result = new Map<string, string>();
  const encodedSecrets = new Set<string>();
  for (const [keyId, secret] of entries) {
    if (!KEY_ID_PATTERN.test(keyId) || typeof secret !== 'string' || secret.length < 32) {
      throw new Error('AUDIT_VERIFICATION_KEYS_JSON contains an invalid key ID or secret');
    }

    // Node's HMAC APIs encode string keys as UTF-8. Compare that effective byte
    // representation so distinct malformed JS strings cannot configure one key twice.
    const effectiveSecret = encodedSecret(secret);
    if (encodedSecrets.has(effectiveSecret)) {
      throw new Error('AUDIT_VERIFICATION_KEYS_JSON must use a distinct secret for each key ID');
    }
    encodedSecrets.add(effectiveSecret);
    result.set(keyId, secret);
  }
  return result;
}

export function isValidAuditKeyId(value: string): boolean {
  return KEY_ID_PATTERN.test(value);
}

export function areHmacSecretsEquivalent(left: string, right: string): boolean {
  return encodedSecret(left) === encodedSecret(right);
}
