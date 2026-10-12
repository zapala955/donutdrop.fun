import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';
import { rainSchema } from '../src/routes/social.js';

const front = (relative: string) =>
  readFile(
    path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop', relative),
    'utf8',
  );
const api = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');

describe('starting a lava rain', () => {
  it('accepts an amount the way an operator writes it, and a blank note', () => {
    const parsed = rainSchema.safeParse({
      poolMinor: '50,000,000',
      claimMinutes: '5',
      reason: '  ',
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(parsed.data.poolMinor, '50000000');
    assert.equal(parsed.data.claimMinutes, 5);
    assert.equal(parsed.data.reason, undefined);
    assert.ok(rainSchema.safeParse({ poolMinor: '$ 1_000', reason: 'weekend promo' }).success);
  });

  it('still refuses what is not an amount, a window out of range, and stray fields', () => {
    for (const bad of [
      { poolMinor: '50m' },
      { poolMinor: '0' },
      { poolMinor: '-5' },
      { poolMinor: '' },
      { poolMinor: '100', claimMinutes: 0 },
      { poolMinor: '100', claimMinutes: 61 },
      { poolMinor: '100', extra: true },
      { poolMinor: '100', reason: '<script>x</script>' },
    ]) {
      assert.equal(rainSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it('turns "50m" into digits in the console before it is sent, and leaves a blank note out', async () => {
    const js = await front('admin/admin.js');
    const start = js.slice(js.indexOf('async function startRain'));
    assert.match(start, /parseAmount\(values\.poolMinor\)/);
    assert.match(start, /poolMinor: pool\.toString\(\)/);
    assert.match(start, /\.\.\.\(values\.reason \? \{ reason: values\.reason \} : \{\}\)/);
    assert.match(start, /required: false/);
  });
});

describe('invite codes for a registered player', () => {
  it('ships open to any account age, and an operator can narrow or close it', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      APP_ORIGIN: 'http://localhost:3000',
      COOKIE_SECRET: 'c'.repeat(32),
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      BOT_CREDENTIALS_JSON: JSON.stringify({
        '20000000-0000-4000-8000-000000000002': {
          secret: Buffer.alloc(32, 2).toString('base64'),
          serverHost: 'donutsmp.net',
          username: 'DonutBot',
        },
      }),
      AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
      IP_HASH_KEY: 'i'.repeat(32),
      GAME_CURRENCY_ONLY: 'true',
      LOG_LEVEL: 'silent',
    });
    assert.equal(config.referralLateEntryDays, 3650);
    assert.equal(runtimeSettingDefinitions.referralLateEntryDays.min, 0n);
  });

  it('is entered from Settings, once, and never by an invite link for a registered player', async () => {
    const account = await front('assets/js/account.js');
    assert.match(account, /function inviteCodePanel\(\)/);
    assert.match(account, /self\.codeEntry/);
    assert.match(account, /attachReferralCode\(code\)/);
    assert.match(account, /window\.confirm\(/, 'using the one entry is asked about first');
    const referrals = await front('assets/js/referrals.js');
    // A link's code is spent by a sign-up only; for anybody signed in it is dropped and explained.
    assert.match(referrals, /export async function settlePendingReferral/);
    assert.doesNotMatch(referrals, /attachReferralCode/, 'the referrals page never enters a code');
    assert.doesNotMatch(referrals, /attachPendingReferral/);
    const app = await front('assets/js/app.js');
    assert.match(app, /settlePendingReferral\(\)/);
    assert.doesNotMatch(app, /attachPendingReferral|attachReferralCode/);
    const store = await front('assets/js/store.js');
    assert.match(store, /api\.post\('\/v1\/referrals\/attach'/);
  });

  it('is used up for good by a column written with the entry, and adds only that', async () => {
    const referrals = await api('../src/routes/referrals.ts');
    const attach = referrals.slice(referrals.indexOf("'/v1/referrals/attach'"));
    assert.match(attach, /REFERRAL_ENTRY_USED/);
    assert.match(attach, /SET referral_entry_used_at = now\(\)/);
    // An inviter that has earned from the player is never swapped out from under the money.
    assert.match(attach, /REFERRAL_LOCKED/);
    assert.match(attach, /wagered_minor = 0/);
    const sql = await api('../../../packages/db/migrations/061_referral_code_entry.sql');
    assert.doesNotMatch(sql, /DROP |UPDATE |DELETE |ALTER COLUMN/i);
    assert.match(sql, /ALTER TABLE users ADD COLUMN referral_entry_used_at timestamptz/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v61\(\) RETURNS boolean/);
  });

  it('reads a link in any case and keeps the code beyond one tab', async () => {
    const referrals = await front('assets/js/referrals.js');
    const capture = referrals.slice(referrals.indexOf('export function captureReferralCode'));
    assert.match(capture, /cleanCode\(new URLSearchParams\(location\.search\)\.get\('ref'\)\)/);
    assert.match(referrals, /localStorage\.setItem\(REF_KEY/);
    assert.match(referrals, /REF_KEEP_MS/);
  });
});

describe('the pop-ups', () => {
  it('are wired into the page', async () => {
    assert.match(await front('index.html'), /href="assets\/css\/popups\.css"/);
    const app = await front('assets/js/app.js');
    assert.match(app, /import \{ initPopups \} from '\.\/popups\.js'/);
    assert.match(app, /initPopups\(\{ openLogin: openLoginModal \}\)/);
  });

  it('are rare, polite and never in the way of a bet', async () => {
    const popups = await front('assets/js/popups.js');
    // one every twenty minutes at most, per kind a day or more apart
    assert.match(popups, /MIN_GAP_MS = 20 \* 60_000/);
    // never over a table, another dialog or the corner card
    assert.match(popups, /document\.querySelector\('dialog\[open\]'\)/);
    assert.match(popups, /document\.querySelector\('\.nudge'\)/);
    assert.match(popups, /atTable\(\)/);
    for (const table of ['mines-duel', 'coinflip', 'battles', 'blackjack', 'crash']) {
      assert.match(popups, new RegExp(`'${table}'`));
    }
    // somebody on an invite link already has the login form open
    assert.match(popups, /pendingReferralCode\(\)/);
    // a real modal: Escape, the backdrop and the buttons all close it
    assert.match(popups, /showModal\(\)/);
    assert.match(popups, /addEventListener\('cancel'/);
    assert.match(popups, /event\.target === dialog/);
    // the corner card steps back while one is up
    assert.match(popups, /write\(NUDGE_KEY/);
  });

  it('offer register-now when signed out and the newest game, Discord and invites when signed in', async () => {
    const popups = await front('assets/js/popups.js');
    assert.match(popups, /cta: 'Register now'/);
    assert.match(popups, /SPOTLIGHT_GAMES\.filter\(isNewGame\)/);
    assert.match(popups, /href: '\/discord'/);
    assert.match(popups, /href: '\/referrals'/);
    // every figure is the server's
    assert.match(popups, /state\.promotions\?\.signupBonus\?\.amountMinor/);
    assert.match(popups, /state\.promotions\?\.referral\?\.bonusMinor/);
  });

  it('have a stylesheet that honours reduced motion and sits above the header', async () => {
    const css = await front('assets/css/popups.css');
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /--z-popup:\s*120/);
    assert.match(css, /@media \(max-width: 560px\)/);
  });
});

describe('the referral route', () => {
  it('is rate limited and needs a signed-in, CSRF-checked caller', async () => {
    const source = await api('../src/routes/referrals.ts');
    const attach = source.slice(source.indexOf("'/v1/referrals/attach'"));
    assert.match(attach, /preHandler: guards\.requireCsrf/);
    assert.match(attach, /rateLimit: \{ max: 8, timeWindow: '1 minute' \}/);
    assert.match(attach, /FOR UPDATE/);
  });
});
