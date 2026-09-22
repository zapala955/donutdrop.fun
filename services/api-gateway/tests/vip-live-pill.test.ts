import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LADDER, vipStandingFor } from '../src/lib/vip.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * The header level pill only changed on a page load.
 *
 * It reads `state.vip`, which was fetched once at bootstrap and again only when somebody opened
 * the VIP page. A player could cross a level mid-session, keep playing at the new rate, and be
 * shown the old badge until they happened to refresh.
 *
 * The standing is a pure function of lifetime wagered, and lifetime wagered changes at exactly
 * the moment the balance does. So it rides along on /v1/balance, which is already re-fetched on
 * every settlement, rather than costing a second request per round.
 */
describe('the level pill keeps up with the wagers that move it', () => {
  it('derives a standing from lifetime wagered alone, with no ladder attached', () => {
    const bottom = vipStandingFor(0n);
    assert.equal(bottom.current.level, 1);
    assert.equal(bottom.wageredMinor, '0');
    // The pill draws a bar, a label and a tier; it never draws the ladder, so none is sent.
    assert.equal('levels' in bottom, false);
    assert.equal('rakeback' in bottom, false);

    // Standing on a threshold is that level, and the level below it is one unit short.
    const second = LADDER[1]!;
    assert.equal(vipStandingFor(second.thresholdMinor).current.level, second.level);
    assert.equal(vipStandingFor(second.thresholdMinor - 1n).current.level, 1);
  });

  it('reports a 0-1 ratio that never leaves the bar, at either end of the ladder', () => {
    const top = LADDER[LADDER.length - 1]!;
    for (const wagered of [0n, 1n, top.thresholdMinor, top.thresholdMinor * 10n]) {
      const { progress } = vipStandingFor(wagered);
      assert.ok(
        progress.ratio >= 0 && progress.ratio <= 1,
        `ratio ${progress.ratio} at ${wagered} is outside the bar`,
      );
    }
    // The top level has nothing above it, so there is no next and nothing remaining.
    assert.equal(vipStandingFor(top.thresholdMinor).next, null);
    assert.equal(vipStandingFor(top.thresholdMinor).progress.remainingMinor, '0');
  });

  it('sends the standing with the balance, from one query and one function', async () => {
    const route = await read('services/api-gateway/src/routes/economy.ts');
    const handler = route.slice(route.indexOf("'/v1/balance'"));
    const body = handler.slice(0, handler.indexOf("'/v1/balance/transactions'"));
    // Joined, not a second round trip: same primary key, same statement.
    assert.match(body, /LEFT JOIN user_wager_totals/);
    assert.match(body, /vipStandingFor\(BigInt\(row\?\.wagered_minor \?\? '0'\)\)/);
    // Omitted entirely when the programme is off, so the client leaves the pill hidden.
    assert.match(body, /config\.vipEnabled \?/);
  });

  /* Two endpoints returning the same thing in two shapes is how a header and a page end up
   * disagreeing about somebody's level. */
  it('builds both responses from the same helper', async () => {
    const vip = await read('services/api-gateway/src/routes/vip.ts');
    assert.match(vip, /\.\.\.vipStandingFor\(wagered\)/);
    assert.doesNotMatch(vip, /rateGainPercent: next \?/);
  });

  it('merges the standing into the store instead of replacing it', async () => {
    const store = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/store.js');
    const refresh = store.slice(store.indexOf('export async function refreshBalance'));
    /* A plain assignment would drop `levels` and `rakeback`, which only the full /v1/vip fetch
     * carries, and blank the VIP page every time a round settled. */
    assert.match(refresh, /state\.vip = \{ \.\.\.\(state\.vip \|\| \{\}\), \.\.\.balance\.vip \}/);
  });

  it('leaves the VIP page standing up when only the merged half has arrived', async () => {
    const page = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/vip.js');
    assert.match(page, /if \(data\.levels\) root\.appendChild\(matrix\(data\)\)/);
    assert.match(page, /data\.rakeback \? money\(Number\(data\.rakeback\.claimableMinor\)\) : '—'/);
  });
});

/**
 * Max filled the stake box with "100101.5k" for a balance of a hundred million.
 *
 * formatAmountInput walked t -> b -> m -> k and took the first unit that fitted in two decimal
 * places. 100,101,500 is not two decimals of a million, so it fell through to thousands: exact,
 * round-tripping, and unreadable.
 */
describe('the amount a Max button writes into the box', () => {
  const load = async () => {
    const source = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/util.js');
    return source;
  };

  it('uses the unit the figure belongs to, or none at all', async () => {
    const source = await load();
    const fn = source.slice(source.indexOf('export function formatAmountInput'));
    // The fall-through that produced "100101.5k" is gone: a unit too small is skipped, not used.
    assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /n % \(scale \/ 100\)/);
    assert.match(fn, /if \(n < scale\) continue;/);
    // And the round trip is checked rather than assumed.
    assert.match(fn, /parseAmount\(candidate\) === n/);
  });
});
