import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import process from 'node:process';
import { z } from 'zod';

/**
 * config.ts — everything this process is allowed to know.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS BOT IS NOT THE CONTROL PLANE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * services/discord-bot runs in a private guild, answers only ephemerally and can mint a link
 * straight into the admin dashboard. This one lives in the PUBLIC server, where anybody can type
 * at it. They are separate processes with separate tokens for that reason alone: a community bot
 * that shares a token with the operator bot turns every member of the public server into somebody
 * who is one bug away from the console.
 *
 * The only platform capability here is a player lookup, and it is signed with its own key.
 */

const MAX_SECRET_BYTES = 8 * 1024;

/* Read a secret from a file rather than from the environment, the same way every other service
 * here does. An environment variable is visible in `docker inspect`, in a crash dump and to every
 * child process; a file is not. */
function readSecretFile(path: string, setting: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_SECRET_BYTES) {
      throw new Error('secret file is not a bounded regular file');
    }
    const bytes = Buffer.allocUnsafe(MAX_SECRET_BYTES + 1);
    let offset = 0;
    for (;;) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const value = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes.subarray(0, offset))
      .replace(/\r?\n$/, '');
    if (!value || /[\r\n\0]/.test(value)) {
      throw new Error('must contain exactly one non-empty line');
    }
    return value;
  } catch (error) {
    throw new Error(`Unable to read ${setting}`, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const snowflake = z.string().regex(/^[0-9]{5,32}$/, 'must be a Discord snowflake');

const schema = z.object({
  COMMUNITY_BOT_TOKEN_FILE: z.string().min(1),
  COMMUNITY_APPLICATION_ID: snowflake,
  /* The one server this bot serves. Every command checks it.
   *
   * Without this an invite link posted anywhere would let a stranger add the bot to their own
   * server, where it would happily open tickets and read this database. The guild is pinned so
   * that being added somewhere else achieves nothing. */
  COMMUNITY_GUILD_ID: snowflake,
  DATABASE_URL_FILE: z.string().min(1),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /* The platform lookup. Optional: without it every site-linked command reports itself as
   * unavailable and the rest of the bot runs untouched, which is what makes this feature
   * something a deployment can simply not switch on. */
  API_INTERNAL_URL: z.string().url().optional(),
  COMMUNITY_API_SECRET_FILE: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface CommunityConfig {
  readonly token: string;
  readonly applicationId: string;
  readonly guildId: string;
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
  readonly apiInternalUrl: string | undefined;
  readonly apiSecret: string | undefined;
  readonly logLevel: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): CommunityConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid community bot configuration — ${issues}`);
  }
  const env = parsed.data;

  /* Both or neither. A URL with no key would sign nothing and be rejected on arrival; a key with
   * no URL is a secret held for no reason. Failing here beats discovering it on the first lookup
   * somebody actually needed. */
  const wantsApi = Boolean(env.API_INTERNAL_URL) || Boolean(env.COMMUNITY_API_SECRET_FILE);
  if (wantsApi && !(env.API_INTERNAL_URL && env.COMMUNITY_API_SECRET_FILE)) {
    throw new Error(
      'API_INTERNAL_URL and COMMUNITY_API_SECRET_FILE must be set together, or not at all',
    );
  }

  return Object.freeze({
    token: readSecretFile(env.COMMUNITY_BOT_TOKEN_FILE, 'COMMUNITY_BOT_TOKEN_FILE'),
    applicationId: env.COMMUNITY_APPLICATION_ID,
    guildId: env.COMMUNITY_GUILD_ID,
    databaseUrl: readSecretFile(env.DATABASE_URL_FILE, 'DATABASE_URL_FILE'),
    databaseSsl: env.DATABASE_SSL,
    apiInternalUrl: env.API_INTERNAL_URL,
    apiSecret: env.COMMUNITY_API_SECRET_FILE
      ? readSecretFile(env.COMMUNITY_API_SECRET_FILE, 'COMMUNITY_API_SECRET_FILE')
      : undefined,
    logLevel: env.LOG_LEVEL,
  });
}
