import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database, DbClient } from './db.js';
import { AppError } from './errors.js';
import { hmacHex, safeEqualBuffer } from './crypto.js';

/**
 * Email: sending through Resend, the daily cap, and one-time codes (2026-11-10).
 *
 * THE DAILY CAP. The Resend plan sends a fixed number of emails a day (100 on the free plan). Every
 * email the site sends is a row in email_sends, and before one goes out the rows of the last 24
 * hours are counted under a lock; at the cap the request is refused with EMAIL_DAILY_LIMIT and the
 * email features say so, instead of the provider refusing a sign-in code half way through. A
 * rolling 24 hours rather than a calendar day, so it is never more generous than the provider
 * however the provider counts its day.
 *
 * CODES. Six digits, ten minutes, five tries, single use; only an HMAC of the code is stored, keyed
 * with the server's IP-hash key and bound to the row. Asking for a new code retires the old one.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 10_000;
export const CODE_TTL_MINUTES = 10;
export const CODE_MAX_ATTEMPTS = 5;
/** A second code for the same address and purpose only after this long. */
export const CODE_COOLDOWN_SECONDS = 60;
/** At most this many codes to one address in an hour, whoever asks. */
const CODES_PER_ADDRESS_PER_HOUR = 5;

export type CodePurpose = 'link' | 'login' | 'confirm';
export type SendPurpose = CodePurpose | 'notice';

/** What the address field accepts: an ordinary address, at most 254 characters. */
export const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** j***@gmail.com: enough to recognise an address, not enough to read it off a screen. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

/* ═════════════════════════ the daily cap ═════════════════════════ */

/* Counted: everything sent or still sending. A send that failed with an answer from the provider was
 * not sent; one that failed without an answer (a timeout) may have been, so it counts. */
async function sentInLastDay(client: DbClient): Promise<number> {
  const result = await client.query<{ sent: string }>(
    `SELECT count(*)::text AS sent FROM email_sends
      WHERE created_at > now() - interval '24 hours'
        AND (status <> 'failed' OR error_code = 'NETWORK')`,
  );
  return Number(result.rows[0]?.sent ?? 0);
}

/** Whether email is switched on, and whether today's allowance has any left. */
export async function emailAvailability(
  db: DbClient,
  config: AppConfig,
): Promise<{ enabled: boolean; available: boolean }> {
  if (!config.emailEnabled) return { enabled: false, available: false };
  return { enabled: true, available: (await sentInLastDay(db)) < config.emailDailyLimit };
}

export function emailDailyLimitReached(): AppError {
  return new AppError(
    503,
    'EMAIL_DAILY_LIMIT',
    'Email is paused for today: the daily email limit has been reached. Try again tomorrow.',
  );
}

/* Reserves one of the day's sends. READ COMMITTED on its own connection, not Database.transaction:
 * a SERIALIZABLE snapshot is taken before the lock wait, so two requests queued on the lock would
 * both count the rows from before either of them, and the cap could be passed by however many
 * arrived at once. Here the count runs after the lock is held and sees every committed send. */
async function reserveSend(
  db: Database,
  config: AppConfig,
  purpose: SendPurpose,
  userId: string | null,
): Promise<string> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('email-daily-quota', 0))");
    if ((await sentInLastDay(client)) >= config.emailDailyLimit) {
      await client.query('ROLLBACK');
      throw emailDailyLimitReached();
    }
    const id = randomUUID();
    await client.query('INSERT INTO email_sends (id, purpose, user_id) VALUES ($1, $2, $3)', [
      id,
      purpose,
      userId,
    ]);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  purpose: SendPurpose;
  userId: string | null;
}

/** Sends one email, within the day's allowance. Throws if it was not accepted by the provider. */
export async function sendEmail(db: Database, config: AppConfig, email: OutgoingEmail): Promise<void> {
  if (!config.emailEnabled) {
    throw new AppError(503, 'EMAIL_DISABLED', 'Email is not available right now');
  }
  const sendId = await reserveSend(db, config, email.purpose, email.userId);
  let errorCode: string | null = null;
  try {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
        // A retried request is the same email, not a second one.
        'idempotency-key': sendId,
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) errorCode = `HTTP_${response.status}`;
    await response.text().catch(() => '');
  } catch {
    errorCode = 'NETWORK';
  }
  await db.query(
    `UPDATE email_sends SET status = $2, error_code = $3, finished_at = now() WHERE id = $1`,
    [sendId, errorCode ? 'failed' : 'sent', errorCode],
  );
  if (errorCode) {
    throw new AppError(502, 'EMAIL_SEND_FAILED', 'The email could not be sent. Try again in a minute.');
  }
}

/* ═════════════════════════ one-time codes ═════════════════════════ */

function codeHash(config: AppConfig, codeId: string, code: string): Buffer {
  return Buffer.from(hmacHex(config.ipHashKey, `email-code:${codeId}:${code}`), 'hex');
}

/**
 * A new code for this address and purpose, retiring any earlier one. Refused while the previous
 * code is under a minute old, and past five codes to one address in an hour.
 */
