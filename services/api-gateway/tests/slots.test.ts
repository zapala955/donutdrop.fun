import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  OCEAN_MONUMENT,
  ORE_RUSH,
  SLOTS_FREE_MULTIPLIER,
  SLOTS_HOUSE_EDGE_BPS,
  SLOTS_LINES,
  SLOTS_MAX_FREE_SPINS,
  SLOTS_MAX_WIN_X,
  SLOTS_SCATTER,
  SLOTS_SCATTER_PAY_X,
  SLOTS_SCATTER_SPINS,
  SLOTS_STRIPS,
  SLOTS_SYMBOLS,
  SLOTS_WILD,
  evaluateWindow,
  maxStakeFor,
  playRound,
  roundFromStops,
  spinStops,
  windowOf,
  type SlotMachine,
} from '../src/lib/slots.js';

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');
const route = () => read('services/api-gateway/src/routes/slots.ts');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

const count = (reel: number, symbol: number) => SLOTS_STRIPS[reel]!.filter((s) => s === symbol).length;
/** The top-row stop that puts `symbol` on `row` of `reel`. */
const stopFor = (reel: number, symbol: number, row: number) => {
  const strip = SLOTS_STRIPS[reel]!;
  return (strip.indexOf(symbol) - row + strip.length) % strip.length;
};

/**
 * A machine's return as an exact fraction. Every reel stops uniformly, so the symbol on any one row
 * of a reel is the strip's own mix and the reels are independent: each line's pay, a wild's
 * multiplier on it, and the number of scatters showing all follow from the symbol counts alone.
 * Everything is a whole number over D, the number of stop combinations.
 */
function exactReturn(machine: SlotMachine) {
  const strips = machine.strips;
  const tally = (reel: number, symbol: number) => strips[reel]!.filter((s) => s === symbol).length;
  const L = strips.map((strip) => BigInt(strip.length));
  const D = L.reduce((a, b) => a * b, 1n);
  const m = BigInt(machine.wildMultiplier);
  let lineNum = 0n; // expected pay of one line, in line bets, over D
  for (let symbol = 0; symbol < machine.wild; symbol += 1) {
    const pays = machine.symbols[symbol]!.pays;
    /* A run of exactly k from reel 1: the symbol on reel 1, the symbol or a wild on reels 2..k (a
     * wild counting m times over, its multiplier), and on reel k+1 neither. */
    const exactly = (k: number) => {
      let num = BigInt(tally(0, symbol));
      for (let reel = 1; reel < 5; reel += 1) {
        if (reel < k) num *= BigInt(tally(reel, symbol)) + m * BigInt(tally(reel, machine.wild));
        else if (reel === k) num *= L[reel]! - BigInt(tally(reel, symbol) + tally(reel, machine.wild));
        else num *= L[reel]!;
      }
      return num;
    };
    lineNum += exactly(3) * BigInt(pays[0]!) + exactly(4) * BigInt(pays[1]!) + exactly(5) * BigInt(pays[2]!);
  }
  // Ten lines at a tenth of the stake each: one line's expected pay in line bets is the spin's in stakes.

  let books = [D]; // books[k] = P(k scatters showing), over D; one per strip, so three stops in L show it
  for (let reel = 0; reel < 5; reel += 1) {
    const next = new Array<bigint>(books.length + 1).fill(0n);
    books.forEach((p, k) => {
      next[k] = next[k]! + (p * (L[reel]! - 3n)) / L[reel]!;
      next[k + 1] = next[k + 1]! + (p * 3n) / L[reel]!;
    });
    books = next;
  }
  let scatterNum = 0n;
  let spinsNum = 0n;
  for (const k of [3, 4, 5]) {
    scatterNum += books[k]! * BigInt(machine.scatterPayX[k]!);
    spinsNum += books[k]! * BigInt(machine.scatterSpins[k]!);
  }
  /* A free spin pays twice a paid one and awards free spins at the same rate r, so a round returns
   * base · (1 + 2r / (1 − r)) = base · (1 + r) / (1 − r). */
  assert.equal(machine.freeMultiplier, 2);
  const baseNum = lineNum + scatterNum;
  return {
    D,
    books,
    num: baseNum * (D + spinsNum),
    den: D * (D - spinsNum),
    trigger: books[3]! + books[4]! + books[5]!,
  };
}

