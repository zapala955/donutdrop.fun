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

/* The emails wear the site's own skin (assets/css/luxe.css): the #121216 page, a flat #1c1c22 panel
 * with a hairline edge, a #0a0a0c well for the code, and gold only on the one thing to act on. The
 * logo is the live pixel lockup (logo-com.png, 1320x300), whose own background is the page colour,
 * so it sits on the page with no box around it; it is shown at a quarter or a fifth, so its pixels
 * stay whole. Everything is inline and laid out with tables, because Gmail and Outlook
 * drop most of a <style> block; the one <style> only tightens the padding on a phone. Fonts fall
 * back to Segoe UI / Helvetica / Arial where a client will not load Figtree and Archivo.
 * Every email has a plain-text part too. */
const SITE_URL = 'https://donutluxe.com';
const DISCORD_URL = 'https://discord.gg/aHfRsUaGgx';
const LOGO_URL = `${SITE_URL}/assets/img/brand/logo-com.png`;
const MAIL = {
  page: '#121216',
  panel: '#1c1c22',
  well: '#0a0a0c',
  edge: '#2a2a31',
  goldEdge: '#7a5410',
  title: '#ffffff',
  text: '#d1d5db',
  mute: '#9096a0',
  faint: '#757b85',
  gold: '#ffaa00',
  onGold: '#0a0a0c',
} as const;
const UI_FONT = "Figtree,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const DISPLAY_FONT = "Archivo,Figtree,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Detail = readonly [label: string, value: string];
type Email = { subject: string; text: string; html: string };
interface Letter {
  preheader: string;
  title: string;
  intro: string;
  code?: string;
  details: Detail[];
  /** Notices about a change already made end on a gold "Contact staff on Discord" button. */
  help?: boolean;
  note: string;
}

