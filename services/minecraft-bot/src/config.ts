import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

function readSecretFile(path: string): string {
  let descriptor: number | undefined;
  let value: string;
  try {
    descriptor = openSync(path, 'r');
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 256) throw new Error('secret file is not bounded');
    const bytes = Buffer.allocUnsafe(257);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 256) throw new Error('secret file is too large');
    value = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(0, offset))
      .replace(/\r?\n$/, '');
  } catch (error) {
    throw new Error('Unable to read BOT_WEBHOOK_SECRET_FILE', { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!value || /[\r\n\0]/.test(value)) {
    throw new Error('BOT_WEBHOOK_SECRET_FILE must contain exactly one non-empty line');
  }
  return value;
}

function isCanonicalKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    MINECRAFT_HOST: z.string().min(1).max(255),
    MINECRAFT_PORT: z.coerce.number().int().min(1).max(65_535).default(25_565),
    MINECRAFT_VERSION: z.string().default('false'),
    MINECRAFT_AUTH: z.enum(['microsoft', 'offline']).default('microsoft'),
    MINECRAFT_USERNAME: z.string().min(3).max(254),
    MINECRAFT_EXPECTED_USERNAME: z.string().regex(/^[A-Za-z0-9_]{3,16}$/),
    MINECRAFT_PROFILES_FOLDER: z.string().min(1),
    BOT_ID: z.uuid(),
    API_INTERNAL_URL: z.url(),
    BOT_WEBHOOK_SECRET: z.string().refine(isCanonicalKey, {
      message: 'must be exactly 32 random bytes encoded as canonical base64',
    }),
    BOT_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(2000),
    BOT_TRANSFERS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === 'production' && env.MINECRAFT_AUTH !== 'microsoft') {
      context.addIssue({
        code: 'custom',
        path: ['MINECRAFT_AUTH'],
        message: 'must use Microsoft authentication in production',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      (/replace|change[-_ ]?me|example|placeholder/i.test(env.BOT_WEBHOOK_SECRET) ||
        new Set(env.BOT_WEBHOOK_SECRET).size < 12)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['BOT_WEBHOOK_SECRET'],
        message: 'must be a strong generated secret',
      });
    }
    let apiUrl: URL | undefined;
    try {
      apiUrl = new URL(env.API_INTERNAL_URL);
    } catch {
      // The base schema reports the URL error.
    }
    if (
      apiUrl &&
      (apiUrl.pathname.replace(/\/$/, '') !== '/internal/v1/minecraft' ||
        apiUrl.username ||
        apiUrl.password ||
        apiUrl.search ||
        apiUrl.hash)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['API_INTERNAL_URL'],
        message: 'must point exactly to the internal Minecraft API without credentials or a query',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      apiUrl &&
      (apiUrl.protocol !== 'http:' || apiUrl.hostname !== 'api' || apiUrl.port !== '3001')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['API_INTERNAL_URL'],
        message: 'must use the isolated Compose API service in production',
      });
    }
    if (env.NODE_ENV === 'production' && !path.isAbsolute(env.MINECRAFT_PROFILES_FOLDER)) {
      context.addIssue({
        code: 'custom',
        path: ['MINECRAFT_PROFILES_FOLDER'],
        message: 'must be an absolute protected path in production',
      });
    }
  });

export type BotConfig = ReturnType<typeof loadBotConfig>;

export function loadBotConfig(environment: NodeJS.ProcessEnv = process.env) {
  const resolved = { ...environment };
  const hasDirectSecret = resolved['BOT_WEBHOOK_SECRET'] !== undefined;
  const secretFile = resolved['BOT_WEBHOOK_SECRET_FILE'];
  const hasSecretFile = secretFile !== undefined;
  if (hasDirectSecret && hasSecretFile) {
    throw new Error('BOT_WEBHOOK_SECRET and BOT_WEBHOOK_SECRET_FILE are mutually exclusive');
  }
  if (!hasDirectSecret && secretFile !== undefined) {
    resolved['BOT_WEBHOOK_SECRET'] = readSecretFile(secretFile);
  }
  const env = schema.parse(resolved);
  if (env.NODE_ENV === 'production') {
    try {
      const stats = lstatSync(env.MINECRAFT_PROFILES_FOLDER);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('path is not a real directory');
      }
      accessSync(env.MINECRAFT_PROFILES_FOLDER, constants.R_OK | constants.W_OK | constants.X_OK);
      if (process.platform !== 'win32') {
        if (
          realpathSync(env.MINECRAFT_PROFILES_FOLDER) !==
          path.resolve(env.MINECRAFT_PROFILES_FOLDER)
        ) {
          throw new Error('path contains a symbolic link');
        }
        if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
          throw new Error('directory is not owned by the bot runtime user');
        }
        if ((stats.mode & 0o077) !== 0) {
          throw new Error('directory grants group or other access');
        }
      }
    } catch (error) {
      throw new Error('MINECRAFT_PROFILES_FOLDER must be an existing private writable directory', {
        cause: error,
      });
    }
    process.umask(0o077);
  }
  return Object.freeze({
    environment: env.NODE_ENV,
    host: env.MINECRAFT_HOST,
    port: env.MINECRAFT_PORT,
    version: env.MINECRAFT_VERSION === 'false' ? false : env.MINECRAFT_VERSION,
    auth: env.MINECRAFT_AUTH,
    username: env.MINECRAFT_USERNAME,
    expectedUsername: env.MINECRAFT_EXPECTED_USERNAME,
    profilesFolder: env.MINECRAFT_PROFILES_FOLDER,
    botId: env.BOT_ID.toLowerCase(),
    apiInternalUrl: new URL(env.API_INTERNAL_URL).toString().replace(/\/$/, ''),
    webhookSecret: Buffer.from(env.BOT_WEBHOOK_SECRET, 'base64'),
    pollIntervalMs: env.BOT_POLL_INTERVAL_MS,
    transfersEnabled: env.BOT_TRANSFERS_ENABLED,
    logLevel: env.LOG_LEVEL,
  });
}
