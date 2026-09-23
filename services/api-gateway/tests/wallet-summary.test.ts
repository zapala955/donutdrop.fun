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

describe('the wallet page', () => {
  const page = () => read('DONUTDROP FRONTEND/Donut Drop/assets/js/account.js');

  it('labels the tiles by what they are, not by the window they came from', async () => {
    const code = await page();
    const wallet = code.slice(code.indexOf('function paintWallet'));
    assert.match(wallet, /\['Deposited', deposited, 'up'\]/);
    assert.match(wallet, /\['Withdrawn', withdrawn, 'down'\]/);
    /* The CODE, not the prose. The comment above those tiles explains what they replaced and
     * says "last 25" in doing so; a grep over the whole function fails on its own tombstone. */
    assert.ok(!wallet.includes("'In (last 25)'"), 'the windowed tile is still rendered');
    assert.ok(!wallet.includes("'Out (last 25)'"), 'the windowed tile is still rendered');
  });

  it('renames the ledger to something a player would say', async () => {
    const code = await page();
    assert.ok(code.includes("panel('Recent transactions')"));
    assert.ok(!code.includes("panel('Recent ledger')"));
  });

  /* "$0 deposited" is a claim about somebody's money. A request that has not come back is not
   * entitled to make it. */
  it('shows an em dash rather than a zero before the figures arrive', async () => {
    const code = await page();
    const wallet = code.slice(code.indexOf('function paintWallet'));
    assert.match(wallet, /summary \? money\(Number\(summary\.depositedMinor\)\) : '—'/);
    assert.match(wallet, /summary \? money\(Number\(summary\.withdrawnMinor\)\) : '—'/);
  });

  /* Two tiles must not be able to hold the whole page on its loading state. */
  it('renders the ledger even if the summary request fails', async () => {
    const code = await page();
    const mount = code.slice(code.indexOf('export function mountWallet'));
    assert.match(mount.slice(0, 900), /Promise\.allSettled\(/);
  });

  it('forgets the totals on sign-out', async () => {
    const store = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/store.js');
    const logout = store.slice(store.indexOf('export async function logout'));
    assert.match(logout.slice(0, 700), /state\.walletSummary = null;/);
  });
});
