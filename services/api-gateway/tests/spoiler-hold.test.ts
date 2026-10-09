import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

/* No result reaches the screen before the game shows it.
 *
 * A wager is decided when the server answers, but the player is told by an animation that runs for
 * seconds afterwards. While it runs, the wallet pill, the live feed, the deposit poll and the
 * jackpot bar are held still (store.js holdLiveFigures). These tests run the real store module
 * against a fetch whose answers are handed out by hand, so a request can be left in flight while a
 * round starts -- the races that let a result through even with the hold in place. */

const repo = path.resolve(import.meta.dirname, '../../..');
const js = (name: string) => path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js', name);

type Pending = { url: string; method: string; answer: (status: number, payload: unknown) => void };
const pending: Pending[] = [];

function handFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return new Promise((resolve) => {
    pending.push({
      url: String(url),
      method: init?.method ?? 'GET',
      answer: (status, payload) =>
        resolve(new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })),
    });
  });
}

/** The next request the page sends, once it has sent it. */
async function nextRequest(): Promise<Pending> {
  for (let tick = 0; tick < 50 && pending.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const request = pending.shift();
  assert.ok(request, 'expected the page to send a request');
  return request;
}

/** Lets every queued promise run, then reports whether anything was sent. */
async function sentNothing(): Promise<boolean> {
  for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return pending.length === 0;
}

/** Answers whatever is still out, so a settle that refreshes everything can finish. */
async function drain(until: Promise<unknown>): Promise<void> {
  let done = false;
  void until.finally(() => { done = true; }).catch(() => undefined);
  for (let round = 0; round < 40 && !done; round += 1) {
    while (pending.length) {
      pending.shift()!.answer(200, { items: [], activities: [], transactions: [], serverSeedHash: 'seed' });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;

/* Answers anything a previous test left out (a settle's follow-up refreshes, the top-pulls ask a
 * feed refresh starts), so each test reads only the requests it caused. */
async function clearLeftovers(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) {
    while (pending.length) {
      pending.shift()!.answer(200, { items: [], activities: [], transactions: [], serverSeedHash: 'seed' });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(clearLeftovers);
after(clearLeftovers);

before(async () => {
  Object.assign(globalThis, {
    window: { location: { protocol: 'https:', origin: 'https://donutwin.fun' } },
    document: { querySelector: () => null, cookie: '' },
    fetch: handFetch,
  });
  store = await import(pathToFileURL(js('store.js')).href);
  store.state.authenticated = true;
});

/* A regression must fail, not hang: every wait below is on a request the test answers itself. */
const LIMIT = { timeout: 10_000 };

describe('a refresh already in flight when a round starts', LIMIT, () => {
  it('does not move the wallet pill with an answer that may carry the result', async () => {
    store.state.balanceMinor = '1000';
    const refresh = store.refreshBalance();
    const request = await nextRequest();
    assert.match(request.url, /\/v1\/balance$/);

    // The player bets while the poll is out; the server settles the round before answering it.
    const release = store.holdLiveFigures();
    try {
      request.answer(200, { balanceMinor: '5000' });
      await refresh;
      assert.equal(store.state.balanceMinor, '1000', 'a pre-bet poll printed the post-round balance');
    } finally {
      // Once the game has shown the result, the next refresh applies as normal.
      release();
    }
    const again = store.refreshBalance();
    (await nextRequest()).answer(200, { balanceMinor: '5000' });
    await again;
    assert.equal(store.state.balanceMinor, '5000');
  });

  it('does not put the player\'s own round in the live feed early', async () => {
    const before = [{ id: 'old' }];
    store.state.activities = before;
    const refresh = store.refreshActivity();
    const request = await nextRequest();
    assert.match(request.url, /\/v1\/activity\/recent/);

    const release = store.holdLiveFigures();
    try {
      request.answer(200, { activities: [] });
      await refresh;
      assert.equal(store.state.activities, before, 'a pre-bet feed refresh landed mid-round');
    } finally {
      release();
    }
  });

  it('does not let the deposit poll correct the pill from the round\'s own transaction', async () => {
    // The first poll of a session only notes where the ledger stands.
    const first = store.pollDeposits();
    (await nextRequest()).answer(200, {
      transactions: [{ id: 'seen', kind: 'cash_deposit', balance_after_minor: '1000' }],
    });
    await first;
    store.state.balanceMinor = '1000';

    const poll = store.pollDeposits();
    const request = await nextRequest();
    assert.match(request.url, /\/v1\/balance\/transactions/);
    const release = store.holdLiveFigures();
    try {
      request.answer(200, {
        transactions: [
          { id: 'win-row', kind: 'upgrade_win', balance_after_minor: '9999' },
          { id: 'seen', kind: 'cash_deposit', balance_after_minor: '1000' },
        ],
      });
      assert.deepEqual(await poll, []);
      assert.equal(store.state.balanceMinor, '1000', 'the deposit poll moved the pill to the round result');
    } finally {
      release();
    }
  });

  it('does not ask at all while a round is playing', async () => {
    const release = store.holdLiveFigures();
    try {
      await store.refreshBalance();
      await store.refreshActivity();
      assert.ok(await sentNothing(), 'a held refresh still went to the server');
    } finally {
      release();
    }
  });
});

describe('the upgrader', LIMIT, () => {
  it('holds the wallet from before the spin request, not from its answer', async () => {
    /* The server publishes its balance event while it settles the round, and that event can arrive
     * before the HTTP answer. The hold has to be on by then. */
    store.state.fairness = { serverSeedHash: 'seed' };
    store.state.balanceMinor = '1000';
    const run = store.runBalanceUpgrade('100', { catalogItemId: 'item', unitValueMinor: '300' }, { defer: true });
    const post = await nextRequest();
    assert.equal(post.method, 'POST');
    assert.match(post.url, /\/v1\/upgrades$/);

    // The server's balance event lands now: the page must not fetch the balance.
    const refreshing = store.refreshBalance();
    const fetched = !(await sentNothing());
    while (pending.length) pending.shift()!.answer(200, { balanceMinor: '1200' });
    await refreshing;
    post.answer(200, { round: { outcome: 'win', balance_after_minor: '1200' } });
    const response = await run;
    assert.equal(fetched, false, 'the balance was fetched while the spin request was out');
    assert.equal(store.state.balanceMinor, '1000', 'the pill moved before the wheel stopped');

    // The wheel stops: settle applies the round's own closing balance at once.
    const settle = response.settle();
    assert.equal(store.state.balanceMinor, '1200');
    await drain(settle);
    await settle;
  });

  it('lets go of the hold when the spin request fails', async () => {
    const run = store.runBalanceUpgrade('100', { catalogItemId: 'item', unitValueMinor: '300' }, { defer: true });
    (await nextRequest()).answer(500, { error: { code: 'BROKEN', message: 'no' } });
    await assert.rejects(run);
    // No round exists, so nothing may stay frozen.
    const refresh = store.refreshBalance();
    (await nextRequest()).answer(200, { balanceMinor: '777' });
    await refresh;
    assert.equal(store.state.balanceMinor, '777');
  });
});

describe('the pages that hold for their own rounds', LIMIT, () => {
  it('roulette holds from the first chip, before the bet is sent', async () => {
    /* Waiting for the spin was too late: winners' balance events reach the page before the
     * round's own event, and the pill moved before the wheel began to turn. */
    const source = await readFile(js('roulette.js'), 'utf8');
    const place = source.slice(source.indexOf('async function place('));
    const body = place.slice(0, place.indexOf('\n}\n'));
    assert.ok(
      body.indexOf('takeSpinHold()') > -1 && body.indexOf('takeSpinHold()') < body.indexOf('api.post('),
      'place() must take the hold before it posts the bet',
    );
    assert.doesNotMatch(body, /refreshBalance\(\)/, 'a refresh is what the hold stops; the stake moves locally');
    assert.match(body, /showBalance\(\(before - placedAmount\)\.toString\(\)\)/);
    // Kept in step with the table on every refresh, and let go when the player leaves the page.
    assert.match(source, /function syncBetHold\(\)/);
    assert.match(source, /setWheel\(newest\.result\);\s*syncBetHold\(\);/);
    assert.match(source, /onNavigate\(\(\) => \{\s*if \(view\.hidden && spinHold\) \{\s*releaseSpinHold\(\);/);
  });

  it('the jackpot bar does not show a draw while a round is playing', async () => {
    /* The draw happens inside the transaction that settles a round; mid-spin the bar could show the
     * player's own win before their reel or wheel did. */
    const source = await readFile(js('vault-jackpot.js'), 'utf8');
    const poll = source.slice(source.indexOf('async function poll()'));
    const body = poll.slice(0, poll.indexOf('\n}\n'));
    assert.ok(body.indexOf('liveFiguresFresh(epoch)') < body.indexOf("api.get('/v1/social/jackpot')"));
    assert.ok(body.lastIndexOf('liveFiguresFresh(epoch)') > body.indexOf("api.get('/v1/social/jackpot')"));
  });

  it('every game with an animated result holds before its request', async () => {
    const holds: Record<string, RegExp> = {
      'blackjack.js': /const release = holdLiveFigures\(\);\s*try \{[\s\S]*?api\.post\(\s*'\/v1\/blackjack\/hands'/,
      'plinko.js': /release: holdLiveFigures\(\)/,
      'coinflip.js': /hold = holdLiveFigures\(\)/,
      'mines-duel.js': /hold = holdLiveFigures\(\)/,
      'battles.js': /seatHold = holdLiveFigures\(\)/,
      'crates.js': /requestCaseOpen\(crate, \{ defer: true \}\)/,
      'upgrader.js': /runBalanceUpgrade\([^;]*\{ defer: true \}\)/,
    };
    for (const [file, pattern] of Object.entries(holds)) {
      assert.match(await readFile(js(file), 'utf8'), pattern, `${file} no longer holds the live figures`);
    }
  });
});
