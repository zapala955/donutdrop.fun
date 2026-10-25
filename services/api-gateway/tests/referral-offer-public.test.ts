import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

/* 2026-10-25: asked which DonutSMP site pays per referral, Gemini suggested other sites. Nothing it
 * could read said this one pays $50M: signed out, the invite page was one line, "Log in to get
 * your invite link", and its title and description named no offer. Now the page shows the deal to
 * everybody and its search text quotes it -- with every figure from GET /v1/promotions, because an
 * invite figure typed into the site once went stale and advertised a bonus it had stopped paying. */

const front = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');
const read = async (relative: string) =>
  (await readFile(path.join(front, relative), 'utf8')).replace(/\r\n/g, '\n');

interface Seo {
  ROUTE_META: Record<string, { title: string; description: string }>;
  liveRouteMeta: (
    route: string,
    promotions: unknown,
    money: (n: number) => string,
  ) => { title: string; description: string } | null;
}
const loadSeo = async () =>
  (await import(pathToFileURL(path.join(front, 'assets/js/seo.js')).href)) as Seo;

const money = (n: number) => `$${n / 1e6}M`;
const promotions = {
  referral: { bonusMinor: '50000000', bonusWagerMinor: '100000000', revshareWagerBps: 50 },
};

describe('the invite offer, for people who are not signed in', () => {
  it('titles the invite page with the live offer', async () => {
    const seo = await loadSeo();
    const live = seo.liveRouteMeta('referrals', promotions, money);
    assert.equal(live?.title, 'DonutLuxe Referrals — $50M Per Invite');
    assert.equal(
      live?.description,
      'Earn $50M for every player you refer to DonutLuxe once they wager $100M, plus 0.5% of everything they wager for life.',
    );
    // No offer loaded, or another page: the static text stands.
    assert.equal(seo.liveRouteMeta('referrals', null, money), null);
    assert.equal(seo.liveRouteMeta('crash', promotions, money), null);
  });

  it('never types a figure into the static search text', async () => {
    const seo = await loadSeo();
    for (const [route, meta] of Object.entries(seo.ROUTE_META)) {
      assert.doesNotMatch(`${meta.title} ${meta.description}`, /\$\d/, route);
    }
  });

  it('shows the deal signed out, from /v1/promotions, with a button that logs in', async () => {
    const referrals = await read('assets/js/referrals.js');
    assert.match(referrals, /const terms = state\.promotions\?\.referral;/);
    assert.match(referrals, /root\.appendChild\(terms \? publicOffer\(terms\) : gate\('Log in to get your invite link\.'\)\);/);
    assert.match(referrals, /go\.textContent = 'Log in to get your link';/);
    assert.match(referrals, /\$\('#loginBtn'\)\?\.click\(\)/);
    // It repaints when the offer arrives.
    assert.match(referrals, /'private', 'promotions'\]\.includes\(event\.detail\)/);
    // And app.js retitles the page once it has.
    const app = await read('assets/js/app.js');
    assert.match(app, /applyRouteMeta\(name, liveRouteMeta\(name, state\.promotions, money\)\);/);
    assert.match(app, /event\.detail !== 'promotions' && event\.detail !== 'ready'/);
  });

  it('publishes the lifetime share with the rest of the public terms', async () => {
    const route = (
      await readFile(path.resolve(import.meta.dirname, '../src/routes/promotions.ts'), 'utf8')
    ).replace(/\r\n/g, '\n');
    assert.match(route, /revshareWagerBps: Number\(\(revshareMinor\(config, 1_000_000n\) \* 10_000n\) \/ 1_000_000n\)/);
  });
});
