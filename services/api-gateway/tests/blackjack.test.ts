import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/lib/db.js';
import {
  BLACKJACK_HOUSE_EDGE_BPS,
  BLACKJACK_RULES,
  cardValue,
  compareHands,
  dealerShouldHit,
  drawCard,
  handTotal,
  isBlackjack,
  payoutFor,
} from '../src/lib/blackjack.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

// Faces: rank = face % 13 (0 = ace, 9..12 = 10 J Q K), suit = floor(face / 13).
const A = 0;
const TWO = 1;
const FIVE = 4;
const SIX = 5;
const SEVEN = 6;
const NINE = 8;
const TEN = 9;
const KING = 12;

describe('blackjack hands', () => {
  it('values cards and keeps an ace soft until it would bust', () => {
    assert.equal(cardValue(A), 11);
    assert.equal(cardValue(TWO), 2);
    assert.equal(cardValue(KING), 10);
    assert.equal(cardValue(KING + 13 * 3), 10);
    assert.deepEqual(handTotal([A, SIX]), { total: 17, soft: true });
    assert.deepEqual(handTotal([A, SIX, NINE]), { total: 16, soft: false });
    assert.deepEqual(handTotal([A, A, NINE]), { total: 21, soft: true });
    assert.deepEqual(handTotal([KING, SIX, SEVEN]), { total: 23, soft: false });
    assert.ok(isBlackjack([A, KING]));
    assert.ok(!isBlackjack([SEVEN, SEVEN, SEVEN]));
  });

  it('has the dealer hit soft 17 and stand on hard 17', () => {
    assert.ok(dealerShouldHit([A, SIX]));
    assert.ok(!dealerShouldHit([TEN, SEVEN]));
    assert.ok(dealerShouldHit([TEN, SIX]));
    assert.ok(!dealerShouldHit([A, SEVEN]));
  });

  it('gives ties to the dealer and a bust dealer to the player', () => {
    assert.equal(compareHands([TEN, NINE], [TEN, SEVEN + 1]), 'win');
    assert.equal(compareHands([TEN, SEVEN], [TEN, SEVEN]), 'tie');
    assert.equal(compareHands([TEN, SIX], [TEN, SEVEN]), 'lose');
    assert.equal(compareHands([TEN, TWO], [TEN, SIX, KING]), 'win');
  });

  it('pays 3:2 on a natural, even money on a win, the stake on a push, nothing on a tie', () => {
    assert.equal(payoutFor('blackjack', 1_000_000n, false), 2_500_000n);
    assert.equal(payoutFor('blackjack', 3n, false), 7n); // 3:2 rounds down to the whole dollar
    assert.equal(payoutFor('win', 1_000_000n, false), 2_000_000n);
    assert.equal(payoutFor('win', 1_000_000n, true), 4_000_000n);
    assert.equal(payoutFor('push', 1_000_000n, false), 1_000_000n);
    for (const outcome of ['tie', 'lose', 'bust', 'dealer_blackjack'] as const) {
      assert.equal(payoutFor(outcome, 1_000_000n, true), 0n);
    }
  });

  it('draws the same card for the same seed and position, from all 52 faces evenly', () => {
    const seed = 'a'.repeat(64);
    assert.equal(drawCard(seed, 'client', 0, 5), drawCard(seed, 'client', 0, 5));
    assert.notEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((p) => drawCard(seed, 'client', 0, p)).join(),
      [0, 1, 2, 3, 4, 5, 6, 7].map((p) => drawCard(seed, 'client', 1, p)).join(),
    );
    const counts = new Array(52).fill(0);
    for (let s = 0; s < 260; s += 1) {
      const server = randomBytes(32).toString('hex');
      for (let p = 0; p < 40; p += 1) counts[drawCard(server, 'c', 0, p)] += 1;
    }
    // 10,400 draws: 200 expected per face; a biased mapping would miss this by far more than 40%.
    for (const count of counts) assert.ok(count > 120 && count < 280, `face count ${count}`);
  });
});

