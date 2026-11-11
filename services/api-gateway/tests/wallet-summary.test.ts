import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * The wallet's two side tiles said "in (last 25)" and "out (last 25)".
 *
 * They summed whatever rows the ledger had loaded, which is an arbitrary window rather than a
 * total. The labels were honest about it, which made the figures useless rather than wrong:
 * somebody opening this page wants to know what they have put in and taken out, and neither
 * number answered that.
 */
describe('what the wallet says a player has put in and taken out', () => {
  const route = () => read('services/api-gateway/src/routes/economy.ts');

  it('counts every row that ever moved real money, not a page of them', async () => {
    const code = await route();
    const handler = code.slice(code.indexOf("'/v1/balance/summary'"));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.match(body, /FROM wallet_transactions/);
    assert.ok(!body.includes('LIMIT'), 'the summary is windowed, which is what it replaced');
    for (const kind of ['pay_login_deposit', 'cash_deposit', 'cash_withdrawal', 'cash_withdrawal_refund']) {
      assert.ok(body.includes(`'${kind}'`), `${kind} is missing from the summary`);
    }
  });

  /* A refunded payout never left the account. Counting it would tell somebody they had withdrawn
   * twice what they really did, on the one screen they check to find out. */
  it('nets refunds off the withdrawn figure', async () => {
    const code = await route();
    const handler = code.slice(code.indexOf("'/v1/balance/summary'"));
    assert.match(handler.slice(0, 1400), /-sum\(amount_minor\) FILTER \(\s*WHERE kind IN \('cash_withdrawal', 'cash_withdrawal_refund'\)/);
  });

  /* Support and the player must not be able to quote different numbers at each other. */
  it('uses the same query the admin player view already runs', async () => {
    const [economy, admin] = await Promise.all([route(), read('services/api-gateway/src/routes/admin.ts')]);
    const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const grab = (source: string) => {
      const at = source.indexOf("AS deposited_minor");
      const start = source.lastIndexOf('coalesce', at);
      const end = source.indexOf('AS withdrawn_minor', at);
      return normalise(source.slice(start, end));
    };
    assert.equal(grab(economy), grab(admin));
  });

  /* /v1/balance is re-fetched on every settlement. A filtered sum over the whole ledger belongs
   * nowhere near it. */
  it('stays off the hot path', async () => {
    const code = await route();
    const balance = code.slice(code.indexOf("app.get('/v1/balance',"));
    const body = balance.slice(0, balance.indexOf('});'));
    assert.ok(!body.includes('pay_login_deposit'), 'the balance endpoint now scans the ledger');
  });
});

/* The owner (2026-11-11): "remove https://donutluxe.com/race and https://donutluxe.com/wallet".
 * The summary above stays in the API (the admin player view runs the same query); the page that
 * showed it to players, and the race page, are gone from every way in. */
describe('the wallet and race pages', () => {
  const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

  it('are not in the router, the markup, the menus or the home page', async () => {
    const [html, app] = await Promise.all([front('index.html'), front('assets/js/app.js')]);
    const views = app.slice(app.indexOf('const VIEWS = {'), app.indexOf('};', app.indexOf('const VIEWS = {')));
    assert.doesNotMatch(views, /^\s+'?(?:race|wallet)'?: mount/m);
    assert.doesNotMatch(app, /from '\.\/race\.js'|mountWallet|mountRace/);
    assert.doesNotMatch(html, /data-view="(?:race|wallet)"|href="\/(?:race|wallet)"|assets\/js\/race\.js/);
    await assert.rejects(front('assets/js/race.js'));
  });

  it('leave Deposit and Withdraw on the profile, through the header’s own flow', async () => {
    const code = await front('assets/js/account.js');
    assert.doesNotMatch(code, /function paintWallet|ledgerTable|walletSummary/);
    const actions = code.slice(code.indexOf('function moneyActions'));
    const body = actions.slice(0, actions.indexOf('\n}'));
    assert.match(body, /\$\('#depositBtn'\)\?\.click\(\)/);
    assert.match(body, /\$\('#withdrawBtn'\)\?\.click\(\)/);
    // The definition and the profile's one use.
    assert.equal(code.split('moneyActions()').length - 1, 2);
  });

  it('are out of the sitemap and the SEO table, and nginx sends an old link home', async () => {
    const [sitemap, seo, nginx] = await Promise.all([
      front('sitemap.xml'),
      front('assets/js/seo.js'),
      read('infra/nginx/nginx.conf'),
    ]);
    assert.doesNotMatch(sitemap, /donutluxe\.com\/(?:race|wallet)</);
    assert.doesNotMatch(seo, /^\s+(?:race|wallet): \{/m);
    assert.match(nginx, /location ~ \^\/\(\?:race\|wallet\)\/\?\$ \{\s+include \/etc\/nginx\/security-headers\.conf;\s+return 302 \/;/);
    const served = nginx.slice(nginx.indexOf('location ~ ^/(?:home|crates'));
    assert.doesNotMatch(served.slice(0, served.indexOf('{')), /\|(?:race|wallet)\|/);
  });
});
