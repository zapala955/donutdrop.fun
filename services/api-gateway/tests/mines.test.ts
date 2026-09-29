import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  MINES_HOUSE_EDGE_BPS,
  MINES_TILES,
  minePositions,
  multiplierBps,
  nextSafeChanceBps,
  oddsAgainst,
  payoutFor,
} from '../src/lib/mines.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const route = () => read('services/api-gateway/src/routes/mines.ts');

describe('mines engine', () => {
  it('returns at most 90% at every cash-out point, for every mine count', () => {
    /* Cashing out after k safe tiles pays payoutFor(k) with probability 1/oddsAgainst(k), so the
     * expected return is payoutFor(k) · den / num. Checked in exact integers on a stake large
     * enough that flooring cannot hide a rounding error in the house's favour or against it. */
    const stake = 10n ** 15n;
    const ninety = (stake * BigInt(10_000 - MINES_HOUSE_EDGE_BPS)) / 10_000n;
    for (let mines = 1; mines <= 24; mines += 1) {
      for (let k = 1; k <= MINES_TILES - mines; k += 1) {
        const { num, den } = oddsAgainst(mines, k);
        const expected = (payoutFor(stake, mines, k) * den) / num;
        assert.ok(expected <= ninety, `${mines} mines, ${k} tiles returns more than 90%`);
        assert.ok(ninety - expected <= 1n, `${mines} mines, ${k} tiles returns well under 90%`);
      }
    }
  });

  it('prices the familiar spots the way the formula says', () => {
    assert.equal(multiplierBps(1, 1), 9_375); // 25/24 · 0.9
    assert.equal(multiplierBps(3, 1), 10_227); // 25/22 · 0.9
    assert.equal(multiplierBps(24, 1), 225_000); // 25 · 0.9
    assert.equal(multiplierBps(1, 24), 225_000); // clearing the field against one TNT
    assert.equal(payoutFor(1_000_000n, 3, 1), 1_022_727n);
    assert.equal(nextSafeChanceBps(3, 0), 8_800); // 22 of 25
    assert.equal(nextSafeChanceBps(3, 21), 2_500); // 1 of 4
    assert.equal(nextSafeChanceBps(3, 22), 0); // nothing safe left
  });

  it('places the TNT from the committed seed, exactly as a player can check it', () => {
    const seed = 'cd'.repeat(32);
    const placed = minePositions(seed, 'client', 7, 5);
    assert.deepEqual(minePositions(seed, 'client', 7, 5), placed);
    assert.equal(new Set(placed).size, 5);
    assert.ok(placed.every((tile) => Number.isInteger(tile) && tile >= 0 && tile < 25));
    assert.deepEqual([...placed].sort((a, b) => a - b), placed);
    // An independent re-implementation of the published recipe agrees.
    const tiles = Array.from({ length: 25 }, (_, i) => i);
    for (let i = 0; i < 5; i += 1) {
      const digest = createHmac('sha256', seed).update(`client:7:${i}`).digest('hex');
      const j = i + Math.floor((Number.parseInt(digest.slice(0, 13), 16) / 2 ** 52) * (25 - i));
      [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
    }
    assert.deepEqual(tiles.slice(0, 5).sort((a, b) => a - b), placed);
    // A different client seed moves the field.
    assert.notDeepEqual(minePositions(seed, 'other', 7, 5), placed);
  });

  it('puts TNT on every tile about equally often', () => {
    const counts = new Array(25).fill(0);
    const games = 20_000;
    for (let game = 0; game < games; game += 1) {
      for (const tile of minePositions(randomBytes(32).toString('hex'), 'c', 0, 3)) counts[tile] += 1;
    }
    const expected = (games * 3) / 25;
    for (const count of counts) assert.ok(Math.abs(count - expected) < expected * 0.08, `tile count ${count} vs ${expected}`);
  });
});

describe('mines routes', () => {
  it('never shows the field or the seed while a game is in play', async () => {
    const source = await route();
    const view = source.slice(source.indexOf('function gameView('), source.indexOf('interface Settlement'));
    assert.match(view, /mineTiles: settled \? row\.mine_tiles : null/);
    assert.match(view, /serverSeed: settled \? row\.server_seed_reveal : null/);
    assert.doesNotMatch(view, /mine_tiles(?! : null)(?!,)/);
  });

  it('locks the game, refuses a stale tap, and settles exactly once', async () => {
    const source = await route();
    assert.match(source, /SELECT \* FROM mines_games WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
    const reveal = source.slice(source.indexOf("'/v1/mines/games/:id/reveal'"), source.indexOf("'/v1/mines/games/:id/cashout'"));
    assert.match(reveal, /if \(row\.revealed_tiles\.length !== body\.revealedCount\)/);
    assert.match(reveal, /if \(row\.revealed_tiles\.includes\(body\.tile\)\)/);
    assert.match(reveal, /if \(row\.status !== 'active'\) return/);
    const settle = source.slice(source.indexOf('async function settle('), source.indexOf('async function debit('));
    assert.match(settle, /WHERE id = \$1 AND status = 'active'/);
    assert.match(settle, /creditWallet\(client, row\.user_id, payout, 'mines_payout', row\.id\)/);
    // The wager is counted when the game ends, and there is no refund path to outlive.
    assert.match(settle, /recordWager\(client, config, row\.user_id, BigInt\(row\.stake_minor\), 'mines', row\.id/);
    assert.equal(source.split('creditWallet(').length - 1, 1); // the payout, and nothing else
    assert.doesNotMatch(source, /'mines_refund'/);
  });

  it('spends the fairness seed when the game starts', async () => {
    const source = await route();
    const start = source.slice(source.indexOf("'/v1/mines/games',"), source.indexOf("'/v1/mines/games/:id/reveal'"));
    assert.match(start, /UPDATE fairness_seeds SET used_at = now\(\) WHERE id = \$1/);
    assert.match(start, /await insertFairnessSeed\(client, config, userId\)/);
    assert.match(start, /conflict\('GAME_IN_PLAY'/);
  });

  it('only widens the constraints it touches', async () => {
    const kinds = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/051_mines.sql');
    const previous = await read('packages/db/migrations/050_crash.sql');
    for (const constraint of [
      'wallet_transactions_kind_check',
      'wager_events_source_check',
      'faction_contributions_source_check',
      'referral_earnings_source_check',
    ]) {
      const before = kinds(previous, constraint);
      const after = kinds(migration, constraint);
      for (const value of before) assert.ok(after.has(value), `051 drops ${value} from ${constraint}`);
    }
    assert.ok(kinds(migration, 'wallet_transactions_kind_check').has('mines_payout'));
    assert.ok(kinds(migration, 'wager_events_source_check').has('mines'));
    assert.match(migration, /CREATE UNIQUE INDEX mines_games_one_active_idx ON mines_games \(user_id\) WHERE status = 'active'/);
  });
});
