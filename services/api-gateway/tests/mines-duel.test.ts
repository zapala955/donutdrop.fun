import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { nextSafeChanceBps as soloNextSafeChanceBps } from '../src/lib/mines.js';
import {
  DUEL_MINE_OPTIONS,
  DUEL_TILES,
  decide,
  duelMinePositions,
  isMine,
  maskOf,
  minesOfMask,
  nextSafeChanceBps,
  safeCount,
  safeTiles,
  scoreOf,
} from '../src/lib/mines-duel.js';

/*
 * Mines Duel moves two players' money on one hidden field. The rules are arithmetic and are tested
 * as such; what keeps the money honest is structural -- guarded updates, deterministic ledger
 * references, what is and is not sent to whom -- so the route and the migration are pinned by
 * source, in the style of the rest of this suite. The behaviour itself (every outcome, the sweeper,
 * a join race, money conservation) is exercised against a real Postgres by the end-to-end run.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('mines duel: the field', () => {
  it('is the documented Fisher–Yates over HMAC, and reproducible from the revealed seeds', () => {
    const expected = (server: string, host: string, opponent: string, count: number) => {
      const tiles = Array.from({ length: 25 }, (_, i) => i);
      for (let i = 0; i < count; i += 1) {
        const digest = createHmac('sha256', server)
          .update(`minesduel:${host}:${opponent}:${i}`, 'utf8')
          .digest('hex');
        const sample = Number.parseInt(digest.slice(0, 13), 16) / 2 ** 52;
        const j = i + Math.floor(sample * (25 - i));
        [tiles[i], tiles[j]] = [tiles[j]!, tiles[i]!];
      }
      return tiles.slice(0, count).sort((a, b) => a - b);
    };
    for (const count of [1, 3, 5, 8, 12, 20]) {
      assert.deepEqual(
        duelMinePositions('server', 'hostseed', 'oppseed', count),
        expected('server', 'hostseed', 'oppseed', count),
      );
    }
    const field = duelMinePositions('server', 'hostseed', 'oppseed', 5);
    assert.equal(field.length, 5);
    assert.equal(new Set(field).size, 5);
    assert.ok(field.every((tile) => Number.isInteger(tile) && tile >= 0 && tile < DUEL_TILES));
    assert.deepEqual(
      field,
      [...field].sort((a, b) => a - b),
    );
  });

  it('depends on both players’ seeds and on the server seed', () => {
    const base = duelMinePositions('s', 'a', 'b', 8);
    assert.notDeepEqual(base, duelMinePositions('s', 'a', 'c', 8));
    assert.notDeepEqual(base, duelMinePositions('s', 'x', 'b', 8));
    assert.notDeepEqual(base, duelMinePositions('t', 'a', 'b', 8));
    // The host's seed and the opponent's are not interchangeable: the message is ordered.
    assert.notDeepEqual(duelMinePositions('s', 'a', 'b', 8), duelMinePositions('s', 'b', 'a', 8));
  });

  it('puts TNT on every tile equally often (no tile is safer than another)', () => {
    const counts = new Array<number>(25).fill(0);
    const games = 4_000;
    for (let i = 0; i < games; i += 1) {
      for (const tile of duelMinePositions(`seed${i}`, 'h', 'o', 5)) counts[tile]! += 1;
    }
    const expected = (games * 5) / 25;
    // Each tile is TNT in about a fifth of games; 15% either way is ~7 standard deviations wide.
    for (const [tile, count] of counts.entries()) {
      assert.ok(
        Math.abs(count - expected) < expected * 0.15,
        `tile ${tile}: ${count} vs ${expected}`,
      );
    }
  });

  it('refuses a field with no TNT or too much', () => {
    assert.throws(() => duelMinePositions('s', 'a', 'b', 0), RangeError);
    assert.throws(() => duelMinePositions('s', 'a', 'b', 21), RangeError);
    assert.ok(DUEL_MINE_OPTIONS.every((count) => count >= 1 && count <= 20));
  });

  it('round-trips through the integer the database stores', () => {
    const field = duelMinePositions('s', 'a', 'b', 12);
    const mask = maskOf(field);
    assert.ok(mask >= 0 && mask < 2 ** 25, 'fits the CHECK on mine_mask');
    assert.deepEqual(minesOfMask(mask), field);
    for (let tile = 0; tile < DUEL_TILES; tile += 1)
      assert.equal(isMine(mask, tile), field.includes(tile));
  });
});

describe('mines duel: scores and the verdict', () => {
  const mask = maskOf([0, 7, 24]);

  it('counts the safe tiles a player turned, and nothing for a bust', () => {
    assert.equal(safeCount([1, 2, 3], mask), 3);
    assert.equal(safeCount([1, 7], mask), 1);
    assert.equal(scoreOf('locked', [1, 2], mask), 2);
    assert.equal(scoreOf('playing', [1, 2, 3], mask), 3);
    // A bust scores zero however many safe tiles came first.
    assert.equal(scoreOf('busted', [1, 2, 3, 7], mask), 0);
    assert.equal(safeTiles(5), 20);
  });

  it('gives the pot to the higher score and calls equal scores a draw', () => {
    assert.equal(decide(3, 1), 'host');
    assert.equal(decide(1, 3), 'opponent');
    assert.equal(decide(2, 2), 'draw');
    assert.equal(decide(0, 0), 'draw');
    assert.equal(decide(0, 1), 'opponent');
  });

  it('quotes the chance of the next tile exactly as solo Mines does', () => {
    for (const mines of DUEL_MINE_OPTIONS) {
      for (let turned = 0; turned <= 25 - mines; turned += 1) {
        assert.equal(nextSafeChanceBps(mines, turned), soloNextSafeChanceBps(mines, turned));
      }
    }
    assert.equal(nextSafeChanceBps(5, 0), 8_000);
  });
});

describe('mines duel: the money and the secrets, structurally', () => {
  it('closes every exit from "open" and from "playing" with a guarded update and a derived reference', async () => {
    const route = await read('services/api-gateway/src/routes/mines-duel.ts');
    // The three exits, each paired with the status it leaves.
    assert.match(
      route,
      /UPDATE mines_duel_games SET status = 'cancelled' WHERE id = \$1 AND status = 'open'/,
    );
    assert.match(route, /WHERE id = \$1 AND status = 'playing'\s*`,\s*\[\s*row\.id,\s*hostScore/);
    assert.match(
      route,
      /WHERE id = \$1 AND status = 'open'`,\s*\[row\.id, userId, opponentClientSeed, mask\]/,
    );
    // Every credit and stake names a reference derived from the game, so a second attempt collides.
    for (const reference of [
      "deterministicUuid('mines_duel_stake', gameId, role)",
      "deterministicUuid('mines_duel_win', row.id, winnerUserId)",
      "deterministicUuid('mines_duel_refund', row.id, 'host')",
      "deterministicUuid('mines_duel_refund', row.id, 'opponent')",
      "deterministicUuid('mines_duel_wager', row.id, player)",
    ]) {
      assert.ok(route.includes(reference), reference);
    }
    // A stake is taken by one statement that cannot overdraw.
    assert.match(route, /WHERE user_id = \$1 AND balance_minor >= \$2/);
  });

  it('rakes a draw like a decided game, and counts it once it has paid a rake', async () => {
    /* A free draw left the edge at the share of games that were decided: 31% of games were drawn,
     * nearly all 0-0, so a 10% rake earned under 7%. */
    const route = await read('services/api-gateway/src/routes/mines-duel.ts');
    const settle = route.slice(
      route.indexOf('async function settleLocked'),
      route.indexOf('const clockHasRunOut'),
    );
    assert.match(settle, /const draw = decided \? null : splitDraw\(stake, row\.rake_bps\);/);
    const refunds = settle.slice(settle.indexOf('} else if (draw) {'), settle.indexOf('if (decided ||'));
    assert.equal(refunds.match(/draw\.refundEachMinor/g)?.length, 2);
    assert.match(refunds, /'mines_duel_refund'/);
    // Never the whole stake: each refund is the stake less its half of the rake.
    assert.doesNotMatch(refunds, /\bstake,\s*'mines_duel_refund'/);
    // Both sides are wagers on a decided game and on a draw that paid a rake, never a free one.
    const wagers = settle.slice(settle.indexOf('if (decided || money.rakeMinor > 0n)'));
    assert.match(wagers, /duelMarginPerPlayer\(money\)/);
    assert.match(wagers, /recordWager\(/);
  });

  it('keeps games already in play running and paying when the switch is off', async () => {
    const route = await read('services/api-gateway/src/routes/mines-duel.ts');
    // Only opening and taking are gated.
    const gated = [...route.matchAll(/assertEnabled\(\);/g)].length;
    assert.equal(gated, 2);
    for (const endpoint of [
      "'/v1/mines-duel/:code/pick'",
      "'/v1/mines-duel/:code/lock'",
      "'/v1/mines-duel/:code/cancel'",
    ]) {
      const body = route.slice(route.indexOf(endpoint), route.indexOf(endpoint) + 900);
      assert.doesNotMatch(body, /assertEnabled\(\)/, endpoint);
    }
    const sweep = route.slice(
      route.indexOf('async function sweep()'),
      route.indexOf('let sweeping'),
    );
    assert.doesNotMatch(sweep, /minesDuelEnabled/);
    assert.match(sweep, /status = 'playing' AND deadline_at <= now\(\)/);
    assert.match(sweep, /status = 'open' AND expires_at <= now\(\)/);
  });

  it('settles a clock that has run out whoever notices first, without counting the late tile', async () => {
    const route = await read('services/api-gateway/src/routes/mines-duel.ts');
    assert.match(
      route,
      /if \(clockHasRunOut\(row\)\) \{\s*await settleLocked\(client, row\);\s*return \{ accepted: false/,
    );
    // And the clock is the database's, read when the row is: not the browser's, not the process's.
    assert.match(route, /clock_timestamp\(\) AS db_now/);
  });

  it('never sends the field, the scores or the seeds before a game has settled', async () => {
    const route = await read('services/api-gateway/src/routes/mines-duel.ts');
    const view = route.slice(
      route.indexOf('function gameView'),
      route.indexOf('function compactView'),
    );
    // The reveal is built only inside the settled branch...
    const settledBranch = view.slice(view.indexOf("if (row.status === 'settled'"));
    assert.match(settledBranch, /serverSeed: row\.server_seed_reveal/);
    assert.match(settledBranch, /mines: minesOfMask\(mask\)/);
    // ...and the part that runs while a game is live offers a player their own run and a flag.
    const live = view.slice(
      view.indexOf('if (role && mask !== null'),
      view.indexOf("if (row.status === 'settled'"),
    );
    assert.match(live, /opponentFinished = other\.state !== 'playing'/);
    assert.doesNotMatch(live, /minesOfMask|server_seed_reveal|_score/);
    // The raw mask is read inside the view to build the reader's own run and the settled reveal; it
    // is never an output field, and the compact list shape carries no runs, seeds or field at all.
    assert.doesNotMatch(view, /mask\s*:|mine_mask\s*:|mineMask/);
    const compact = route.slice(
      route.indexOf('function compactView'),
      route.indexOf('async function debitStake'),
    );
    assert.doesNotMatch(compact, /mask|serverSeed|server_seed|picks/);
    // The list endpoints go through these two views, so they cannot say more.
    assert.match(route, /games: open\.rows\.map\(\(row\) => gameView\(row, viewerId\)\)/);
  });

  it('publishes a refresh when a run finishes, not for every tile', async () => {
    const route = await read('services/api-gateway/src/routes/mines-duel.ts');
    assert.match(
      route,
      /if \(!outcome\.accepted \|\| outcome\.hit \|\| outcome\.row\.status === 'settled'\) \{\s*publishLiveSoon\('minesduel'\);/,
    );
  });
});

describe('mines duel: the schema and the wiring', () => {
  it('widens the ledger and wager lists and holds the whole game in one guarded table', async () => {
    const sql = await read('packages/db/migrations/057_mines_duel.sql');
    assert.match(sql, /'mines_duel_stake', 'mines_duel_win', 'mines_duel_refund'/);
    assert.equal(sql.match(/'dice', 'mines_duel'\)\);/g)?.length, 3);
    assert.match(sql, /CREATE TABLE mines_duel_games \(/);
    // States are "playing", "locked", "busted": the column must hold the longest of them.
    assert.match(sql, /host_state varchar\(7\) NOT NULL DEFAULT 'playing'/);
    assert.match(sql, /CONSTRAINT mines_duel_distinct_players/);
    assert.match(sql, /CONSTRAINT mines_duel_started_has_a_field/);
    assert.match(sql, /CONSTRAINT mines_duel_settled_is_complete/);
    assert.match(
      sql,
      /CONSTRAINT mines_duel_rake_adds_up\s+CHECK \(pot_minor IS NULL OR pot_minor = rake_minor \+ payout_minor\)/,
    );
    assert.match(
      sql,
      /CREATE INDEX mines_duel_deadline_idx ON mines_duel_games \(deadline_at\) WHERE status = 'playing'/,
    );
    assert.match(
      sql,
      /GRANT SELECT, INSERT, UPDATE ON TABLE mines_duel_games TO donut_api_runtime;/,
    );
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v57\(\) RETURNS boolean/);
  });

  it('is configured like the other PvP modes, with the same boot checks', async () => {
    const config = await read('services/api-gateway/src/config.ts');
    assert.match(
      config,
      /MINES_DUEL_RAKE_BPS: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(1_000\)\.default\(1000\)/,
    );
    assert.match(
      config,
      /env\.MINES_DUEL_ENABLED && env\.VIP_ENABLED && env\.MINES_DUEL_RAKE_BPS <= 200/,
    );
    assert.match(config, /is too small for MINES_DUEL_RAKE_BPS to collect anything/);
    const settings = await read('services/api-gateway/src/lib/runtime-settings.ts');
    for (const key of [
      'minesDuelEnabled',
      'minesDuelRakeBps',
      'minesDuelMinStakeMinor',
      'minesDuelMaxStakeMinor',
      'minesDuelLobbyTtlMinutes',
      'minesDuelPlaySeconds',
    ]) {
      assert.ok(settings.includes(`${key}: {`), key);
    }
    assert.match(settings, /'Mines Duel minimum stake', view\.minesDuelMinStakeMinor/);
    const example = await read('.env.example');
    assert.match(example, /MINES_DUEL_PLAY_SECONDS=60/);
  });

  it('draws only what the server says, on the server’s clock, and releases the wallet at the reveal', async () => {
    const page = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/mines-duel.js');
    // No randomness and no outcome logic in the browser.
    assert.doesNotMatch(page, /Math\.random/);
    assert.match(page, /skew = server - Date\.now\(\)/);
    assert.match(page, /Date\.parse\(game\.deadlineAt\) - \(Date\.now\(\) \+ skew\)/);
    // The wallet is held while a game runs and refreshed for real once the result is on screen.
    assert.match(page, /hold = holdLiveFigures\(\)/);
    assert.match(page, /const finish = \(\) => \{\s*releaseHold\(\);/);
    // The other player's side is never given more than "finished".
    assert.match(page, /g\.opponentFinished === true/);
    const html = await read('DONUTDROP FRONTEND/Donut Drop/index.html');
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/mines-duel\.css" \/>/);
    const live = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/live.js');
    assert.match(live, /source\.addEventListener\('minesduel'/);
  });
});
