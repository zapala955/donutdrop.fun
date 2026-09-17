import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

/**
 * config.ts — what the bot is allowed to know.
 *
 * The list of things NOT here is the interesting part: no database URL, no cookie secret, no admin
 * allowlist, no TOTP secrets. This process cannot read the ledger, cannot mint a session and
 * cannot decide who is an administrator. It holds a Discord token and one HMAC key, and everything
 * else it wants it must ask the gateway for, over a signed request the gateway independently
 * authorises.
 *
 * That is deliberate. A bot has to sit on a socket to a third party it does not control, so it is
 * the component most likely to be reached — and the blast radius of reaching it should be "can ask
 * the API questions on behalf of a real operator", not "is the platform".
 */

const MAX_SECRET_BYTES = 4096;

function readSecretFile(path: string, setting: string): string {
  let descriptor: number | undefined;
  let value: string;
  try {
    descriptor = openSync(path, 'r');
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_SECRET_BYTES) {
      throw new Error('secret file is not a bounded regular file');
    }
    const bytes = Buffer.allocUnsafe(MAX_SECRET_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SECRET_BYTES) throw new Error('secret file is too large');
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

/** Secrets may arrive as `X` or as `X_FILE` pointing at a mounted file, never both. */
function resolve(setting: string): string | undefined {
  const direct = process.env[setting];
  const file = process.env[`${setting}_FILE`];
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Set either ${setting} or ${setting}_FILE, not both`);
  }
  if (file !== undefined) return readSecretFile(file, setting);
  return direct;
}

const schema = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(16),
    DISCORD_APPLICATION_ID: z.string().regex(/^[0-9]{5,32}$/),
    DISCORD_GUILD_ID: z.string().regex(/^[0-9]{5,32}$/),
    /* Shared with the gateway. Every outbound request is signed with it; it is the bot's entire
     * identity as far as the API is concerned. */
    DISCORD_CONTROL_HMAC_KEY: z.string().min(32),
    /* The gateway's internal base URL. Must not be public: these routes are signature-gated, not
     * session-gated, and there is no reason for the open internet to be able to reach them. */
    API_INTERNAL_BASE_URL: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//.test(value), 'must be an HTTP(S) URL'),
    /* Where operational alerts are posted. Empty disables the alert feed entirely. */
    DISCORD_ALERT_CHANNEL_ID: z
      .string()
      .regex(/^$|^[0-9]{5,32}$/)
      .default(''),
    ALERT_POLL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(8_000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .strict();

export type BotConfig = Readonly<z.infer<typeof schema>> & {
  readonly alertsEnabled: boolean;
};

export function loadConfig(): BotConfig {
  const parsed = schema.safeParse({
    DISCORD_BOT_TOKEN: resolve('DISCORD_BOT_TOKEN'),
    DISCORD_APPLICATION_ID: process.env['DISCORD_APPLICATION_ID'],
    DISCORD_GUILD_ID: process.env['DISCORD_GUILD_ID'],
    DISCORD_CONTROL_HMAC_KEY: resolve('DISCORD_CONTROL_HMAC_KEY'),
    API_INTERNAL_BASE_URL: process.env['API_INTERNAL_BASE_URL'],
    DISCORD_ALERT_CHANNEL_ID: process.env['DISCORD_ALERT_CHANNEL_ID'],
    ALERT_POLL_SECONDS: process.env['ALERT_POLL_SECONDS'],
    REQUEST_TIMEOUT_MS: process.env['REQUEST_TIMEOUT_MS'],
    LOG_LEVEL: process.env['LOG_LEVEL'],
  });
  if (!parsed.success) {
    /* Field paths only. The values are the token and the HMAC key, and a crash log is a file that
     * gets pasted into a chat window by somebody asking for help. */
    const paths = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid Discord bot configuration: ${paths}`);
  }
  return { ...parsed.data, alertsEnabled: parsed.data.DISCORD_ALERT_CHANNEL_ID !== '' };
}