function whenUtc(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

function layout(letter: Letter): string {
  const e = escapeHtml;
  const table = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';
  const code = letter.code
    ? `<tr><td style="padding:24px 0 0">`
      + `<table ${table} style="border-collapse:separate"><tr>`
      + `<td align="center" bgcolor="${MAIL.well}" style="background:${MAIL.well};border:1px solid ${MAIL.goldEdge};border-radius:12px;padding:24px 8px 24px 20px">`
      + `<div class="code" style="font:800 40px/1 ${DISPLAY_FONT};letter-spacing:12px;color:${MAIL.title}">${e(letter.code)}</div>`
      + `</td></tr></table>`
      + `<p style="margin:12px 0 0;font:500 13px/1.4 ${UI_FONT};color:${MAIL.mute};text-align:center">Expires in ${CODE_TTL_MINUTES} minutes and works once</p>`
      + `</td></tr>`
    : '';
  const rows = letter.details.map(([label, value], index) => {
    const line = `border-top:1px solid ${MAIL.edge};${index === letter.details.length - 1 ? `border-bottom:1px solid ${MAIL.edge};` : ''}`;
    return `<tr><td style="${line}padding:12px 12px 12px 0;font:400 14px/1.4 ${UI_FONT};color:${MAIL.mute};white-space:nowrap;vertical-align:top">${e(label)}</td>`
      + `<td align="right" style="${line}padding:12px 0;font:600 14px/1.4 ${UI_FONT};color:${MAIL.title};text-align:right;word-break:break-word">${e(value)}</td></tr>`;
  }).join('');
  const details = rows ? `<tr><td style="padding:24px 0 0"><table ${table} style="border-collapse:collapse">${rows}</table></td></tr>` : '';
  const help = letter.help
    ? `<tr><td style="padding:24px 0 0">`
      + `<p style="margin:0 0 14px;font:400 15px/1.55 ${UI_FONT};color:${MAIL.text}">Wasn't you? Contact staff straight away.</p>`
      + `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td bgcolor="${MAIL.gold}" style="background:${MAIL.gold};border-radius:10px">`
      + `<a href="${DISCORD_URL}" style="display:inline-block;padding:13px 22px;font:700 15px/1 ${UI_FONT};color:${MAIL.onGold};text-decoration:none;border-radius:10px">Contact staff on Discord</a>`
      + `</td></tr></table></td></tr>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">`
    + `<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">`
    + `<title>${e(letter.title)}</title>`
    + `<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&amp;family=Figtree:wght@400;500;600;700&amp;display=swap" rel="stylesheet">`
    + `<style>:root{color-scheme:dark;supported-color-schemes:dark}body{margin:0;padding:0;background:${MAIL.page}}`
    + `@media (max-width:540px){.card{padding:28px 20px!important}.code{font-size:32px!important;letter-spacing:9px!important}.h1{font-size:22px!important}.logo{width:264px!important;height:60px!important}}</style>`
    + `</head><body style="margin:0;padding:0;background:${MAIL.page}" bgcolor="${MAIL.page}">`
    + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${e(letter.preheader)}</div>`
    + `<table ${table} bgcolor="${MAIL.page}" style="background:${MAIL.page}"><tr><td align="center" style="padding:28px 12px 40px">`
    + `<!--[if mso]><table role="presentation" width="520" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`
    + `<table ${table} style="max-width:520px">`
    + `<tr><td align="center" style="padding:0 0 16px"><a href="${SITE_URL}" style="text-decoration:none">`
    + `<img class="logo" src="${LOGO_URL}" width="330" height="75" alt="DonutLuxe" style="display:block;border:0;width:330px;height:75px;image-rendering:pixelated;font:800 22px/75px ${DISPLAY_FONT};color:${MAIL.title};text-align:center"></a></td></tr>`
    + `<tr><td class="card" bgcolor="${MAIL.panel}" style="background:${MAIL.panel};border:1px solid ${MAIL.edge};border-radius:16px;padding:36px 36px 32px">`
    + `<table ${table}>`
    + `<tr><td><h1 class="h1" style="margin:0;font:800 26px/1.2 ${DISPLAY_FONT};color:${MAIL.title}">${e(letter.title)}</h1>`
    + `<p style="margin:10px 0 0;font:400 15px/1.55 ${UI_FONT};color:${MAIL.text}">${e(letter.intro)}</p></td></tr>`
    + code + details + help
    + `<tr><td style="padding:24px 0 0;font:400 13px/1.55 ${UI_FONT};color:${MAIL.mute}">${e(letter.note)}</td></tr>`
    + `</table></td></tr>`
    + `<tr><td align="center" style="padding:22px 12px 0;font:400 12px/1.7 ${UI_FONT};color:${MAIL.faint}">`
    + `<a href="${SITE_URL}" style="color:${MAIL.mute};text-decoration:none">donutluxe.com</a>`
    + `&nbsp;&nbsp;&middot;&nbsp;&nbsp;<a href="${DISCORD_URL}" style="color:${MAIL.mute};text-decoration:none">Discord</a><br>`
    + `You're getting this because this address was entered on donutluxe.com.</td></tr>`
    + `</table><!--[if mso]></td></tr></table><![endif]-->`
    + `</td></tr></table></body></html>`;
}

function plainText(letter: Letter, lead: string): string {
  const details = letter.details.map(([label, value]) => `${label}: ${value}`).join('\n');
  const help = letter.help ? `\n\nWasn't you? Contact staff on Discord straight away: ${DISCORD_URL}` : '';
  return `${lead}\n\n${letter.intro}${details ? `\n\n${details}` : ''}${help}\n\n${letter.note}\n\n${SITE_URL}`;
}

const CODE_LETTERS: Record<CodePurpose, { subject: string; lead: string; title: string; intro: string; note: string }> = {
  login: {
    subject: 'is your DonutLuxe sign-in code',
    lead: 'Your DonutLuxe sign-in code is',
    title: 'Your sign-in code',
    intro: 'Enter this code on DonutLuxe to sign in.',
    note: "Didn't try to sign in? Ignore this email. Nobody can get in without this code, and staff will never ask you for it.",
  },
  link: {
    subject: 'is your DonutLuxe email code',
    lead: 'Your DonutLuxe email code is',
    title: 'Confirm your email',
    intro: 'Enter this code on DonutLuxe to link this email to your account.',
    note: "Didn't ask for this? Ignore this email and nothing will be linked.",
  },
  confirm: {
    subject: 'is your DonutLuxe confirmation code',
    lead: 'Your DonutLuxe confirmation code is',
    title: 'Confirm a change',
    intro: 'Enter this code on DonutLuxe to confirm the change below.',
    note: "Didn't ask for this? Don't share the code with anyone. Without it nothing changes, and staff will never ask you for it.",
  },
};

export function codeEmail(
  purpose: CodePurpose,
  code: string,
  minecraftUsername: string | null,
  action?: string,
): Email {
  const words = CODE_LETTERS[purpose];
  const details: Detail[] = [];
  if (minecraftUsername) details.push(['Account', minecraftUsername]);
  if (purpose === 'confirm') {
    const request = action ?? 'a change to your account';
    details.push(['Request', request.charAt(0).toUpperCase() + request.slice(1)]);
  }
  const letter: Letter = {
    preheader: `Expires in ${CODE_TTL_MINUTES} minutes. Never share it with anyone.`,
    title: words.title,
    intro: words.intro,
    code,
    details,
    note: words.note,
  };
  return {
    subject: `${code} ${words.subject}`,
    text: plainText(letter, `${words.lead} ${code}. It expires in ${CODE_TTL_MINUTES} minutes and works once.`),
    html: layout(letter),
  };
}

/** A notice that something on the account already changed, sent to the address that would want to know. */
export function noticeEmail(title: string, intro: string, details: Detail[], at = new Date()): Email {
  const letter: Letter = {
    preheader: intro,
    title,
    intro,
    details: [...details, ['When', whenUtc(at)]],
    help: true,
    note: "If this was you, there's nothing to do.",
  };
  return { subject: `DonutLuxe: ${title}`, text: plainText(letter, title), html: layout(letter) };
}
