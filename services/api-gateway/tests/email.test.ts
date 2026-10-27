import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { maskEmail, normalizeEmail } from '../src/lib/email-codes.js';
import { codeMail, mailAvailable, sendMail } from '../src/lib/mailer.js';

/* Email (migration 079): a second way in with a code, and the code that confirms a withdrawal to a
 * different Minecraft name. Checked end to end against a real Postgres when it was written (45
 * checks: linking, five-try limit, sign-in bound to the browser, no enumeration, admins refused,
 * the 24-hour wait, a code bound to amount and name, replays); these hold the shape in place. */

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000001': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  RESEND_API_KEY: 're_test_key',
  EMAIL_FROM: 'DonutLuxe <codes@donutluxe.com>',
};

describe('email: addresses', () => {
  it('stores one shape: trimmed, lower-cased, plausibly an address', () => {
    assert.equal(normalizeEmail('  Steve.Player@Example.COM '), 'steve.player@example.com');
    assert.equal(normalizeEmail('no-at-sign.example.com'), null);
    assert.equal(normalizeEmail('a@b'), null);
    assert.equal(normalizeEmail('evil"<script>@x.com'), null);
    assert.equal(normalizeEmail(`${'a'.repeat(250)}@x.com`), null);
  });

  it('masks an address enough to recognise, not enough to harvest', () => {
    assert.equal(maskEmail('steve.player@example.com'), 's•••@example.com');
  });
});

describe('email: sending', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('is off until a real Resend key and a sender are set (the deploy placeholder is not a key)', () => {
    assert.equal(mailAvailable(loadConfig(baseEnv)), true);
    assert.equal(
      mailAvailable(loadConfig({ ...baseEnv, RESEND_API_KEY: 'not-configured' })),
      false,
    );
    assert.equal(mailAvailable(loadConfig({ ...baseEnv, EMAIL_FROM: '' })), false);
  });

  it('posts one mail to Resend, the code in the body and never in the subject', async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return Response.json({ id: 'x' });
    }) as typeof fetch;
    const mail = codeMail({
      to: 'steve@example.com',
      code: '123456',
      purpose: 'withdraw',
      username: 'Steve',
      withdrawal: { amount: '$1,000,000', payee: 'FriendBob' },
    });
    await sendMail(loadConfig(baseEnv), mail);
    assert.equal(sent[0]?.url, 'https://api.resend.com/emails');
    const body = JSON.parse(String(sent[0]?.init.body));
    assert.deepEqual(body.to, ['steve@example.com']);
    assert.equal(body.from, 'DonutLuxe <codes@donutluxe.com>');
    assert.doesNotMatch(body.subject, /123456/);
    assert.match(body.text, /\n123456\n/);
    // A withdrawal code says exactly what it confirms.
    assert.match(body.text, /\$1,000,000 to the Minecraft name FriendBob/);
    assert.equal(
      (sent[0]?.init.headers as Record<string, string>)['Authorization'],
      'Bearer re_test_key',
    );
  });
});

describe('email: the codes', () => {
  const lib = () => read('services/api-gateway/src/lib/email-codes.ts');

  it('stores only an HMAC of the code, keyed with a server secret and the row', async () => {
    const source = await lib();
    assert.match(source, /hmacHex\(config\.ipHashKey, `email-code:\$\{id\}:\$\{code\}`\)/);
    assert.match(source, /export const CODE_TTL_MINUTES = 10;/);
    assert.match(source, /export const CODE_MAX_ATTEMPTS = 5;/);
  });

  it('commits a wrong try in its own transaction, and leaves spending to the caller', async () => {
    const source = await lib();
    const check = source.slice(source.indexOf('export async function checkCode('));
    assert.match(check, /UPDATE email_codes SET attempts = attempts \+ 1 WHERE id = \$1/);
    assert.match(check, /return \{ ok: false as const \};/);
    // Thrown only after the transaction committed the try.
    assert.match(check, /if \(!outcome\.ok\) throw invalidCode\(\);/);
    assert.match(
      source,
      /UPDATE email_codes SET consumed_at = now\(\) WHERE id = \$1 AND consumed_at IS NULL/,
    );
  });

  it('throttles sending: one a minute, five an hour, a new code retiring the last', async () => {
    const source = await lib();
    assert.match(source, /const RESEND_AFTER_SECONDS = 60;/);
    assert.match(source, /const MAX_PER_HOUR = 5;/);
    assert.match(source, /'EMAIL_CODE_TOO_SOON'/);
  });
});

