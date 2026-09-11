import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { decodeCanonicalBase32 } from './lib/totp.js';

const FILE_BACKED_SETTINGS = [
  'DATABASE_URL',
  'REDIS_URL',
  'COOKIE_SECRET',
  'DATA_ENCRYPTION_KEY',
  'BOT_CREDENTIALS_JSON',
  'ADMIN_TOTP_SECRETS_JSON',
  'AUDIT_LOG_HMAC_KEY',
  'IP_HASH_KEY',
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_FILE_BACKED_SETTING_BYTES = 256 * 1024;

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

function readSecretFile(path: string, setting: string): string {
  let descriptor: number | undefined;
  let value: string;
  try {
    descriptor = openSync(path, 'r');
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BACKED_SETTING_BYTES) {
      throw new Error('secret file is not a bounded regular file');
    }
    const bytes = Buffer.allocUnsafe(MAX_FILE_BACKED_SETTING_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BACKED_SETTING_BYTES) throw new Error('secret file is too large');
    value = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(0, offset))
      .replace(/\r?\n$/, '');
  } catch (error) {
    throw new Error(`Unable to read ${setting}_FILE`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error(`${setting}_FILE must contain exactly one non-empty line`);
  }
  return value;
}

function resolveFileBackedSettings(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  for (const setting of FILE_BACKED_SETTINGS) {
    const fileSetting = `${setting}_FILE`;
    const direct = resolved[setting];
    const file = resolved[fileSetting];
    const hasDirect = direct !== undefined;
    const hasFile = file !== undefined;
    if (hasDirect && hasFile) {
      throw new Error(`${setting} and ${fileSetting} are mutually exclusive`);
    }
    if (hasDirect && Buffer.byteLength(direct, 'utf8') > MAX_FILE_BACKED_SETTING_BYTES) {
      throw new Error(`${setting} exceeds the maximum allowed size`);
    }
    if (!hasDirect && hasFile) resolved[setting] = readSecretFile(file, setting);
  }
  return resolved;
}

function decodeCanonicalKey(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value ? decoded : undefined;
}

const MINECRAFT_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const MINECRAFT_HOST_PATTERN =
  /^(?=.{1,253}\.?$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/;

export interface ProvisionedBotCredential {
  readonly secret: Buffer;
  readonly serverHost: string;
  readonly username: string;
}

function parseBotCredentials(value: string): ReadonlyMap<string, ProvisionedBotCredential> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('BOT_CREDENTIALS_JSON must be valid JSON');
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('BOT_CREDENTIALS_JSON must map bot UUIDs to provisioned identities and secrets');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 64) {
    throw new Error('BOT_CREDENTIALS_JSON must provision between 1 and 64 bots');
  }
  const credentials = new Map<string, ProvisionedBotCredential>();
  for (const [rawBotId, rawCredential] of entries) {
    const botId = rawBotId.toLowerCase();
    if (
      !UUID_PATTERN.test(botId) ||
      !rawCredential ||
      Array.isArray(rawCredential) ||
      typeof rawCredential !== 'object'
    ) {
      throw new Error('BOT_CREDENTIALS_JSON contains an invalid bot UUID or credential');
    }
    const record = rawCredential as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'secret,serverHost,username' ||
      typeof record['secret'] !== 'string' ||
      typeof record['serverHost'] !== 'string' ||
      typeof record['username'] !== 'string'
    ) {
      throw new Error('Every bot credential requires only secret, serverHost, and username');
    }
    const secret = decodeCanonicalKey(record['secret']);
    if (!secret) {
      throw new Error('Every bot secret must be exactly 32 random bytes in canonical base64');
    }
    const serverHost = record['serverHost'].toLowerCase().replace(/\.$/, '');
    if (
      !MINECRAFT_HOST_PATTERN.test(record['serverHost']) ||
      !serverHost ||
      !MINECRAFT_USERNAME_PATTERN.test(record['username'])
    ) {
      throw new Error('Every bot credential requires a valid expected server host and username');
    }
    if (credentials.has(botId)) throw new Error('BOT_CREDENTIALS_JSON contains a duplicate bot UUID');
    credentials.set(
      botId,
      Object.freeze({ secret, serverHost, username: record['username'] }),
    );
  }
  return credentials;
}

function parseAdminTotpSecrets(value: string): ReadonlyMap<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ADMIN_TOTP_SECRETS_JSON must be valid JSON');
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('ADMIN_TOTP_SECRETS_JSON must map mc: identities to base32 secrets');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 32) throw new Error('ADMIN_TOTP_SECRETS_JSON contains too many admins');
  const secrets = new Map<string, Buffer>();
  for (const [rawIdentity, rawSecret] of entries) {
    const identity = rawIdentity.toLowerCase();
    const secret = typeof rawSecret === 'string' ? decodeCanonicalBase32(rawSecret) : undefined;
    if (!/^mc:[a-f0-9]{32}$/.test(identity) || !secret || secrets.has(identity)) {
      throw new Error('ADMIN_TOTP_SECRETS_JSON contains an invalid identity or secret');
    }
    secrets.set(identity, secret);
  }
  return secrets;
}

function isValidCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (!address || prefix === undefined || rest.length) return false;
  const family = isIP(address);
  if (!family || !/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return Number.isInteger(bits) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

function parseTrustedProxyCidrs(value: string): readonly string[] {
  const cidrs = value
    .split(',')
    .map((cidr) => cidr.trim())
    .filter(Boolean);
  if (!cidrs.length || cidrs.length > 16 || cidrs.some((cidr) => !isValidCidr(cidr))) {
    throw new Error('TRUSTED_PROXY_CIDRS must contain 1-16 valid IPv4 or IPv6 CIDRs');
  }
  return Object.freeze(cidrs);
}

function hasOverlyBroadProxyCidr(value: string): boolean {
  return value
    .split(',')
    .map((cidr) => cidr.trim().split('/'))
    .some(([address, prefix]) => {
      const family = address ? isIP(address) : 0;
      const bits = Number(prefix);
      return (family === 4 && bits < 24) || (family === 6 && bits < 64);
    });
}

function looksLikePlaceholder(value: string): boolean {
  return (
    /replace|change[-_ ]?me|example|placeholder/i.test(value) ||
    new Set(value).size < 12
  );
}

function isExactWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function decodedUrlPassword(value: string): string {
  try {
    return decodeURIComponent(new URL(value).password);
  } catch {
    return '';
  }
}

const positiveBigintString = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAX, 'must fit in a PostgreSQL bigint');

