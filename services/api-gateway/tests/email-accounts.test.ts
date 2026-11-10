import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { CODE_MAX_ATTEMPTS, CODE_TTL_MINUTES, EMAIL_PATTERN, codeEmail, maskEmail, noticeEmail, normalizeEmail } from '../src/lib/email.js';

/* Email on accounts (2026-11-10). The owner's spec: after a first sign-up (paying the bot) the site
 * offers to link an email; it can be linked later from a redesigned profile; with one linked, the
 * account can move to a different Minecraft account. Sign-in by an emailed code comes with it. The
 * Resend plan sends 100 emails a day, so the site counts its own sends and pauses email at the limit.
 * The whole flow was also run end to end against a real PostgreSQL with the API's runtime role
 * (51 checks), and migration 091 was dry-run on a copy of production before shipping. */

const root = path.resolve(import.meta.dirname, '../../..');
const read = async (file: string) => (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
const api = (file: string) => read(`services/api-gateway/src/${file}`);
const front = (file: string) => read(`DONUTDROP FRONTEND/Donut Drop/assets/js/${file}`);

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  PUBLIC_BASE_URL: 'http://localhost:3001',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  INTERNAL_WEBHOOK_SECRET: 'w'.repeat(32),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000099': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  ADMIN_TOTP_SECRETS_JSON: '{}',
  LOG_LEVEL: 'silent',
};

