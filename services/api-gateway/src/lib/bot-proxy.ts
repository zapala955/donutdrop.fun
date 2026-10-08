import { isIP } from 'node:net';
import { z } from 'zod';
import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * A proxy a bot reaches DonutSMP through, one per bot (migration 060).
 *
 * The password is stored encrypted and bound to the bot it was saved for, so a ciphertext copied
 * onto another bot's row does not decrypt. It leaves the gateway in exactly one place: the signed
 * reply to the bot that owns it, which needs it to log in. The console only ever learns whether
 * one is saved.
 */

/* A DNS hostname, lower-cased, or an IP literal. Nothing else is handed to the bot's socket code. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const proxyInputSchema = z
  .object({
    type: z.enum(['socks5', 'http']),
    host: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .refine((host) => isIP(host) !== 0 || HOSTNAME.test(host), 'must be a hostname or IP address'),
    port: z.number().int().min(1).max(65_535),
    // Printable ASCII and bounded at 255, which is SOCKS5's limit for both fields (RFC 1929).
    username: z
      .string()
      .regex(/^[\x21-\x7e]{1,255}$/)
      .nullable()
      .default(null),
    password: z
      .string()
      .regex(/^[\x20-\x7e]{1,255}$/)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((proxy, context) => {
    if (proxy.password !== null && proxy.username === null) {
      context.addIssue({ code: 'custom', path: ['password'], message: 'a password needs a username' });
    }
    // HTTP Basic credentials are `username:password`, so the first colon ends the username.
    if (proxy.type === 'http' && proxy.username?.includes(':')) {
      context.addIssue({
        code: 'custom',
        path: ['username'],
        message: 'an HTTP proxy username cannot contain a colon',
      });
    }
  });

export type ProxyInput = z.infer<typeof proxyInputSchema>;

export interface BotProxyColumns {
  proxy_type: string | null;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  proxy_password_encrypted: string | null;
  proxy_revision: string | null;
  proxy_updated_at: Date | null;
}

/** The encryption context, so a password only ever decrypts for the bot it was saved for. */
function passwordContext(botId: string): string {
  return `bot-proxy:${botId.toLowerCase()}`;
}

export function encryptProxyPassword(password: string, key: Buffer, botId: string): string {
  return encryptSecret(password, key, passwordContext(botId));
}

/**
 * The columns the console's queries select: `proxy_has_password` in place of the ciphertext, so
 * the encrypted password is never in a row that could be spread into a response.
 */
export const PROXY_SUMMARY_COLUMNS = `b.proxy_type, b.proxy_host, b.proxy_port, b.proxy_username,
  (b.proxy_password_encrypted IS NOT NULL) AS proxy_has_password,
  b.proxy_revision, b.proxy_updated_at, b.connected_proxy_revision`;

export interface BotProxySummaryColumns {
  proxy_type: string | null;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_username: string | null;
  proxy_has_password: boolean;
  proxy_revision: string | null;
  proxy_updated_at: Date | null;
}

/** What the console is shown: everything about the proxy except its password. */
export function describeProxy(row: BotProxySummaryColumns) {
  if (row.proxy_type === null || row.proxy_host === null || row.proxy_port === null) return null;
  return {
    type: row.proxy_type,
    host: row.proxy_host,
    port: row.proxy_port,
    username: row.proxy_username,
    hasPassword: row.proxy_has_password,
    revision: row.proxy_revision,
    updatedAt: row.proxy_updated_at,
  };
}

/** What the bot is sent: the whole proxy, password decrypted, or null for a direct connection. */
export function proxyForBot(row: BotProxyColumns, key: Buffer, botId: string) {
  if (
    row.proxy_type === null ||
    row.proxy_host === null ||
    row.proxy_port === null ||
    row.proxy_revision === null
  ) {
    return null;
  }
  return {
    revision: row.proxy_revision,
    type: row.proxy_type,
    host: row.proxy_host,
    port: row.proxy_port,
    username: row.proxy_username,
    password:
      row.proxy_password_encrypted === null
        ? null
        : decryptSecret(row.proxy_password_encrypted, key, passwordContext(botId)),
  };
}