function commaSeparatedValuesAre(value: string, pattern: RegExp): boolean {
  if (value === '') return true;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .every((entry) => entry.length > 0 && pattern.test(entry));
}

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    DATABASE_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith('postgresql://'), {
        message: 'must use postgresql://',
      }),
    DATABASE_SSL: booleanString,
    REDIS_URL: z
      .union([
        z.string().url().refine((value) => /^rediss?:\/\//.test(value), {
          message: 'must use redis:// or rediss://',
        }),
        z.literal(''),
      ])
      .default(''),
    APP_ORIGIN: z.string().url().refine(isExactWebOrigin, {
      message: 'must be an exact HTTP(S) origin without credentials, a path, query, or fragment',
    }),
    COOKIE_SECRET: z.string().min(32),
    DATA_ENCRYPTION_KEY: z.string().refine(
      (value) => decodeCanonicalKey(value) !== undefined,
      'must be exactly 32 random bytes encoded as canonical base64',
    ),
    BOT_CREDENTIALS_JSON: z.string().min(1),
    ADMIN_TOTP_SECRETS_JSON: z.string().default('{}'),
    AUDIT_LOG_HMAC_KEY: z.string().min(32),
    AUDIT_LOG_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .refine((value) => value !== 'legacy-v1', 'legacy-v1 is reserved for migrated audit rows')
      .default('dev-v1'),
    IP_HASH_KEY: z.string().min(32),
    ADMIN_MINECRAFT_IDS: z
      .string()
      .refine(
        (value) => commaSeparatedValuesAre(value, /^mc:[a-f0-9]{32}$/i),
        'must contain comma-separated mc: identities',
      )
      .default(''),
    ALLOWED_COUNTRIES: z
      .string()
      .refine(
        (value) => commaSeparatedValuesAre(value, /^[A-Za-z]{2}$/),
        'must contain comma-separated ISO alpha-2 country codes',
      )
      .default(''),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24),
    HOUSE_EDGE_BPS: z.coerce.number().int().min(0).max(5000).default(500),
    MIN_MULTIPLIER_BPS: z.coerce.number().int().min(10_001).max(1_000_000).default(11_000),
    MAX_MULTIPLIER_BPS: z.coerce.number().int().min(10_002).max(10_000_000).default(1_000_000),
    MAX_WIN_CHANCE_PPM: z.coerce.number().int().min(1).max(1_000_000).default(750_000),
    MAX_DAILY_WAGER_MINOR: positiveBigintString.default('10000000'),
    MINECRAFT_TRANSFERS_ENABLED: booleanString,
    TRUSTED_PROXY_CIDRS: z.string().default('127.0.0.1/32,::1/128'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, context) => {
    if (env.MIN_MULTIPLIER_BPS >= env.MAX_MULTIPLIER_BPS) {
      context.addIssue({
        code: 'custom',
        path: ['MAX_MULTIPLIER_BPS'],
        message: 'must exceed minimum',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.APP_ORIGIN.startsWith('https://')) {
        context.addIssue({
          code: 'custom',
          path: ['APP_ORIGIN'],
          message: 'must use HTTPS in production',
        });
      }
      if (env.AUDIT_LOG_KEY_ID === 'dev-v1') {
        context.addIssue({
          code: 'custom',
          path: ['AUDIT_LOG_KEY_ID'],
          message: 'must identify the deployed audit key in production',
        });
      }
      if (!env.ALLOWED_COUNTRIES.trim()) {
        context.addIssue({
          code: 'custom',
          path: ['ALLOWED_COUNTRIES'],
          message: 'must explicitly allow at least one country in production',
        });
      }
      if (!env.REDIS_URL) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message: 'is required for shared production rate limits',
        });
      }
      if (hasOverlyBroadProxyCidr(env.TRUSTED_PROXY_CIDRS)) {
        context.addIssue({
          code: 'custom',
          path: ['TRUSTED_PROXY_CIDRS'],
          message: 'must use narrowly scoped proxy networks in production',
        });
      }
      if (env.MINECRAFT_TRANSFERS_ENABLED) {
        context.addIssue({
          code: 'custom',
          path: ['MINECRAFT_TRANSFERS_ENABLED'],
          message: 'cannot be enabled while the bundled transfer adapter is disabled',
        });
      }
      const databasePassword = decodedUrlPassword(env.DATABASE_URL);
      if (databasePassword.length < 24 || looksLikePlaceholder(databasePassword)) {
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: 'must contain a strong database password of at least 24 characters',
        });
      }
      const redisPassword = decodedUrlPassword(env.REDIS_URL);
      if (redisPassword.length < 24 || looksLikePlaceholder(redisPassword)) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URL'],
          message: 'must contain a strong Redis password of at least 24 characters',
        });
      }
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = environmentSchema.parse(resolveFileBackedSettings(environment));
  const botCredentials = parseBotCredentials(env.BOT_CREDENTIALS_JSON);
  const adminTotpSecrets = parseAdminTotpSecrets(env.ADMIN_TOTP_SECRETS_JSON);
  const trustedProxyCidrs = parseTrustedProxyCidrs(env.TRUSTED_PROXY_CIDRS);
  const normalizeList = (value: string): ReadonlySet<string> =>
    new Set(
      value
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
  const adminMinecraftIds = normalizeList(env.ADMIN_MINECRAFT_IDS);
  if (
    adminMinecraftIds.size !== adminTotpSecrets.size ||
    [...adminMinecraftIds].some((identity) => !adminTotpSecrets.has(identity))
  ) {
    throw new Error('Every configured admin identity requires exactly one TOTP secret');
  }

  if (env.NODE_ENV === 'production') {
    const secrets = [
      ['DATABASE_URL.password', decodedUrlPassword(env.DATABASE_URL)],
      ['REDIS_URL.password', decodedUrlPassword(env.REDIS_URL)],
      ['COOKIE_SECRET', env.COOKIE_SECRET],
      ['DATA_ENCRYPTION_KEY', env.DATA_ENCRYPTION_KEY],
      ['AUDIT_LOG_HMAC_KEY', env.AUDIT_LOG_HMAC_KEY],
      ['IP_HASH_KEY', env.IP_HASH_KEY],
      ...[...botCredentials].map(
        ([botId, credential]) =>
          [`BOT_CREDENTIALS_JSON.${botId}`, credential.secret.toString('base64')] as const,
      ),
      ...[...adminTotpSecrets].map(
        ([identity, secret]) =>
          [`ADMIN_TOTP_SECRETS_JSON.${identity}`, secret.toString('base64')] as const,
      ),
    ] as const;
    for (const [name, value] of secrets) {
      if (looksLikePlaceholder(value)) throw new Error(`${name} must be a strong generated secret`);
    }
    if (new Set(secrets.map(([, value]) => value)).size !== secrets.length) {
      throw new Error('Database, Redis, cookie, encryption, audit, IP hashing, bot, and MFA secrets must all be distinct');
    }
  }

  return Object.freeze({
    environment: env.NODE_ENV,
    host: env['HOST'],
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: env.DATABASE_SSL,
    redisUrl: env.REDIS_URL || undefined,
    appOrigin: new URL(env.APP_ORIGIN).origin,
    cookieSecret: env.COOKIE_SECRET,
    dataEncryptionKey: decodeCanonicalKey(env.DATA_ENCRYPTION_KEY)!,
    botCredentials,
    auditLogHmacKey: env.AUDIT_LOG_HMAC_KEY,
    auditLogKeyId: env.AUDIT_LOG_KEY_ID,
    ipHashKey: env.IP_HASH_KEY,
    adminMinecraftIds,
    adminTotpSecrets,
    allowedCountries: normalizeList(env.ALLOWED_COUNTRIES),
    sessionTtlHours: env.SESSION_TTL_HOURS,
    houseEdgeBps: env.HOUSE_EDGE_BPS,
    minMultiplierBps: env.MIN_MULTIPLIER_BPS,
    maxMultiplierBps: env.MAX_MULTIPLIER_BPS,
    maxWinChancePpm: env.MAX_WIN_CHANCE_PPM,
    maxDailyWagerMinor: BigInt(env.MAX_DAILY_WAGER_MINOR),
    minecraftTransfersEnabled: env.MINECRAFT_TRANSFERS_ENABLED,
    trustedProxyCidrs,
    logLevel: env.LOG_LEVEL,
    secureCookies: env.NODE_ENV === 'production',
  });
}