describe('email on accounts', () => {
  it('is off by default, needs a real Resend key to turn on, and defaults to 100 emails a day', () => {
    const off = loadConfig(baseEnv);
    assert.equal(off.emailEnabled, false);
    assert.equal(off.emailDailyLimit, 100);
    assert.equal(off.emailFrom, 'DonutLuxe <login@donutluxe.com>');
    assert.throws(() => loadConfig({ ...baseEnv, EMAIL_ENABLED: 'true', RESEND_API_KEY: 'not-configured' }));
    const on = loadConfig({ ...baseEnv, EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_test_abcdefghij' });
    assert.equal(on.emailEnabled, true);
  });

  it('normalises and masks addresses, and writes six-digit codes that last ten minutes', () => {
    assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
    assert.equal(maskEmail('alice@example.com'), 'a****@example.com');
    assert.ok(EMAIL_PATTERN.test('a.b+c@mail.example.co.uk'));
    assert.ok(!EMAIL_PATTERN.test('no-at-sign.example.com'));
    assert.ok(!EMAIL_PATTERN.test('two@@example.com'));
    assert.equal(CODE_TTL_MINUTES, 10);
    assert.equal(CODE_MAX_ATTEMPTS, 5);
    const login = codeEmail('login', '123456', 'Alice');
    assert.match(login.subject, /^123456 is your DonutLuxe sign-in code$/);
    assert.match(login.text, /123456/);
    // Server strings in the HTML are escaped.
    assert.doesNotMatch(codeEmail('link', '123456', '<b>x</b>').html, /<b>x<\/b>/);
    /* The owner (2026-11-10): the first light design "doesnt fit the new premium real online casino
     * design". The emails wear the site's dark skin: the page, a flat panel, the code in a well. */
    assert.match(login.html, /background:#121216/);
    assert.match(login.html, /bgcolor="#1c1c22"/);
    assert.match(login.html, /src="https:\/\/donutluxe\.com\/assets\/img\/brand\/logo-com\.png"/);
    assert.match(login.html, /<meta name="color-scheme" content="dark">/);
    assert.match(login.html, />123456<\/div>/);
    const notice = noticeEmail('Your email was changed', 'Changed.', [['Account', 'Alice']], new Date('2026-11-10T22:54:00Z'));
    assert.equal(notice.subject, 'DonutLuxe: Your email was changed');
    assert.match(notice.html, />10 Nov 2026, 22:54 UTC</);
    assert.match(notice.html, /href="https:\/\/discord\.gg\/aHfRsUaGgx"[^>]*>Contact staff on Discord<\/a>/);
    assert.match(notice.text, /Account: Alice\nWhen: 10 Nov 2026, 22:54 UTC/);
  });

  it('counts every send over 24 hours under a lock, and refuses at the daily limit', async () => {
    const email = await api('lib/email.ts');
    assert.match(email, /BEGIN ISOLATION LEVEL READ COMMITTED/);
    assert.match(email, /pg_advisory_xact_lock\(hashtextextended\('email-daily-quota', 0\)\)/);
    assert.match(email, /WHERE created_at > now\(\) - interval '24 hours'/);
    assert.match(email, /if \(\(await sentInLastDay\(client\)\) >= config\.emailDailyLimit\) \{/);
    assert.match(email, /'EMAIL_DAILY_LIMIT'/);
    // A wrong code is a committed, spent try, never a thrown error that would roll it back.
    assert.match(email, /if \(!right\) \{\n\s*await client\.query\(\n\s*`UPDATE email_codes SET attempts = attempts \+ 1,/);
  });

  it('keeps an account-move payment out of sign-in, and the Minecraft account it left from a second bonus', async () => {
    const auth = await api('routes/auth.ts');
    assert.match(auth, /if \(challenge\.relink_user_id\) \{\n\s*conflict\('CHALLENGE_IS_RELINK'/);
    assert.match(auth, /AND confirmed_at IS NOT NULL AND completed_at IS NULL\n\s*AND relink_user_id IS NULL/);
    assert.match(auth, /'SELECT 1 FROM minecraft_relinks WHERE old_identity = \$1 LIMIT 1'/);
    assert.match(auth, /const rewardable = created && !retired\.rows\[0\];/);
    assert.match(auth, /if \(rewardable && config\.referralsEnabled && challenge\.referral_code\) \{/);
    assert.match(auth, /\} else if \(rewardable && config\.signupBonusMinor > 0n\) \{/);
    assert.match(auth, /created: completion\.created,/);
  });

  it('moves an account only with an email, a code from it, a paid challenge, and no withdrawal on its way', async () => {
    const routes = await api('routes/email.ts');
    assert.match(routes, /'\/v1\/account\/minecraft\/start',\n\s*\{ preHandler: guards\.requireCsrf/);
    assert.match(routes, /if \(!account\.email\) return new AppError\(409, 'NO_EMAIL'/);
    assert.match(routes, /const LIVE_CASH_WITHDRAWAL = \['pending_approval', 'queued', 'processing', 'awaiting_vault', 'manual_review'\];/);
    assert.match(routes, /const LIVE_ITEM_WITHDRAWAL = \['queued', 'processing', 'manual_review'\];/);
    assert.match(routes, /relinkUserId: userId,/);
    assert.match(routes, /WHERE id = \$1 AND browser_token_hash = \$2 AND relink_user_id = \$3 AND method = 'payment'/);
    // Staff and admin identities never move this way; the payment is still credited.
    assert.match(routes, /if \(config\.adminMinecraftIds\.has\(identity\)\) \{/);
    assert.match(routes, /await creditWallet\(client, userId, BigInt\(challenge\.pay_amount!\), 'pay_login_deposit', challenge\.id\);/);
    // Sign-in by email: players only, the same answer whether or not the address has an account.
    assert.match(routes, /WHERE email = \$1 AND status = 'active' AND role = 'player' AND demo_of IS NULL`/);
    assert.match(routes, /return reply\.code\(202\)\.send\(\{ sent: true, email: maskEmail\(body\.email\) \}\);/);
    // A change of address takes a code from the old one first.
    assert.match(routes, /'CONFIRM_CODE_REQUIRED'/);
  });

  it('adds email in one additive migration, with the runtime role granted exactly what it uses', async () => {
    const sql = await read('packages/db/migrations/091_email_accounts.sql');
    assert.match(sql, /ADD COLUMN email varchar\(254\),/);
    assert.match(sql, /CREATE UNIQUE INDEX users_email_idx ON users \(email\) WHERE email IS NOT NULL;/);
    assert.match(sql, /ALTER TABLE auth_link_challenges ADD COLUMN relink_user_id uuid REFERENCES users\(id\);/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE email_codes TO donut_api_runtime;/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE email_sends TO donut_api_runtime;/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE minecraft_relinks TO donut_api_runtime;/);
    assert.doesNotMatch(sql, /\bUPDATE users\b|\bDELETE FROM\b/);
  });

  it('keeps the Resend key in a secret file, with a placeholder so the API always starts', async () => {
    const compose = await read('infra/docker/compose.yml');
    assert.match(compose, /RESEND_API_KEY_FILE: \/run\/secrets\/resend_api_key/);
    assert.match(compose, /      - resend_api_key\n    depends_on:/);
    assert.match(compose, /resend_api_key:\n\s*file: \$\{RESEND_API_KEY_FILE:-\/opt\/donutdrop\/shared\/secrets\/resend-api-key\}/);
    const deploy = await read('infra/vps/deploy.sh');
    assert.match(deploy, /printf '%s' 'not-configured' >"\$resend_key_file"/);
    const script = await read('infra/vps/set-email.sh');
    assert.match(script, /sed -i '\/\^RESEND_API_KEY=\/d' "\$env_file"/);
    assert.match(script, /set_env EMAIL_ENABLED true/);
  });

  it('offers an email after a first sign-up, signs in by code, and draws the profile cards', async () => {
    const app = await front('app.js');
    assert.match(app, /if \(user\.created && signInOpen\(\)\) \{\n\s*await offerEmailLink\(body, \{/);
    // "or", then a real "Log in with email" button, shown only once the server says email is on.
    assert.match(app, /<div class="auth__alt" id="linkByEmailRow" hidden>/);
    assert.match(app, /<button class="btn auth__altbtn" type="button" id="linkByEmail">\$\{MAIL_ICON\}<span>Log in with email<\/span><\/button>/);
    const store = await front('store.js');
    assert.match(store, /return \{ \.\.\.result\.user, created: Boolean\(result\.created\) \};/);
    const email = await front('email.js');
    assert.match(email, /export async function offerEmailLink\(body, \{ username, onDone \}\)/);
    assert.match(email, /<button class="btn auth__ghost" type="button" id="elSkip">Skip for now<\/button>/);
    assert.match(email, /export function renderEmailSignIn\(/);
    const account = await front('account.js');
    assert.match(account, /\[emailCard\(info, reloadCards\), minecraftCard\(info, reloadCards, avatarOf\(user, 40\)\)\]/);
    /* The owner: "make it so theres a button to change ur linked account not just the ign and code
     * form". The card shows the linked account with one button; the change is its own window, one
     * step to a screen: the new name, the code, the payment, done. */
    assert.match(email, />Change account<\/button>/);
    assert.match(email, /openModal\('Change Minecraft account', nameStep, \{ variant: 'auth' \}\);/);
    assert.match(email, /const nameStep = \(body\) => \{/);
    assert.match(email, /const codeStep = \(body, masked\) => \{/);
    assert.match(email, /const payStep = \(body, challenge\) => \{/);
    assert.match(email, /const doneStep = \(body, name\) => \{/);
  });
});
