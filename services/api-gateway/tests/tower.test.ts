import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  TOWER_FLOORS,
  TOWER_HOUSE_EDGE_BPS,
  TOWER_MODES,
  TOWER_MODE_NAMES,
  multiplierBps,
  oddsAgainst,
  payoutFor,
  safeChanceBps,
  trapLayout,
  trapsOnFloor,
} from '../src/lib/tower.js';

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');
const route = () => read('services/api-gateway/src/routes/tower.ts');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('tower engine', () => {
  it('has the four modes it was asked for, nine floors each', () => {
    assert.deepEqual(TOWER_MODE_NAMES, ['easy', 'medium', 'hard', 'expert']);
    assert.deepEqual(TOWER_MODES, {
      easy: { tiles: 4, traps: 1 },
      medium: { tiles: 3, traps: 1 },
      hard: { tiles: 2, traps: 1 },
      expert: { tiles: 3, traps: 2 },
    });
    assert.equal(TOWER_FLOORS, 9);
  });

  it('returns at most 90% at every cash-out point, in every mode', () => {
    /* Cashing out after k floors pays payoutFor(k) with probability 1/oddsAgainst(k): the expected
     * return is payoutFor(k) · den / num, checked in exact integers on a stake large enough that
     * flooring cannot hide a rounding error either way. */
    const stake = 10n ** 15n;
    const ninety = (stake * BigInt(10_000 - TOWER_HOUSE_EDGE_BPS)) / 10_000n;
    for (const mode of TOWER_MODE_NAMES) {
      for (let k = 1; k <= TOWER_FLOORS; k += 1) {
        const { num, den } = oddsAgainst(mode, k);
        const expected = (payoutFor(stake, mode, k) * den) / num;
        assert.ok(expected <= ninety, `${mode}, ${k} floors returns more than 90%`);
        assert.ok(ninety - expected <= 1n, `${mode}, ${k} floors returns well under 90%`);
      }
    }
  });

  it('prices the floors the way the formula says', () => {
    assert.equal(multiplierBps('easy', 1), 12_000); // 4/3 · 0.9
    assert.equal(multiplierBps('medium', 1), 13_500); // 3/2 · 0.9
    assert.equal(multiplierBps('hard', 1), 18_000); // 2 · 0.9
    assert.equal(multiplierBps('expert', 1), 27_000); // 3 · 0.9
    assert.equal(multiplierBps('medium', 4), 45_562); // the lobby card's 4.55×
    assert.equal(multiplierBps('easy', 9), 119_864); // (4/3)^9 · 0.9
    assert.equal(multiplierBps('hard', 9), 4_608_000); // 2^9 · 0.9
    assert.equal(multiplierBps('expert', 9), 177_147_000); // 3^9 · 0.9
    assert.equal(payoutFor(1_000_000n, 'easy', 1), 1_200_000n);
    assert.deepEqual(TOWER_MODE_NAMES.map(safeChanceBps), [7_500, 6_666, 5_000, 3_333]);
    // Every floor pays more than the one under it.
    for (const mode of TOWER_MODE_NAMES) {
      for (let k = 2; k <= TOWER_FLOORS; k += 1) assert.ok(multiplierBps(mode, k) > multiplierBps(mode, k - 1));
    }
  });

  it('places the TNT from the committed seed, exactly as a player can check it', () => {
    const seed = 'cd'.repeat(32);
    for (const mode of TOWER_MODE_NAMES) {
      const { tiles, traps } = TOWER_MODES[mode];
      const layout = trapLayout(seed, 'client', 7, mode);
      assert.deepEqual(trapLayout(seed, 'client', 7, mode), layout);
      assert.equal(layout.length, TOWER_FLOORS * traps);
      for (let floor = 0; floor < TOWER_FLOORS; floor += 1) {
        const onFloor = trapsOnFloor(layout, mode, floor);
        assert.equal(new Set(onFloor).size, traps);
        assert.ok(onFloor.every((tile) => Number.isInteger(tile) && tile >= 0 && tile < tiles));
        assert.deepEqual([...onFloor].sort((a, b) => a - b), onFloor);
        // An independent re-implementation of the published recipe agrees, floor by floor.
        const order = Array.from({ length: tiles }, (_, i) => i);
        for (let i = 0; i < traps; i += 1) {
          const digest = createHmac('sha256', seed).update(`client:7:${floor}:${i}`).digest('hex');
          const j = i + Math.floor((Number.parseInt(digest.slice(0, 13), 16) / 2 ** 52) * (tiles - i));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        assert.deepEqual(order.slice(0, traps).sort((a, b) => a - b), onFloor);
      }
      // A different client seed moves the TNT.
      assert.notDeepEqual(trapLayout(seed, 'other', 7, mode), layout);
    }
  });

  it('hides the TNT behind every tile about equally often, on every floor', () => {
    const games = 6_000;
    for (const mode of TOWER_MODE_NAMES) {
      const { tiles, traps } = TOWER_MODES[mode];
      const counts = Array.from({ length: TOWER_FLOORS }, () => new Array(tiles).fill(0));
      for (let game = 0; game < games; game += 1) {
        const layout = trapLayout(randomBytes(32).toString('hex'), 'c', 0, mode);
        for (let floor = 0; floor < TOWER_FLOORS; floor += 1) {
          for (const tile of trapsOnFloor(layout, mode, floor)) counts[floor]![tile] += 1;
        }
      }
      const expected = (games * traps) / tiles;
      for (const floor of counts) {
        for (const count of floor) {
          assert.ok(Math.abs(count - expected) < expected * 0.08, `${mode}: ${count} vs ${expected}`);
        }
      }
    }
  });
});

describe('tower routes', () => {
  it('never shows the TNT or the seed while a climb is in play', async () => {
    const source = await route();
    const view = source.slice(source.indexOf('function gameView('), source.indexOf('interface Settlement'));
    assert.match(view, /trapTiles: settled\s*\?/);
    assert.match(view, /serverSeed: settled \? row\.server_seed_reveal : null/);
    assert.equal(view.split('row.trap_tiles').length - 1, 1, 'trap_tiles is read once, behind settled');
  });

  it('locks the game, refuses a stale or impossible tap, and settles exactly once', async () => {
    const source = await route();
    assert.match(source, /SELECT \* FROM tower_games WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
    const pick = source.slice(source.indexOf("'/v1/tower/games/:id/pick'"), source.indexOf("'/v1/tower/games/:id/cashout'"));
    assert.match(pick, /if \(row\.status !== 'active'\) return/);
    assert.match(pick, /if \(floor !== body\.floor\) \{\s*conflict\('STALE_ACTION'/);
    assert.match(pick, /if \(body\.tile >= modeOf\(row\.mode\)\.tiles\)/);
    // The top floor, or the payout ceiling, cashes out on its own.
    assert.match(pick, /const top = cleared === TOWER_FLOORS;/);
    assert.match(pick, /if \(top \|\| capped\)/);
    const cashout = source.slice(source.indexOf("'/v1/tower/games/:id/cashout'"));
    assert.match(cashout, /if \(row\.picks\.length !== body\.floor\)/);
    const settle = source.slice(source.indexOf('async function settle('), source.indexOf('async function debit('));
    assert.match(settle, /WHERE id = \$1 AND status = 'active'/);
    assert.match(settle, /conflict\('NOTHING_TO_CASH'/);
    assert.match(settle, /creditWallet\(client, row\.user_id, payout, 'tower_payout', row\.id\)/);
    assert.match(settle, /recordWager\(client, config, row\.user_id, BigInt\(row\.stake_minor\), 'tower', row\.id/);
    assert.equal(source.split('creditWallet(').length - 1, 1); // the payout, and nothing else
    assert.match(source, /VALUES \(\$1, \$2, \$3, \$4, 'tower_stake', \$5\)/);
    assert.match(source, /WHERE user_id = \$1 AND balance_minor >= \$2/);
  });

  it('spends the fairness seed when the climb starts, and closing it never strands one', async () => {
    const source = await route();
    const start = source.slice(source.indexOf("'/v1/tower/games',"), source.indexOf("'/v1/tower/games/:id/pick'"));
    assert.match(start, /UPDATE fairness_seeds SET used_at = now\(\) WHERE id = \$1/);
    assert.match(start, /await insertFairnessSeed\(client, config, userId\)/);
    assert.match(start, /conflict\('GAME_IN_PLAY'/);
    assert.match(start, /trapLayout\(serverSeed, body\.clientSeed, fairness\.nonce, body\.mode\)/);
    assert.match(start, /if \(!config\.towerEnabled\)/);
    const rest = source.slice(source.indexOf("'/v1/tower/games/:id/pick'"));
    assert.doesNotMatch(rest, /towerEnabled/);
  });

  it('only widens the constraints it touches, from the lists in force', async () => {
    const values = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/068_tower.sql');
    const lists: Array<[string, string, string[]]> = [
      ['wallet_transactions_kind_check', '067_media_test_mode.sql', ['tower_stake', 'tower_payout']],
      ['wager_events_source_check', '057_mines_duel.sql', ['tower']],
      ['faction_contributions_source_check', '057_mines_duel.sql', ['tower']],
      ['referral_earnings_source_check', '057_mines_duel.sql', ['tower']],
    ];
    for (const [constraint, file, added] of lists) {
      const before = values(await read(`packages/db/migrations/${file}`), constraint);
      const after = values(migration, constraint);
      for (const value of before) assert.ok(after.has(value), `068 drops ${value} from ${constraint}`);
      assert.deepEqual([...after].filter((value) => !before.has(value)).sort(), [...added].sort());
    }
    assert.match(migration, /CREATE UNIQUE INDEX tower_games_one_active_idx ON tower_games \(user_id\) WHERE status = 'active'/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE tower_games TO donut_api_runtime;/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v68\(\) RETURNS boolean/);
  });

  it('is counted everywhere a game is: wagers, the ledger, the feed, the stats and the settings', async () => {
    const [settlement, wallet, activity, stats, settings, app, compose] = await Promise.all([
      read('services/api-gateway/src/lib/cash-settlement.ts'),
      read('services/api-gateway/src/lib/wallet.ts'),
      read('services/api-gateway/src/routes/activity.ts'),
      read('services/api-gateway/src/lib/admin-stats.ts'),
      read('services/api-gateway/src/lib/runtime-settings.ts'),
      read('services/api-gateway/src/app.ts'),
      read('infra/docker/compose.yml'),
    ]);
    assert.match(settlement, /\| 'tower'/);
    assert.match(wallet, /\| 'tower_payout'/);
    assert.match(activity, /SELECT g\.id, 'tower'::text AS kind/);
    assert.match(activity, /SELECT 'tower', g\.user_id FROM tower_games g, since/);
    assert.match(stats, /key: 'tower', label: 'Tower', stakes: \['tower_stake'\], payouts: \['tower_payout'\]/);
    for (const key of ['towerEnabled', 'towerMinStakeMinor', 'towerMaxStakeMinor', 'towerMaxPayoutMinor']) {
      assert.match(settings, new RegExp(`${key}: \\{`));
    }
    assert.match(app, /await registerTowerRoutes\(app, db, config\);/);
    assert.match(compose, /TOWER_MAX_PAYOUT_MINOR: '\$\{TOWER_MAX_PAYOUT_MINOR:-50000000000\}'/);
  });
});

describe('the tower page', () => {
  it('is a page, a lobby card, a sidebar link and a sitemap entry', async () => {
    const [html, app, nginx, sitemap, seo, data] = await Promise.all([
      front('index.html'),
      front('assets/js/app.js'),
      read('infra/nginx/nginx.conf'),
      front('sitemap.xml'),
      front('assets/js/seo.js'),
      front('assets/js/data.js'),
    ]);
    assert.match(html, /<section class="view" data-view="tower" hidden>/);
    assert.match(html, /<div class="tower" id="towerRoot"><\/div>/);
    assert.match(html, /<a class="gcard lxcard" href="\/tower" data-cat="casino" data-game="tower"/);
    assert.match(html, /<a class="lxnav" href="\/tower" data-route="tower" data-tip="Tower">/);
    assert.match(html, /href="assets\/css\/tower\.css"/);
    assert.match(app, /tower: mountTower,/);
    assert.match(nginx, /\|mines\|tower\|plinko\|/);
    assert.match(nginx, /\/tower "https:\/\/donutluxe\.com\/tower";/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/tower<\/loc>/);
    assert.match(seo, /tower: \{\s*title: 'DonutLuxe Tower/);
    assert.match(data, /route: '\/tower', name: 'Tower', art: 'beacon\.png', shipped: '2026-10-14'/);
  });

  it('prices the floors with the server’s formula and asks the server for every tile', async () => {
    const page = await front('assets/js/tower.js');
    assert.match(page, /easy: \{ tiles: 4, traps: 1/);
    assert.match(page, /medium: \{ tiles: 3, traps: 1/);
    assert.match(page, /hard: \{ tiles: 2, traps: 1/);
    assert.match(page, /expert: \{ tiles: 3, traps: 2/);
    assert.match(page, /const EDGE_BPS = 1000n;/);
    assert.match(page, /api\.post\(`\/v1\/tower\/games\/\$\{game\.id\}\/pick`, \{ tile, floor \}\)/);
    assert.match(page, /api\.post\(`\/v1\/tower\/games\/\$\{game\.id\}\/cashout`, \{ floor: game\.floor \}\)/);
    // Only the floor being climbed takes a press.
    assert.match(page, /node\.disabled = !live;/);
    // The difficulty is a radio group.
    assert.match(page, /role="radiogroup" aria-labelledby="towerModeLabel"/);
  });

  it('sits in the shared game frame, in the site’s tokens', async () => {
    const [frame, css] = await Promise.all([front('assets/css/luxe-games.css'), front('assets/css/tower.css')]);
    assert.match(frame, /body\.lx :is\(\.crash, \.mines, \.tower, \.plinko\) \{/);
    assert.match(frame, /:is\(\.crash, \.mines, \.tower, \.plinko, \.bj, \.roulette, \.upg\)/);
    // Every colour in the board's rules is a token; the few it needs are lifted to the top.
    const rules = css.slice(css.indexOf('/* ─────────── the tower'));
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'a raw colour outside the token block');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.tower \{ --tower-tile-h: 44px; \}/);
  });
});