/**
 * The house edge, recomputed exactly: infinite deck, optimal hit / stand / double on the first two
 * cards, dealer peeks and hits soft 17, ties to the dealer except blackjack against blackjack,
 * 3:2 naturals. If the engine's published figure or its rules drift from this, the table is not
 * charging what it says it charges.
 */
describe('the house edge', () => {
  const P = [0, 0, ...Array(8).fill(1 / 13), 4 / 13, 1 / 13];
  const CARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const add = (t: number, s: number, c: number): [number, number] => {
    let total = t + c;
    let soft = s + (c === 11 ? 1 : 0);
    while (total > 21 && soft > 0) { total -= 10; soft -= 1; }
    return [total, soft];
  };
  const isNatural = (a: number, b: number) => (a === 11 && b === 10) || (a === 10 && b === 11);

  function edge(): number {
    let ev = 0;
    for (const up of CARDS) {
      const pNatural = up === 11 ? P[10]! : up === 10 ? P[11]! : 0;
      const dist = new Map<number | 'bust', number>();
      const play = (t: number, s: number, p: number): void => {
        if (t > 21) { dist.set('bust', (dist.get('bust') ?? 0) + p); return; }
        if (t > 17 || (t === 17 && !(BLACKJACK_RULES.dealerHitsSoft17 && s > 0))) {
          dist.set(t, (dist.get(t) ?? 0) + p);
          return;
        }
        for (const c of CARDS) { const [nt, ns] = add(t, s, c); play(nt, ns, p * P[c]!); }
      };
      for (const c of CARDS) {
        if (isNatural(up, c)) continue;
        const [t, s] = add(up, up === 11 ? 1 : 0, c);
        play(t, s, P[c]! / (1 - pNatural));
      }
      const stand = (t: number) => {
        let e = 0;
        for (const [k, p] of dist) {
          if (k === 'bust' || t > k) e += p;
          else if (t < k || BLACKJACK_RULES.tiesGoToDealer) e -= p;
        }
        return e;
      };
      const memo = new Map<string, number>();
      const best = (t: number, s: number): number => {
        if (t > 21) return -1;
        const key = `${t},${s}`;
        const cached = memo.get(key);
        if (cached !== undefined) return cached;
        let hit = 0;
        for (const c of CARDS) { const [nt, ns] = add(t, s, c); hit += P[c]! * best(nt, ns); }
        const value = Math.max(stand(t), hit);
        memo.set(key, value);
        return value;
      };
      let upEv = 0;
      for (const a of CARDS) for (const b of CARDS) {
        const natural = isNatural(a, b);
        let [t, s] = [a + b, (a === 11 ? 1 : 0) + (b === 11 ? 1 : 0)];
        while (t > 21 && s > 0) { t -= 10; s -= 1; }
        let double = 0;
        for (const c of CARDS) { const [nt] = add(t, s, c); double += P[c]! * (nt > 21 ? -1 : stand(nt)); }
        const played = Math.max(best(t, s), 2 * double);
        const onDealerNatural = natural && BLACKJACK_RULES.blackjackPushesBlackjack ? 0 : -1;
        const noDealerNatural = natural ? 1.5 : played;
        upEv += P[a]! * P[b]! * (pNatural * onDealerNatural + (1 - pNatural) * noDealerNatural);
      }
      ev += P[up]! * upEv;
    }
    return -ev;
  }

  it('is the 9.89% the table publishes, under perfect play', () => {
    const exact = edge();
    assert.ok(Math.abs(exact * 10_000 - BLACKJACK_HOUSE_EDGE_BPS) < 1, `computed ${exact}`);
    // "About ten per cent" is the brief; the site's margin engines assume HOUSE_EDGE_BPS = 1000.
    assert.ok(exact > 0.095 && exact < 0.105);
  });

  it('does not offer the rules the edge was computed without', () => {
    assert.equal(BLACKJACK_RULES.split, false);
    assert.equal(BLACKJACK_RULES.insurance, false);
    assert.equal(BLACKJACK_RULES.blackjackPays, '3:2');
  });
});

