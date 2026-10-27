import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database, DbClient } from './db.js';
import { hmacHex, safeEqualText } from './crypto.js';
import { AppError, conflict } from './errors.js';

/**
 * Six-digit codes sent by email (migration 079): to link an email, to sign in with it, to remove
 * it, and to confirm a withdrawal to a different Minecraft name.
 *
 * Only an HMAC of the code is stored, keyed with a server secret and the row's own id, so a leaked
 * table is not a list of live codes. A code works once, for ten minutes, for five tries; asking
 * for a new one retires the one before. Sending is throttled per account and purpose (one a minute,
 * five an hour), on top of each route's per-address rate limit.
 */

export type CodePurpose = 'link' | 'login' | 'remove' | 'withdraw';

export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
const RESEND_AFTER_SECONDS = 60;
const MAX_PER_HOUR = 5;
/** How long a newly linked email must be on the account before it can send money to another name. */
export const EMAIL_PAYOUT_WAIT_HOURS = 24;

export const CODE_PATTERN = /^[0-9]{6}$/;

type Client = Pick<DbClient, 'query'>;

/** Lower-cased and trimmed, or null when it does not look like an address. */
export function normalizeEmail(input: string): string | null {
  const email = input.normalize('NFC').trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  // Control characters, quotes and angle brackets have no place in an address a player types.
  if (/[\u0000-\u001f\u007f<>"'`\\]/.test(email)) return null;
  return email;
}

/** "n•••@gmail.com": enough to recognise one's own address, not enough to harvest it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}•••@${email.slice(at + 1)}`;
}

function hashCode(config: AppConfig, id: string, code: string): string {
  return hmacHex(config.ipHashKey, `email-code:${id}:${code}`);
}

/**
 * Makes a code and stores its hash. Returns the code itself, for the mail, and nothing else ever
 * sees it. Throws a 429 the player can read when they ask too often.
 */
export async function issueCode(
  client: Client,
  config: AppConfig,
  input: {
    purpose: CodePurpose;
    userId: string;
    email: string;
    browserTokenHash?: string;
    payeeUsername?: string;
    amountMinor?: bigint;
  },
): Promise<string> {
  const recent = await client.query<{ last_seconds: number | null; n: string }>(
    `SELECT EXTRACT(EPOCH FROM (now() - max(created_at)))::int AS last_seconds,
            count(*)::text AS n
       FROM email_codes
      WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'`,
    [input.userId, input.purpose],
  );
  const last = recent.rows[0]?.last_seconds;
  if (last !== null && last !== undefined && last < RESEND_AFTER_SECONDS) {
    const wait = RESEND_AFTER_SECONDS - last;
    throw new AppError(
      429,
      'EMAIL_CODE_TOO_SOON',
      `Wait ${wait} seconds before asking for another code`,
      {
        retryAfterSeconds: wait,
      },
    );
  }
  if (Number(recent.rows[0]?.n ?? 0) >= MAX_PER_HOUR) {
    throw new AppError(429, 'EMAIL_CODE_LIMIT', 'Too many codes this hour. Try again later');
  }

  // One live code per account and purpose: a new one retires the last.
  await client.query(
    `UPDATE email_codes SET consumed_at = now()
      WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [input.userId, input.purpose],
  );
  await client.query("DELETE FROM email_codes WHERE expires_at < now() - interval '1 day'");

  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await client.query(
    `INSERT INTO email_codes
       (id, purpose, user_id, email, code_hash, browser_token_hash, payee_username, amount_minor,
        expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9::int * interval '1 minute'))`,
    [
      id,
      input.purpose,
      input.userId,
      input.email,
      hashCode(config, id, code),
      input.browserTokenHash ?? null,
      input.payeeUsername ?? null,
      input.amountMinor?.toString() ?? null,
      CODE_TTL_MINUTES,
    ],
  );
  return code;
}

export interface CheckedCode {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
}

/**
 * Checks a typed code against the live code that matches `where`, in a transaction of its own.
 *
 * A wrong code costs one of the five tries, and that cost is committed: checking inside the
 * caller's transaction would roll the counter back with whatever failed next, and an attacker could
 * guess forever. A right code is NOT spent here; the caller spends it with `spendCode` in the same
 * transaction as the thing it unlocks, so a refused withdrawal leaves the code usable.
 *
 * Every failure reads the same to the player ("wrong or expired"): which one it was is not theirs
 * to probe.
 */
export async function checkCode(
  db: Database,
  config: AppConfig,
  where: {
    purpose: CodePurpose;
    userId?: string;
    browserTokenHash?: string;
    payeeUsername?: string;
    amountMinor?: bigint;
  },
  code: string,
): Promise<CheckedCode> {
  if (!CODE_PATTERN.test(code)) throw invalidCode();
  const outcome = await db.transaction(async (client) => {
    const found = await client.query<{
      id: string;
      user_id: string;
      email: string;
      code_hash: string;
      attempts: number;
    }>(
      `SELECT id, user_id, email, code_hash, attempts
         FROM email_codes
        WHERE purpose = $1
          AND ($2::uuid IS NULL OR user_id = $2)
          AND ($3::text IS NULL OR browser_token_hash = $3)
          AND ($4::text IS NULL OR lower(payee_username) = lower($4))
          AND ($5::bigint IS NULL OR amount_minor = $5)
          AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [
        where.purpose,
        where.userId ?? null,
        where.browserTokenHash ?? null,
        where.payeeUsername ?? null,
        where.amountMinor?.toString() ?? null,
      ],
    );
    const row = found.rows[0];
    if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false as const };
    if (!safeEqualText(hashCode(config, row.id, code), row.code_hash)) {
      await client.query('UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return { ok: false as const };
    }
    return { ok: true as const, checked: { id: row.id, userId: row.user_id, email: row.email } };
  });
  if (!outcome.ok) throw invalidCode();
  return outcome.checked;
}

/** Spends a checked code, inside the transaction it unlocks. Twice is a conflict, never a second use. */
export async function spendCode(client: Client, id: string): Promise<void> {
  const spent = await client.query(
    'UPDATE email_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
    [id],
  );
  if (!spent.rowCount) conflict('EMAIL_CODE_USED', 'That code was already used. Ask for a new one');
}

function invalidCode(): AppError {
  return new AppError(400, 'EMAIL_CODE_INVALID', 'That code is wrong or has expired');
}
