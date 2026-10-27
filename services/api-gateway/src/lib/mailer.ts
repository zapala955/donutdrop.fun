import type { AppConfig } from '../config.js';

/**
 * Sending the site's few emails, through Resend's HTTP API (https://resend.com/docs/api-reference).
 *
 * The site mails exactly one kind of thing: a six-digit code (linking an email, signing in with it,
 * removing it, confirming a withdrawal to a different name). No newsletters, no receipts. So this
 * is one POST with a timeout, not a library.
 *
 * Off until RESEND_API_KEY and EMAIL_FROM are both set. The key must look like a Resend key (`re_`):
 * the deploy writes a placeholder secret file so the api container can start without one, and a
 * placeholder must read as "not configured", never as a key that fails on every send.
 */

const RESEND_URL = 'https://api.resend.com/emails';

export function mailAvailable(config: AppConfig): boolean {
  return config.resendApiKey.startsWith('re_') && config.emailFrom.trim().length > 0;
}

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export class MailUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailUnavailable';
  }
}

export async function sendMail(config: AppConfig, mail: Mail): Promise<void> {
  if (!mailAvailable(config)) throw new MailUnavailable('Email is not set up');
  let response: Response;
  try {
    response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new MailUnavailable('The email service could not be reached');
  }
  /* Resend's error body can echo the request back, and the request holds the code. Only the status
   * leaves this function. */
  if (!response.ok)
    throw new MailUnavailable(`The email service refused the mail (${response.status})`);
}

/** What a code email says. The code is in the body only: a subject shows on lock screens. */
export function codeMail(input: {
  to: string;
  code: string;
  purpose: 'link' | 'login' | 'remove' | 'withdraw';
  username: string | null;
  withdrawal?: { amount: string; payee: string } | undefined;
}): Mail {
  const lines: Record<typeof input.purpose, { subject: string; lead: string }> = {
    link: {
      subject: 'Confirm your email for DonutLuxe',
      lead: `Enter this code on donutluxe.com to link this email to ${input.username ?? 'your account'}.`,
    },
    login: {
      subject: 'Your DonutLuxe sign-in code',
      lead: `Enter this code on donutluxe.com to sign in${input.username ? ` as ${input.username}` : ''}.`,
    },
    remove: {
      subject: 'Remove this email from DonutLuxe',
      lead: `Enter this code on donutluxe.com to remove this email from ${input.username ?? 'your account'}.`,
    },
    withdraw: {
      subject: 'Confirm your DonutLuxe withdrawal',
      lead: input.withdrawal
        ? `Enter this code on donutluxe.com to send ${input.withdrawal.amount} to the Minecraft name ${input.withdrawal.payee}. Only use it if you asked for exactly this.`
        : 'Enter this code on donutluxe.com to confirm your withdrawal.',
    },
  };
  const { subject, lead } = lines[input.purpose];
  const warning =
    'It works once, for 10 minutes. DonutLuxe staff never ask for it. If you did not ask for this code, ignore this email; nothing changes without it.';
  const text = `${lead}\n\n${input.code}\n\n${warning}\n`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    `<p>${escapeHtml(lead)}</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:Consolas,monospace">${escapeHtml(input.code)}</p>` +
    `<p style="color:#555;font-size:13px">${escapeHtml(warning)}</p></div>`;
  return { to: input.to, subject, text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