describe('the blackjack routes', () => {
  const route = () => read('services/api-gateway/src/routes/blackjack.ts');

  it('never shows the hole card or the seed while the hand is in play', async () => {
    const source = await route();
    const view = source.slice(source.indexOf('function handView('), source.indexOf('export async function registerBlackjackRoutes'));
    assert.match(view, /cards: settled \? row\.dealer_cards : \[row\.dealer_cards\[0\], null\]/);
    assert.match(view, /serverSeed: settled \? row\.server_seed_reveal : null/);
    // And the seed is written into the hand only by settle().
    const writes = source.split('server_seed_reveal = $4').length - 1;
    assert.equal(writes, 1);
    assert.match(source.slice(source.indexOf('async function settle(')), /server_seed_reveal = \$4/);
  });

  it('deals against the committed seed, spends it, and commits the next one', async () => {
    const source = await route();
    const deal = source.slice(source.indexOf("'/v1/blackjack/hands',"), source.indexOf("'/v1/blackjack/hands/:id/actions'"));
    assert.match(deal, /fairness\.server_seed_hash !== body\.serverSeedHash/);
    assert.match(deal, /UPDATE fairness_seeds SET used_at = now\(\) WHERE id = \$1/);
    assert.match(deal, /await insertFairnessSeed\(client, config, userId\)/);
    // A closed table refuses new hands only; the actions route has no such check.
    assert.match(deal, /config\.blackjackEnabled/);
    const actions = source.slice(source.indexOf("'/v1/blackjack/hands/:id/actions'"), source.indexOf('interface Settlement'));
    assert.doesNotMatch(actions, /blackjackEnabled/);
  });

  it('refuses a stale action and a late double, and charges a double as a second stake', async () => {
    const source = await route();
    assert.match(source, /row\.player_cards\.length !== body\.cardsInHand/);
    assert.match(source, /if \(doubled \|\| player\.length !== 2\)/);
    assert.match(source, /await debit\(client, userId, BigInt\(row\.stake_minor\), 'blackjack_double', row\.id\)/);
  });

  it('records the whole amount on the table as one wager, at settlement', async () => {
    const source = await route();
    const settle = source.slice(source.indexOf('async function settle('), source.indexOf('async function debit('));
    assert.match(settle, /const onTable = row\.doubled \? stake \* 2n : stake;/);
    assert.match(settle, /recordWager\(client, config, row\.user_id, onTable, 'blackjack', row\.id/);
    assert.match(settle, /creditWallet\(client, row\.user_id, payout, 'blackjack_payout', row\.id\)/);
  });

  it('only widens the constraints it touches', async () => {
    const kinds = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/049_blackjack.sql');
    const ledgerBefore = kinds(await read('packages/db/migrations/048_signup_bonus_and_wager_requirements.sql'), 'wallet_transactions_kind_check');
    const ledgerAfter = kinds(migration, 'wallet_transactions_kind_check');
    for (const kind of ledgerBefore) assert.ok(ledgerAfter.has(kind), `049 drops ${kind}`);
    assert.equal(ledgerAfter.size, ledgerBefore.size + 3);
    const roulette = await read('packages/db/migrations/039_shared_roulette.sql');
    for (const constraint of ['wager_events_source_check', 'faction_contributions_source_check', 'referral_earnings_source_check']) {
      const before = kinds(roulette, constraint);
      const after = kinds(migration, constraint);
      for (const source of before) assert.ok(after.has(source), `049 drops ${source} from ${constraint}`);
      assert.ok(after.has('blackjack'));
    }
    assert.match(migration, /CREATE UNIQUE INDEX blackjack_hands_one_active_idx ON blackjack_hands \(user_id\) WHERE status = 'active'/);
  });

  it('publishes its rules and edge to visitors who have not signed in', async () => {
    const config = loadConfig({
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
      LOG_LEVEL: 'silent',
    });
    const database = { query: async () => ({ rows: [], rowCount: 0 }), close: async () => undefined } as unknown as Database;
    const app = await buildApp(config, database);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/blackjack/config' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.houseEdgeBps, 989);
      assert.equal(body.rules.tiesGoToDealer, true);
      assert.equal(body.minStakeMinor, '100000');
      assert.equal(body.enabled, true);
    } finally {
      await app.close();
    }
  });
});