describe('email: the routes', () => {
  const route = () => read('services/api-gateway/src/routes/email.ts');

  it('is registered with the other sign-in routes', async () => {
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerEmailRoutes\(app, db, config\);/);
  });

  it('answers a sign-in start the same whether or not the address has an account', async () => {
    const source = await route();
    const start = source.slice(
      source.indexOf("'/v1/auth/email/start'"),
      source.indexOf("'/v1/auth/email/complete'"),
    );
    assert.match(start, /preHandler: requireWebsiteOrigin/);
    assert.match(start, /if \(account && !isAdmin\(account\)\) \{/);
    assert.match(
      start,
      /request\.log\.warn\(\{ err: error \}, 'An email sign-in code was not sent'\);/,
    );
    assert.match(
      start,
      /return reply\.send\(\{ sentTo: maskEmail\(email\), expiresInMinutes: CODE_TTL_MINUTES \}\);/,
    );
    // The code is tied to this browser.
    assert.match(start, /browserTokenHash: sha256Hex\(browserToken\)/);
    assert.match(start, /sameSite: 'strict'/);
  });

  it('mints the session only for the browser that asked, and never for an administrator', async () => {
    const source = await route();
    const complete = source.slice(source.indexOf("'/v1/auth/email/complete'"));
    assert.match(complete, /\{ purpose: 'login', browserTokenHash: sha256Hex\(browserToken\) \}/);
    assert.match(
      complete,
      /WHERE id = \$1 AND email = \$2 AND demo_of IS NULL\n            FOR UPDATE/,
    );
    assert.match(complete, /'EMAIL_LOGIN_ADMIN'/);
    assert.doesNotMatch(complete, /admin_mfa_verified_at/);
  });

  it('removes an email only with a code sent to it, and makes a new one wait before paying others', async () => {
    const source = await route();
    assert.match(source, /'\/v1\/email\/remove\/start'/);
    assert.match(source, /purpose: 'remove'/);
    assert.match(
      source,
      /'EMAIL_ALREADY_LINKED', 'This account already has an email\. Remove it first'/,
    );
    const codes = await read('services/api-gateway/src/lib/email-codes.ts');
    assert.match(codes, /export const EMAIL_PAYOUT_WAIT_HOURS = 24;/);
    assert.match(source, /'EMAIL_TOO_NEW'/);
  });
});

describe('email: a withdrawal to a different name', () => {
  const route = () => read('services/api-gateway/src/routes/cash-withdrawals.ts');

  it("pays the account's own name unless a different one comes with its code", async () => {
    const source = await route();
    assert.match(
      source,
      /body\.payeeUsername !== undefined && body\.payeeUsername\.toLowerCase\(\) !== ownName\.toLowerCase\(\)/,
    );
    assert.match(source, /'EMAIL_CODE_REQUIRED'/);
    // The code is bound to this amount and this name.
    assert.match(
      source,
      /\{ purpose: 'withdraw', userId, payeeUsername: payee, amountMinor: amount \}/,
    );
  });

  it('spends the code inside the withdrawal, after re-reading the email under the account lock', async () => {
    const source = await route();
    const tx = source.slice(
      source.indexOf("'SELECT status, payout_hold_reason FROM users WHERE id = $1 FOR UPDATE'"),
    );
    assert.ok(
      tx.indexOf('email_verified_at <=') < tx.indexOf('await spendCode(client, emailCode.id);'),
    );
    assert.ok(
      tx.indexOf('await spendCode(client, emailCode.id);') <
        tx.indexOf('INSERT INTO cash_withdrawals'),
    );
  });
});

describe('email: migration 079', () => {
  it('stores only confirmed, lower-case addresses, one account each, and codes as hashes', async () => {
    const sql = await read('packages/db/migrations/079_email.sql');
    assert.doesNotMatch(sql, /DROP |UPDATE users/i);
    assert.match(sql, /CHECK \(num_nonnulls\(email, email_verified_at\) IN \(0, 2\)\)/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX users_email_idx ON users \(email\) WHERE email IS NOT NULL;/,
    );
    assert.match(sql, /code_hash char\(64\) NOT NULL/);
    assert.match(sql, /CHECK \(\(purpose = 'login'\) = \(browser_token_hash IS NOT NULL\)\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v79\(\) RETURNS boolean/);
  });

  it('hands the Resend key and the sender to the api container, with a placeholder key', async () => {
    const compose = await read('infra/docker/compose.yml');
    const api = compose.slice(compose.indexOf('\n  api:\n'), compose.indexOf('\n  maintenance:'));
    assert.ok(api.includes('RESEND_API_KEY_FILE: /run/secrets/resend_api_key'));
    assert.ok(api.includes("EMAIL_FROM: '${EMAIL_FROM:-}'"));
    assert.ok(api.includes('      - resend_api_key'));
    const deploy = await read('infra/vps/deploy.sh');
    const placeholder = deploy.indexOf("printf '%s' 'not-configured' >\"$resend_key_file\"");
    assert.ok(placeholder > 0 && placeholder < deploy.indexOf('"${compose[@]}" config --quiet'));
  });
});

describe('email: the page', () => {
  it('offers the code sign-in under the Minecraft one, only when email is set up', async () => {
    const app = await front('assets/js/app.js');
    assert.match(app, /id="linkEmailGo"/);
    assert.match(app, /void emailLoginAvailable\(\)\.then\(\(available\) =>/);
    assert.match(app, /emailAlt\.hidden = true;/);
    assert.match(app, /function openEmailLoginModal\(\)/);
    // The sign-in window counts as open in either card, so it closes over a signed-in player.
    assert.match(app, /\$\('#linkForm, #elForm', \$\('#modalBody'\)\)/);
  });

  it('asks for the email code before a withdrawal to a different name', async () => {
    const app = await front('assets/js/app.js');
    assert.match(app, /const sent = await requestWithdrawCode\(String\(amount\), payee\);/);
    assert.match(
      app,
      /otherPayee \? \{ payeeUsername: payee, emailCode: codeInput\.value\.trim\(\) \} : null/,
    );
    const store = await front('assets/js/store.js');
    assert.match(
      store,
      /api\.post\('\/v1\/email\/withdraw-code', \{ amountMinor: String\(amountMinor\), payeeUsername \}\)/,
    );
  });

  it('links and removes the email in Settings, each with a code', async () => {
    const account = await front('assets/js/account.js');
    assert.match(account, /function emailPanel\(\)/);
    assert.match(account, /await confirmEmailLink\(emailFlow\.typed\)/);
    assert.match(account, /await confirmEmailRemove\(emailFlow\.typed\)/);
  });
});