describe('slots engine', () => {
  it('returns 95.86% of the stake, exactly, and keeps the edge it reports', () => {
    // One book per strip, so a reel shows it in exactly three of its stops.
    for (let reel = 0; reel < 5; reel += 1) assert.equal(count(reel, SLOTS_SCATTER), 1, `reel ${reel + 1}`);
    const { D, books, num, den, trigger } = exactReturn(ORE_RUSH);
    // The division in the scatter sum is exact: D carries every reel's length once.
    assert.equal(books.reduce((a, b) => a + b, 0n), D);
    assert.equal(SLOTS_FREE_MULTIPLIER, 2);
    assert.ok(num * 10_000n <= den * 9_586n, 'returns more than 95.86%');
    assert.ok(num * 10_000n >= den * 9_585n, 'returns under 95.85%');
    // Rakeback and referral shares are cut from the reported edge, so it may never exceed the real one.
    assert.ok(num * 10_000n <= den * BigInt(10_000 - SLOTS_HOUSE_EDGE_BPS), 'reports more edge than it keeps');
    assert.ok(num * 10_000n > den * BigInt(10_000 - SLOTS_HOUSE_EDGE_BPS - 1), 'reports a basis point less than it keeps');
    // A free-spin round is about one paid spin in 143.
    assert.ok(D / trigger >= 140n && D / trigger <= 145n);
  });

  it('returns 95.85% on the Ocean Monument too, its Guardians doubling the lines they complete', () => {
    const machine = OCEAN_MONUMENT;
    for (let reel = 0; reel < 5; reel += 1) {
      const strip = machine.strips[reel]!;
      assert.equal(strip.length, 34);
      assert.equal(strip.filter((s) => s === machine.scatter).length, 1, `reel ${reel + 1}`);
      // No symbol sits beside itself, round the drum included.
      strip.forEach((symbol, i) => assert.notEqual(symbol, strip[(i + 1) % strip.length], `reel ${reel + 1} at ${i}`));
    }
    // The Guardian sits on the middle reels only, so no line can start on one.
    assert.equal(machine.strips[0]!.includes(machine.wild) || machine.strips[4]!.includes(machine.wild), false);
    const { D, books, num, den, trigger } = exactReturn(machine);
    assert.equal(books.reduce((a, b) => a + b, 0n), D);
    assert.ok(num * 10_000n <= den * 9_586n, 'returns more than 95.86%');
    assert.ok(num * 10_000n >= den * 9_585n, 'returns under 95.85%');
    assert.ok(num * 10_000n <= den * BigInt(10_000 - machine.houseEdgeBps), 'reports more edge than it keeps');
    assert.ok(num * 10_000n > den * BigInt(10_000 - machine.houseEdgeBps - 1), 'reports a basis point less than it keeps');
    // A free-spin round is about one paid spin in 167.
    assert.ok(D / trigger >= 160n && D / trigger <= 172n);
  });

  it('pays left to right, the Totem standing in for everything but the book', () => {
    const grid = (rows: number[][]) => rows[0]!.map((_, reel) => rows.map((row) => row[reel]!));
    const [R, I, G, E, A, Dm, N, S, W, B] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // Five stars across the middle: the top pay, one line.
    let result = evaluateWindow(grid([[R, I, G, E, A], [S, S, S, S, S], [R, I, G, E, A]]));
    assert.deepEqual(result.lines, [{ line: 0, symbol: S, count: 5, multiplier: 1, pays: 1000 }]);
    assert.equal(result.units, 1000);
    // Wilds extend a line; a book ends it.
    result = evaluateWindow(grid([[R, I, G, E, A], [Dm, W, W, B, Dm], [I, R, G, E, A]]));
    assert.deepEqual(result.lines.find((win) => win.line === 0), { line: 0, symbol: Dm, count: 3, multiplier: 1, pays: 20 });
    // A line that starts on a wild or a book pays nothing.
    result = evaluateWindow(grid([[B, R, I, G, E], [W, W, W, W, W], [B, I, R, E, G]]));
    assert.equal(result.lines.some((win) => win.line === 0 || win.line === 1 || win.line === 2), false);
    // Books pay anywhere, as a multiple of the stake (tenths of it here).
    result = evaluateWindow(grid([[B, R, I, G, E], [N, B, R, B, I], [G, E, A, N, R]]));
    assert.equal(result.books, 3);
    assert.equal(result.units - result.lines.reduce((sum, win) => sum + win.pays, 0), SLOTS_SCATTER_PAY_X[3]! * 10);
    // Ten lines, every one crossing each reel once.
    assert.equal(SLOTS_LINES.length, 10);
    for (const line of SLOTS_LINES) assert.ok(line.length === 5 && line.every((row) => row >= 0 && row <= 2));
    // The wild sits on the middle reels only, so no line can start on one.
    assert.equal(count(0, SLOTS_WILD) + count(4, SLOTS_WILD), 0);
  });

  it('doubles a Monument line for every Guardian in its run', () => {
    const grid = (rows: number[][]) => rows[0]!.map((_, reel) => rows.map((row) => row[reel]!));
    const [C, P, Sh, Cr, Na, Tr, Td, H, G, E] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const at = (rows: number[][]) => evaluateWindow(grid(rows), OCEAN_MONUMENT);
    // Five hearts through three Guardians: the top pay, eight times over.
    let result = at([[C, P, Sh, Cr, Na], [H, G, G, G, H], [C, P, Sh, Cr, Na]]);
    assert.deepEqual(result.lines.find((win) => win.line === 0), { line: 0, symbol: H, count: 5, multiplier: 8, pays: 750 * 8 });
    // One Guardian in a run of three doubles it; a Guardian past where the run ends does not count.
    result = at([[Na, Td, P, Sh, C], [Tr, G, Tr, Cr, G], [P, C, Sh, Na, Td]]);
    assert.deepEqual(result.lines.find((win) => win.line === 0), { line: 0, symbol: Tr, count: 3, multiplier: 2, pays: 30 });
    // No Guardian, no multiplier.
    result = at([[Na, Td, P, Sh, C], [Cr, Cr, Cr, Cr, Na], [P, C, Sh, Na, Td]]);
    assert.deepEqual(result.lines.find((win) => win.line === 0), { line: 0, symbol: Cr, count: 4, multiplier: 1, pays: 20 });
    // The Elder Guardian pays anywhere and ends a line; a line starting on a Guardian pays nothing.
    result = at([[E, C, P, Sh, Cr], [G, E, G, E, Na], [Td, Na, H, Tr, C]]);
    assert.equal(result.books, 3);
    assert.equal(result.lines.some((win) => win.line === 0), false);
    assert.equal(result.units - result.lines.reduce((sum, win) => sum + win.pays, 0), OCEAN_MONUMENT.scatterPayX[3]! * 10);
    // The same ten lines as Ore Rush.
    assert.equal(ORE_RUSH.wildMultiplier, 1);
  });

  it('draws every stop from the committed seed, exactly as a player can check it', () => {
    const seed = 'ab'.repeat(32);
    const stops = spinStops(seed, 'client', 3, 2);
    assert.deepEqual(spinStops(seed, 'client', 3, 2), stops);
    // An independent re-implementation of the published recipe agrees.
    const again = SLOTS_STRIPS.map((strip, reel) => {
      const digest = createHmac('sha256', seed).update(`client:3:2:${reel}`).digest('hex');
      return Math.floor((Number.parseInt(digest.slice(0, 13), 16) / 2 ** 52) * strip.length);
    });
    assert.deepEqual(stops, again);
    assert.notDeepEqual(spinStops(seed, 'client', 3, 3), stops);
    assert.notDeepEqual(spinStops(seed, 'other', 3, 2), stops);
    assert.deepEqual(windowOf(stops)[0], [0, 1, 2].map((row) => SLOTS_STRIPS[0]![(stops[0]! + row) % SLOTS_STRIPS[0]!.length]));
    // The Monument draws the same numbers and scales them to its own strips.
    const monument = spinStops(seed, 'client', 3, 2, OCEAN_MONUMENT);
    const recipe = OCEAN_MONUMENT.strips.map((strip, reel) => {
      const digest = createHmac('sha256', seed).update(`client:3:2:${reel}`).digest('hex');
      return Math.floor((Number.parseInt(digest.slice(0, 13), 16) / 2 ** 52) * strip.length);
    });
    assert.deepEqual(monument, recipe);
  });

  it('stops each reel evenly along its strip', () => {
    const draws = 31_000;
    const hits = SLOTS_STRIPS.map((strip) => new Array(strip.length).fill(0));
    for (let i = 0; i < draws; i += 1) {
      spinStops(randomBytes(32).toString('hex'), 'c', 0, 0).forEach((stop, reel) => { hits[reel]![stop] += 1; });
    }
    hits.forEach((reel, index) => {
      const expected = draws / reel.length;
      for (const seen of reel) assert.ok(Math.abs(seen - expected) < expected * 0.2, `reel ${index + 1}: ${seen} vs ${expected}`);
    });
  });

  it('plays the free spins in the same round, paid double, and replays from the stored stops', () => {
    const stake = 1_000_000n;
    let seed = '';
    let round = null as ReturnType<typeof playRound> | null;
    for (let tries = 0; tries < 20_000 && !round; tries += 1) {
      seed = randomBytes(32).toString('hex');
      const candidate = playRound(seed, 'c', 0, stake);
      if (candidate.freeSpins > 0) round = candidate;
    }
    assert.ok(round, 'no free-spin round in 20,000 seeds');
    assert.equal(round.spins.length, 1 + round.freeSpins);
    assert.equal(round.spins[0]!.free, false);
    assert.ok(round.spins.slice(1).every((spin) => spin.free));
    assert.ok(round.spins[0]!.awarded > 0);
    assert.equal(round.payoutMinor, round.spins.reduce((sum, spin) => sum + spin.payoutMinor, 0n));
    round.spins.forEach((spin, index) => {
      assert.deepEqual(spin.stops, spinStops(seed, 'c', 0, index));
      if (!round!.capped) {
        assert.equal(spin.payoutMinor, (stake * BigInt(spin.units) * BigInt(spin.free ? SLOTS_FREE_MULTIPLIER : 1)) / 10n);
      }
    });
    const replay = roundFromStops(stake, round.spins.flatMap((spin) => spin.stops));
    assert.equal(replay.payoutMinor, round.payoutMinor);
    assert.equal(replay.freeSpins, round.freeSpins);
    assert.throws(() => roundFromStops(stake, round!.spins[0]!.stops)); // a round cut short
    assert.throws(() => roundFromStops(stake, [...round!.spins.flatMap((spin) => spin.stops), 0, 0, 0, 0, 0]));
    // A Monument round replays on the Monument's strips, and only there.
    for (let tries = 0; tries < 20_000; tries += 1) {
      seed = randomBytes(32).toString('hex');
      const candidate = playRound(seed, 'c', 0, stake, OCEAN_MONUMENT);
      if (candidate.freeSpins === 0) continue;
      const flat = candidate.spins.flatMap((spin) => spin.stops);
      const again = roundFromStops(stake, flat, OCEAN_MONUMENT);
      assert.equal(again.payoutMinor, candidate.payoutMinor);
      assert.equal(again.freeSpins, candidate.freeSpins);
      candidate.spins.forEach((spin, index) => assert.deepEqual(spin.stops, spinStops(seed, 'c', 0, index, OCEAN_MONUMENT)));
      return;
    }
    assert.fail('no Monument free-spin round in 20,000 seeds');
  });

  it('ends a round at 1,000 stakes', () => {
    const stake = 777n;
    // Five books, then free spins with five stars across the middle: 100 stakes a line, doubled.
    const books = [0, 1, 2, 3, 4].map((reel) => stopFor(reel, SLOTS_SCATTER, 0));
    const stars = [0, 1, 2, 3, 4].map((reel) => stopFor(reel, 7, 1));
    const flat = [...books, ...Array.from({ length: 20 }, () => stars).flat()];
    const rounds = Array.from({ length: 21 }, (_, n) => {
      try {
        return roundFromStops(stake, flat.slice(0, 5 * (n + 1)));
      } catch {
        return null;
      }
    }).filter((round) => round !== null);
    assert.equal(rounds.length, 1);
    const round = rounds[0]!;
    assert.equal(round.capped, true);
    assert.equal(round.payoutMinor, stake * BigInt(SLOTS_MAX_WIN_X));
    assert.ok(round.freeSpins < 20);
    assert.equal(round.spins.at(-1)!.awarded, 0);
  });

  it('plays at most 100 free spins, however often the books come back', () => {
    // Three books and nothing else on every spin: every free spin retriggers.
    const window = (() => {
      // A book on each of reels 1-3 (one of its three rows), none on reels 4 and 5.
      const withBook = (reel: number) => [0, 1, 2].map((row) => stopFor(reel, SLOTS_SCATTER, row));
      const without = (reel: number) =>
        SLOTS_STRIPS[reel]!.map((_, top) => top).filter((top) => !withBook(reel).includes(top));
      for (const a of withBook(0)) for (const b of withBook(1)) for (const c of withBook(2)) {
        for (const d of without(3)) for (const e of without(4)) {
          const stops = [a, b, c, d, e];
          const result = evaluateWindow(windowOf(stops));
          if (result.books === 3 && result.lines.length === 0) return stops;
        }
      }
      return null;
    })();
    assert.ok(window);
    const flat = Array.from({ length: 1 + SLOTS_MAX_FREE_SPINS }, () => window).flat();
    const round = roundFromStops(1_000n, flat);
    assert.equal(round.freeSpins, SLOTS_MAX_FREE_SPINS);
    assert.equal(round.capped, false);
    assert.ok(round.spins.reduce((sum, spin) => sum + spin.awarded, 0) === SLOTS_MAX_FREE_SPINS);
  });

  it('sizes the largest stake to the payout ceiling', () => {
    assert.equal(maxStakeFor(50_000_000_000n), 50_000_000n);
    assert.ok(maxStakeFor(50_000_000_000n) * BigInt(SLOTS_MAX_WIN_X) <= 50_000_000_000n);
  });
});