export async function createCode(
  client: DbClient,
  config: AppConfig,
  input: { purpose: CodePurpose; email: string; userId: string | null; ipHash: Buffer | null },
): Promise<{ id: string; code: string }> {
  const recent = await client.query<{ last_seconds: number | null; hour_count: string }>(
    `SELECT EXTRACT(EPOCH FROM (now() - max(created_at) FILTER (WHERE purpose = $2)))::int AS last_seconds,
            count(*)::text AS hour_count
       FROM email_codes
      WHERE email = $1 AND created_at > now() - interval '1 hour'`,
    [input.email, input.purpose],
  );
  const last = recent.rows[0]?.last_seconds;
  if (last !== null && last !== undefined && last < CODE_COOLDOWN_SECONDS) {
    const retryAfterSeconds = CODE_COOLDOWN_SECONDS - last;
    throw new AppError(
      429,
      'EMAIL_CODE_COOLDOWN',
      `A code was just sent. Wait ${retryAfterSeconds} seconds before asking for another.`,
      { retryAfterSeconds },
    );
  }
  if (Number(recent.rows[0]?.hour_count ?? 0) >= CODES_PER_ADDRESS_PER_HOUR) {
    throw new AppError(429, 'EMAIL_CODE_LIMIT', 'Too many codes for this address. Try again in an hour.');
  }
  await client.query(
    `UPDATE email_codes SET consumed_at = now()
      WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [input.email, input.purpose],
  );
  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await client.query(
    `INSERT INTO email_codes (id, purpose, user_id, email, code_hash, expires_at, ip_hash)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), $7)`,
    [id, input.purpose, input.userId, input.email, codeHash(config, id, code), CODE_TTL_MINUTES, input.ipHash],
  );
  return { id, code };
}

export type CodeCheck = { ok: true; codeId: string } | { ok: false; error: AppError };

export function invalidCode(): AppError {
  return new AppError(400, 'EMAIL_CODE_INVALID', 'That code is wrong or has expired. Ask for a new one.');
}

/**
 * Checks a code inside the caller's transaction. A wrong code spends one of its five tries and is
 * returned as a result, never thrown: throwing would roll the spent try back with the transaction,
 * and the cap would never bind. The caller commits, then throws. A right code is consumed here, in
 * the same transaction as whatever it authorises.
 */
export async function checkCode(
  client: DbClient,
  config: AppConfig,
  input: { purpose: CodePurpose; email: string; userId: string | null; code: string },
): Promise<CodeCheck> {
  const found = await client.query<{ id: string; code_hash: Buffer; attempts: number }>(
    `SELECT id, code_hash, attempts FROM email_codes
      WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
        AND user_id IS NOT DISTINCT FROM $3
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [input.email, input.purpose, input.userId],
  );
  const row = found.rows[0];
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return { ok: false, error: invalidCode() };
  const right = /^\d{6}$/.test(input.code) && safeEqualBuffer(codeHash(config, row.id, input.code), row.code_hash);
  if (!right) {
    await client.query(
      `UPDATE email_codes SET attempts = attempts + 1,
              consumed_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE consumed_at END
        WHERE id = $1`,
      [row.id, CODE_MAX_ATTEMPTS],
    );
    return { ok: false, error: invalidCode() };
  }
  await client.query('UPDATE email_codes SET consumed_at = now() WHERE id = $1', [row.id]);
  return { ok: true, codeId: row.id };
}

/* ═════════════════════════ what the emails say ═════════════════════════ */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/* One plain layout: light background (most mail clients render a dark one badly), the gold of the
 * site as the only colour, and the code large and easy to copy. Every email has a text part too. */
function layout(title: string, lines: string[], code?: string): string {
  const body = lines.map((line) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#2b2b30">${escapeHtml(line)}</p>`).join('');
  const block = code
    ? `<p style="margin:6px 0 18px;font:700 32px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:6px;color:#121216">${escapeHtml(code)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f2ee;font-family:Arial,Helvetica,sans-serif">`
    + `<div style="max-width:480px;margin:0 auto;padding:28px;background:#ffffff;border-radius:8px;border-top:4px solid #e3a13a">`
    + `<p style="margin:0 0 18px;font:800 18px/1 Arial,Helvetica,sans-serif;color:#121216">DonutLuxe</p>`
    + `<h1 style="margin:0 0 14px;font-size:20px;color:#121216">${escapeHtml(title)}</h1>${block}${body}`
    + `<p style="margin:18px 0 0;font-size:12px;color:#8a8a92">You are receiving this because this address was entered on donutluxe.com.</p>`
    + `</div></body></html>`;
}

export function codeEmail(
  purpose: CodePurpose,
  code: string,
  minecraftUsername: string | null,
  action?: string,
): { subject: string; text: string; html: string } {
  const minutes = `It works for ${CODE_TTL_MINUTES} minutes.`;
  if (purpose === 'login') {
    const lines = [minutes, 'If you did not ask to sign in, ignore this email: nobody can sign in without this code.'];
    return {
      subject: `${code} is your DonutLuxe sign-in code`,
      text: `Your DonutLuxe sign-in code is ${code}.\n\n${lines.join('\n')}`,
      html: layout('Your sign-in code', lines, code),
    };
  }
  if (purpose === 'link') {
    const lines = [
      `Enter it on DonutLuxe to link this email to ${minecraftUsername ?? 'your account'}. ${minutes}`,
      'If you did not ask for this, ignore this email and nothing will be linked.',
    ];
    return {
      subject: `${code} is your DonutLuxe email code`,
      text: `Your DonutLuxe email code is ${code}.\n\n${lines.join('\n')}`,
      html: layout('Link your email', lines, code),
    };
  }
  const lines = [
    `Enter it on DonutLuxe to confirm: ${action ?? 'a change to your account'}. ${minutes}`,
    'If you did not ask for this, do not share the code with anyone. Without it nothing changes.',
  ];
  return {
    subject: `${code} is your DonutLuxe confirmation code`,
    text: `Your DonutLuxe confirmation code is ${code}.\n\n${lines.join('\n')}`,
    html: layout('Confirm a change', lines, code),
  };
}

export function noticeEmail(title: string, lines: string[]): { subject: string; text: string; html: string } {
  return { subject: `DonutLuxe: ${title}`, text: `${title}\n\n${lines.join('\n')}`, html: layout(title, lines) };
}