describe('slots routes', () => {
  it('settles the whole round in the request that stakes it, once', async () => {
    const source = await route();
    const spin = source.slice(source.indexOf("'/v1/slots/spins',\n    /*"), source.indexOf('async function debit('));
    // A retried request gets its first answer back and pays nothing again.
    assert.match(spin, /SELECT \* FROM slots_spins WHERE user_id = \$1 AND idempotency_key = \$2/);
    assert.match(spin, /return \{ row: existing\.rows\[0\], wager: null/);
    // Stake first, refusing an overdraft; the round's pay is the only credit.
    assert.ok(spin.indexOf('await debit(') < spin.indexOf('creditWallet('));
    assert.match(source, /WHERE user_id = \$1 AND balance_minor >= \$2/);
    assert.equal(source.split('creditWallet(').length - 1, 1);
    assert.match(spin, /creditWallet\(client, userId, payout, 'slots_payout', spinId\)/);
    // Counted once, as Slots, at the slot's own edge; free spins are not new wagers.
    assert.match(spin, /recordWager\(\s*client,\s*config,\s*userId,\s*stake,\s*'slots',\s*spinId,/);
    assert.match(spin, /\(stake \* BigInt\(machine\.houseEdgeBps\)\) \/ 10_000n/);
    assert.equal(source.split('recordWager(').length - 1, 1);
    assert.doesNotMatch(source, /UPDATE slots_spins/);
  });

  it('spends the seed with the spin and hands back the next commitment', async () => {
    const source = await route();
    assert.match(source, /FROM fairness_seeds WHERE user_id = \$1 AND used_at IS NULL FOR UPDATE/);
    assert.match(source, /UPDATE fairness_seeds SET used_at = now\(\) WHERE id = \$1/);
    assert.match(source, /await insertFairnessSeed\(client, config, userId\)/);
    assert.match(source, /conflict\('FAIRNESS_COMMITMENT_CHANGED'/);
    assert.match(source, /const round = playRound\(serverSeed, body\.clientSeed, fairness\.nonce, stake, machine\)/);
    assert.match(source, /nextServerSeedHash: next/);
  });

  it('refuses a stake the 1,000x ceiling could not pay, and opens and closes from the settings', async () => {
    const source = await route();
    assert.match(source, /const ceiling = maxStakeFor\(config\.slotsMaxPayoutMinor\)/);
    assert.match(source, /if \(stake > ceiling\)/);
    assert.match(source, /'STAKE_OVER_PAYOUT_LIMIT'/);
    assert.match(source, /if \(!config\.slotsEnabled\)/);
    const settings = await read('services/api-gateway/src/lib/runtime-settings.ts');
    for (const key of ['slotsEnabled', 'slotsMinStakeMinor', 'slotsMaxStakeMinor', 'slotsMaxPayoutMinor']) {
      assert.match(settings, new RegExp(`${key}: \\{\\n    kind: '(boolean|bigint)',\\n    group: 'slots',`));
    }
    const media = await read('services/api-gateway/src/lib/media-test.ts');
    assert.match(media, /'POST \/v1\/slots\/spins',/);
    const stats = await read('services/api-gateway/src/lib/admin-stats.ts');
    assert.match(stats, /key: 'slots', label: 'Slots', stakes: \['slots_stake'\], payouts: \['slots_payout'\]/);
  });

  it('only widens the constraints it touches, and never lets the runtime rewrite a spin', async () => {
    const kinds = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/072_slots.sql');
    const previous = await read('packages/db/migrations/069_chicken.sql');
    for (const constraint of [
      'wallet_transactions_kind_check',
      'wager_events_source_check',
      'faction_contributions_source_check',
      'referral_earnings_source_check',
    ]) {
      const before = kinds(previous, constraint);
      const after = kinds(migration, constraint);
      for (const value of before) assert.ok(after.has(value), `072 drops ${value} from ${constraint}`);
      assert.equal(after.size, before.size + (constraint === 'wallet_transactions_kind_check' ? 2 : 1));
    }
    assert.ok(kinds(migration, 'wallet_transactions_kind_check').has('slots_stake'));
    assert.ok(kinds(migration, 'wallet_transactions_kind_check').has('slots_payout'));
    assert.ok(kinds(migration, 'wager_events_source_check').has('slots'));
    assert.match(migration, /GRANT SELECT, INSERT ON TABLE slots_spins TO donut_api_runtime;/);
    assert.match(migration, /UNIQUE \(fairness_seed_id\)/);
    assert.match(migration, /CHECK \(cardinality\(stops\) = 5 \* \(1 \+ free_spins\)\)/);
    assert.match(migration, /CHECK \(payout_minor <= stake_minor \* 1000\)/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v72\(\) RETURNS boolean/);
  });

  it('plays the machine a request names, Ore Rush when it names none, and replays it on its own strips', async () => {
    const source = await route();
    assert.match(source, /machine: machineSchema\.default\('ore-rush'\),/);
    assert.match(source, /const machine = SLOTS_MACHINES\[body\.machine\];/);
    assert.match(source, /roundFromStops\(stake, row\.stops\.map\(Number\), SLOTS_MACHINES\[row\.machine\]\)/);
    assert.match(source, /const machine = SLOTS_MACHINES\[parseWith\(configSchema, request\.query \?\? \{\}\)\.machine\];/);
    assert.match(source, /mode: machine\.label, multiplier: row\.multiplier_bps \/ 10_000, path: machine\.path/);
    const migration = await read('packages/db/migrations/072_slots.sql');
    assert.match(migration, /machine text NOT NULL DEFAULT 'ore-rush' CHECK \(machine IN \('ore-rush', 'monument'\)\),/);
    const activity = await read('services/api-gateway/src/routes/activity.ts');
    assert.equal(activity.split("CASE s.machine WHEN 'monument' THEN 'Ocean Monument' ELSE 'Ore Rush' END AS source_name").length - 1, 2);
  });

  it('reads only the newest spins into the live feed', async () => {
    const activity = await read('services/api-gateway/src/routes/activity.ts');
    assert.match(activity, /FROM \(SELECT \* FROM slots_spins ORDER BY created_at DESC LIMIT \$1\) s/);
    // Players counted per machine: the lobby's two cards each say who is at them.
    assert.match(activity, /SELECT CASE s\.machine WHEN 'monument' THEN 'monument' ELSE 'slots' END, s\.user_id\s+FROM slots_spins s, since WHERE s\.created_at > since\.at/);
  });
});

describe('the slots page', () => {
  it('is a routed, indexed page, Ore Rush at /ore-rush, with a card in the Slots row and a sidebar link', async () => {
    const [html, app, nginx, sitemap, seo, data, admin] = await Promise.all([
      front('index.html'),
      front('assets/js/app.js'),
      read('infra/nginx/nginx.conf'),
      front('sitemap.xml'),
      front('assets/js/seo.js'),
      front('assets/js/data.js'),
      front('admin/admin.js'),
    ]);
    assert.match(html, /<section class="view" data-view="ore-rush" hidden>/);
    assert.match(html, /<h1>Ore Rush<\/h1>\s*<span class="phead__tag">DonutLuxe Slots<\/span>/);
    assert.match(html, /<div class="slots" id="slotsRoot"><\/div>/);
    assert.match(html, /<a class="gcard lxcard" href="\/ore-rush" data-cat="casino" data-game="ore-rush"/);
    // Its player count is still keyed by the game id the server counts it under.
    assert.match(html, /<p class="lxlive" data-live="slots" hidden>/);
    assert.match(html, /<a class="lxnav" href="\/ore-rush" data-route="ore-rush" data-tip="Ore Rush">/);
    assert.match(html, /href="assets\/css\/slots\.css"/);
    assert.match(html, /<link rel="modulepreload" href="assets\/js\/slots\.js" \/>/);
    assert.match(app, /'ore-rush': mountSlots,/);
    assert.match(app, /slots: \{ name: 'Ore Rush', art: 'assets\/img\/items\/diamond\.png' \}/);
    assert.match(nginx, /\|coinflip\|ore-rush\|/);
    assert.match(nginx, /\/ore-rush "https:\/\/donutluxe\.com\/ore-rush";/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/ore-rush<\/loc>/);
    assert.doesNotMatch(sitemap, /donutluxe\.com\/slots</);
    assert.match(seo, /'ore-rush': \{\s*title: 'DonutLuxe Ore Rush/);
    assert.match(data, /route: '\/ore-rush', name: 'Ore Rush', art: 'diamond\.png', shipped: '2026-10-17'/);
    // The admin figures are for slots as a whole, both machines together.
    assert.match(admin, /slots: 'Slots',/);
    // The old address carries on: nginx for a full load, the router for a link inside the page.
    assert.match(nginx, /location = \/slots \{\s*include \/etc\/nginx\/security-headers\.conf;\s*return 308 \/ore-rush\$is_args\$args;\s*\}/);
    assert.match(app, /if \(RENAMED\[requested\]\) \{\s*navigate\(`\/\$\{RENAMED\[requested\]\}\$\{location\.search\}`, \{ replace: true \}\);/);
    const [lib, page] = await Promise.all([read('services/api-gateway/src/lib/slots.ts'), front('assets/js/slots.js')]);
    assert.match(lib, /name: 'Ore Rush',\n  label: 'Ore Rush',\n  path: '\/ore-rush',/);
    assert.match(page, /title: 'Ore Rush',\n    label: 'Ore Rush',/);
  });

  it('asks the server for every spin, and holds the wallet from the click until the reels stop', async () => {
    const page = await front('assets/js/slots.js');
    assert.match(page, /api\.get\(`\/v1\/slots\/config\?machine=\$\{game\.machine\}`\)/);
    assert.match(page, /api\.post\('\/v1\/slots\/spins', body\(\), \{ idempotencyKey: key \}\)/);
    const spin = page.slice(page.indexOf('async function spin()'), page.indexOf('async function playRound('));
    assert.ok(spin.indexOf('const release = holdLiveFigures();') < spin.indexOf('await send(stake)'));
    assert.ok(spin.indexOf('await playRound(') < spin.indexOf('showBalance(response.balanceMinor)'));
    assert.match(spin, /finally \{\n\s+release\(\);/);
    // Nothing about a result is decided here: no client-side randomness picks a stop.
    assert.doesNotMatch(page, /Math\.random\(\) \* (strip|length)|getRandomValues/);
  });

  it('draws the drums from the server’s strips in 3D, and keeps the flat reels when it cannot', async () => {
    const [page, machine, css] = await Promise.all([
      front('assets/js/slots.js'),
      front('assets/js/slots3d.js'),
      front('assets/css/slots.css'),
    ]);
    // The drums are the config's strips, one facet per entry, landing with the server's top stop.
    assert.match(page, /createMachine3d\(\$\('\.slots__window', root\), \{\s*strips: config\.strips,/);
    assert.match(machine, /strip\.forEach\(\(symbol, k\) => \{/);
    assert.match(machine, /const angleFor = \(reel, top\) => -mod\(top \+ 1, reel\.strip\.length\) \* reel\.step;/);
    // The drums turn from the click and land on the stops the answer carried.
    const spin = page.slice(page.indexOf('async function spin()'), page.indexOf('async function playRound('));
    assert.ok(spin.indexOf('machine.spinStart()') < spin.indexOf('await send(stake)'));
    assert.match(page, /return machine\.land\(next, \{/);
    // No WebGL, or a lost context, leaves the flat reels in charge; they stay current for screen readers.
    assert.match(machine, /if \(!\(probe\.getContext\('webgl2'\) \|\| probe\.getContext\('webgl'\)\)\) return null;/);
    assert.match(page, /if \(!built\) return;/);
    assert.match(page, /built\.onLost = \(\) => \{\s*machine = null;\s*built\.dispose\(\);\s*root\.dataset\.render = '2d';/);
    assert.match(page, /onStop: \(reel\) => \{\s*paintReel\(reel, grid\[reel\]\);/);
    assert.match(css, /\.slots\[data-render="3d"\] \.slots__reels \{[^}]*clip: rect\(0 0 0 0\);/);
    // Reduced motion: the drums are set, not spun.
    assert.match(machine, /if \(reduce\) \{\s*controls\.showStops\(tops\);/);
  });

  it('stages the machine in a room: real item models, a payout, the book, and nothing that moves under reduced motion', async () => {
    const [page, machine] = await Promise.all([front('assets/js/slots.js'), front('assets/js/slots3d.js')]);
    // Items are the game's own sprites extruded one pixel deep, as a dropped item is built.
    assert.match(machine, /function itemModel\(source\) \{/);
    assert.match(machine, /const d = 0\.5 \/ S;/);
    // What a spin paid spills out of the chute; free spins open with the enchanting book.
    assert.match(page, /machine\.payout\(Number\(\(BigInt\(step\.payoutMinor\) \* 100n\) \/ stake\) \/ 100\);/);
    assert.match(page, /machine\?\.enchant\('enchant'\);/);
    assert.match(page, /onAuto: \(\) => \$\(`#\$\{P\}Auto`, root\)\?\.click\(\),/);
    // Reduced motion: no intro, no camera moves, no shake, no flying loot.
    assert.match(machine, /let introDone = reduce;/);
    assert.match(machine, /let shot = reduce \? 'play' : 'intro';/);
    assert.match(machine, /if \(reduce \|\| !\(ratio > 0\)\) return;/);
    assert.match(machine, /if \(reduce && name !== 'play' && name !== 'free'\) return;/);
    // Shaders are compiled up front, and the resolution follows the frame rate.
    assert.match(machine, /renderer\.compile\(scene, camera\)/);
    assert.match(machine, /function adapt\(elapsed\) \{/);
  });

  it('puts the wandering trader and his llama beside the machine, from the game’s own models and skins', async () => {
    const [page, machine, models, addons, index, bastion] = await Promise.all([
      front('assets/js/slots.js'),
      front('assets/js/slots3d.js'),
      front('assets/js/mcmodels.js'),
      front('assets/vendor/three-addons.js'),
      front('index.html'),
      front('assets/js/slots3d-bastion.js'),
    ]);
    assert.match(machine, /from '\.\/mcmodels\.js';/);
    assert.match(index, /<link rel="modulepreload" href="assets\/js\/mcmodels\.js" \/>/);
    // The models are the game's: model space y-down and facing -z, feet on the ground at y 24.
    assert.match(models, /export const VILLAGER = /);
    assert.match(models, /export function llamaModel\(/);
    assert.match(models, /model\.root\.rotation\.x = Math\.PI;\s*model\.root\.position\.y = 24;/);
    // Every skin and particle is a PNG out of the client jar, not drawn here.
    const names = [
      'entity/wandering_trader', 'entity/llama_creamy', 'entity/trader_llama', 'entity/enchanting_table_book',
      'entity/experience_orb', 'entity/shadow', 'particle/glint', 'particle/angry', 'particle/spark_0', 'particle/sga_a',
      'gui/button', 'gui/button_highlighted', 'gui/button_disabled', 'gui/ascii',
    ];
    for (const name of names) {
      const bytes = await readFile(path.join(repo, `DONUTDROP FRONTEND/Donut Drop/assets/img/${name}.png`));
      assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', name);
    }
    // The post-processing bundle imports only the vendored three, and a missing bundle just means no bloom.
    assert.doesNotMatch(addons, /from\s*["']three["']/);
    assert.match(addons, /from"\.\/three\.module\.min\.js"/);
    assert.match(machine, /import\(\/\* @vite-ignore \*\/ new URL\('assets\/vendor\/three-addons\.js', document\.baseURI\)\.href\)\.catch\(\(\) => null\)/);
    assert.match(machine, /if \(composer\) composer\.render\(dt\);\s*else renderer\.render\(scene, camera\);/);
    // A slow device drops the bloom, then the whole post chain, before it drops frames.
    assert.match(machine, /else \{ composer\.dispose\(\); composer = null; \}/);
    // He reacts to how a spin went; under reduced motion he is already standing at home.
    assert.match(page, /paintMeter\(roundWon\);\s*machine\?\.react\?\.\('lose'\);\s*return;/);
    assert.match(page, /machine\?\.react\?\.\(tier \? 'big' : step\.books >= 3 \? 'free' : 'win', ratio\);/);
    // The machine hands each moment to its theme's stage; Ore Rush's is the bastion and its trader.
    assert.match(machine, /react\(kind, ratio\) \{ stage\.react\?\.\(kind, ratio\); \},/);
    assert.match(machine, /'ore-rush': \{[\s\S]*?stage: buildBastionStage,/);
    assert.match(bastion, /react\(kind, ratio\) \{ reactNpc\(kind, ratio\); \},/);
    // The bigger the win, the bigger his celebration; none of it under reduced motion.
    assert.match(bastion, /const joy = kind === 'big' \? \(ratio >= 50 \? 4 : 3\)/);
    assert.match(bastion, /npc\.watchUntil = Math\.max\(npc\.watchUntil, now \+ 6000\);\s*if \(reduce\) return;/);
    assert.match(bastion, /traderBody\.position\.set\(reduce \? HOME\.x : /);
  });

  it('gives the Ocean Monument its own page: route, view, lobby card, sidebar, search and sitemap', async () => {
    const [html, app, nginx, sitemap, seo, data, page, nudge, popups] = await Promise.all([
      front('index.html'),
      front('assets/js/app.js'),
      read('infra/nginx/nginx.conf'),
      front('sitemap.xml'),
      front('assets/js/seo.js'),
      front('assets/js/data.js'),
      front('assets/js/slots.js'),
      front('assets/js/nudge.js'),
      front('assets/js/popups.js'),
    ]);
    assert.match(html, /<section class="view" data-view="monument" hidden>/);
    assert.match(html, /<div class="slots" id="monumentRoot"><\/div>/);
    assert.match(html, /<a class="gcard lxcard" href="\/monument" data-cat="casino" data-game="monument"/);
    assert.match(html, /<p class="lxlive" data-live="monument" hidden>/);
    assert.match(html, /<a class="lxnav" href="\/monument" data-route="monument" data-tip="Ocean Monument">/);
    for (const module of ['slots3d-bastion', 'slots3d-monument']) {
      assert.match(html, new RegExp(`<link rel="modulepreload" href="assets/js/${module}\\.js" />`));
    }
    assert.match(app, /import \{ mountMonument, mountSlots \} from '\.\/slots\.js';/);
    assert.match(app, /monument: mountMonument,/);
    assert.match(app, /'dice', 'ore-rush', 'monument', 'mines-duel', 'coinflip'\]\]/);
    assert.match(nginx, /\|coinflip\|ore-rush\|monument\|/);
    assert.match(nginx, /\/monument "https:\/\/donutluxe\.com\/monument";/);
    assert.match(nginx, /\/monument "index, follow";/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/monument<\/loc>/);
    assert.match(seo, /monument: \{\s*title: 'DonutLuxe Ocean Monument/);
    assert.match(data, /route: '\/monument', name: 'Ocean Monument', art: 'heart_of_the_sea\.png', shipped: '2026-10-18'/);
    for (const list of [nudge, popups]) assert.match(list, /'ore-rush', 'monument', 'coinflip'/);
    // One page per machine: its own state and its own element ids, its machine named to the server.
    assert.match(page, /function createSlotsGame\(game\) \{\n  const P = game\.prefix;/);
    assert.match(page, /export const mountMonument = createSlotsGame\(GAMES\.monument\);/);
    assert.match(page, /config = await api\.get\(`\/v1\/slots\/config\?machine=\$\{game\.machine\}`\);/);
    assert.match(page, /serverSeedHash: seedHash, machine: game\.machine \}\)/);
    assert.match(page, /theme: game\.machine,/);
    assert.doesNotMatch(page, /'#slots[A-Z]/, 'an element id that is not the page’s own');
  });

  it('builds the Monument from the game’s own guardians, conduit and temple', async () => {
    const [machine, stage, models, page] = await Promise.all([
      front('assets/js/slots3d.js'),
      front('assets/js/slots3d-monument.js'),
      front('assets/js/mcmodels.js'),
      front('assets/js/slots.js'),
    ]);
    assert.match(machine, /monument: \{[\s\S]*?stage: buildMonumentStage,/);
    assert.match(machine, /lever: 'prismarine_bricks', lamp: 'sea_lantern'/);
    // GuardianModel, number for number: the body, the spike tables, the elder at 2.35.
    assert.match(models, /\{ u: 0, v: 0, x: -6, y: 10, z: -8, w: 12, h: 12, d: 16 \}/);
    assert.match(models, /const SPIKE_X_ROT = \[1\.75, 0\.25, 0, 0, 0\.5, 0\.5, 0\.5, 0\.5, 1\.25, 0\.75, 0, 0\];/);
    assert.match(models, /const SPIKE_Z = \[8, -8, 0, 0, -8, -8, 8, 8, 8, -8, 0, 0\];/);
    assert.match(models, /export const ELDER_GUARDIAN_SCALE = 2\.35;/);
    assert.match(models, /const offset = 1 \+ Math\.cos\(ticks \* 1\.5 \+ i\) \* 0\.01 - extension;/);
    // GuardianRenderer's beam colour as the attack charges, and ElderGuardianParticle's sweep.
    assert.match(stage, /beamColor\.setRGB\(\(64 \+ s \* 191\) \/ 255, \(32 \+ s \* 191\) \/ 255, \(128 - s \* 64\) \/ 255\)/);
    assert.match(stage, /const p = \(now - curseAt\) \/ 1500;/);
    assert.match(stage, /curseTurn\.rotation\.x = THREE\.MathUtils\.degToRad\(60 - 150 \* p\);/);
    // Every face, skin and particle is out of the client jar.
    const names = [
      'entity/guardian', 'entity/guardian_elder', 'entity/guardian_beam', 'entity/conduit_cage', 'entity/conduit_wind',
      'entity/conduit_open_eye', 'entity/conduit_closed_eye', 'particle/bubble', 'particle/nautilus',
      'block/prismarine_bricks', 'block/dark_prismarine', 'block/sea_lantern', 'block/water_still', 'block/kelp',
      'block/kelp_plant', 'block/seagrass', 'items/cod', 'items/pufferfish', 'items/prismarine_shard',
      'items/prismarine_crystals', 'items/nautilus_shell', 'items/tide_armor_trim_smithing_template',
      'items/heart_of_the_sea', 'items/guardian_spawn_egg', 'items/elder_guardian_spawn_egg', 'items/trident',
    ];
    for (const name of names) {
      const bytes = await readFile(path.join(repo, `DONUTDROP FRONTEND/Donut Drop/assets/img/${name}.png`));
      assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', name);
    }
    // The page shows each symbol the server names in its own sprite.
    for (const symbol of OCEAN_MONUMENT.symbols) assert.match(page, new RegExp(`\\b${symbol.id}: '`), symbol.id);
  });

  it('draws the machine in its own tokens, in the shared frame, with reduced motion honoured', async () => {
    const [frame, css] = await Promise.all([front('assets/css/luxe-games.css'), front('assets/css/slots.css')]);
    assert.match(frame, /body\.lx :is\(\.crash, \.mines, \.tower, \.chicken, \.dice, \.slots, \.plinko\) \{/);
    const rules = css.slice(css.indexOf('/* ─────────── the machine'));
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'a raw colour outside the token block');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /image-rendering: pixelated/);
  });
});
