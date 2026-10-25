import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ICE_FISHING_CATCHES,
  ICE_FISHING_HOLES,
  ICE_FISHING_HOUSE_EDGE_BPS,
  ICE_FISHING_MAX_THIN,
  ICE_FISHING_MIN_THIN,
  catchAt,
  multiplierAfter,
  oddsAgainst,
  payoutAfter,
  thinHoles,
} from '../src/lib/ice-fishing.js';
import { MINES_HOUSE_EDGE_BPS, minePositions, multiplierBps } from '../src/lib/mines.js';

const root = path.resolve(import.meta.dirname, '../../..');
const read = async (file: string) => (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
const front = (file: string) => read(`DONUTDROP FRONTEND/Donut Drop/${file}`);

describe('ice fishing: the lake', () => {
  it('is Mines on the ice: the same draw, the same multipliers, the same 90% whenever the player pulls out', () => {
    assert.equal(ICE_FISHING_HOUSE_EDGE_BPS, MINES_HOUSE_EDGE_BPS);
    assert.equal(ICE_FISHING_HOLES, 25);
    assert.deepEqual([ICE_FISHING_MIN_THIN, ICE_FISHING_MAX_THIN], [1, 24]);
    for (let thin = 1; thin <= 24; thin += 1) {
      assert.deepEqual(thinHoles('s'.repeat(64), 'client', 4, thin), minePositions('s'.repeat(64), 'client', 4, thin));
      for (let drilled = 1; drilled <= 25 - thin; drilled += 1) {
        assert.equal(multiplierAfter(thin, drilled), multiplierBps(thin, drilled));
        // Pulling out after `drilled` fish, exactly: P(survive) x pay = 90%, before the floor.
        const { num, den } = oddsAgainst(thin, drilled);
        const pay = payoutAfter(10n ** 18n, thin, drilled);
        assert.ok(pay * den <= (10n ** 18n * 9n * num) / 10n);
        assert.ok(pay * den > (10n ** 18n * 9n * num) / 10n - den);
      }
    }
  });

  it('names each fish by how far the game has got, from a raw cod to a heart of the sea', () => {
    assert.equal(catchAt(9_375).id, 'cod');
    assert.equal(catchAt(15_000).id, 'salmon');
    assert.equal(catchAt(100_000).id, 'heart_of_the_sea');
    for (const [, id] of ICE_FISHING_CATCHES) assert.ok(existsSync(path.join(root, `DONUTDROP FRONTEND/Donut Drop/assets/img/items/${id}.png`)), id);
  });
});

describe('ice fishing: the route and the schema', () => {
  it('lays the ice at the start from the committed seed, and settles once', async () => {
    const route = await read('services/api-gateway/src/routes/ice-fishing.ts');
    const start = route.slice(route.indexOf("'/v1/ice-fishing/games',\n"), route.indexOf("'/v1/ice-fishing/games/:id/drill'"));
    assert.ok(start.indexOf('await debit(') < start.indexOf('thinHoles(serverSeed, body.clientSeed, fairness.nonce, body.thin)'));
    assert.match(route, /thin: z\.number\(\)\.int\(\)\.min\(ICE_FISHING_MIN_THIN\)\.max\(ICE_FISHING_MAX_THIN\),/);
    assert.match(route, /if \(row\.thin_holes\.includes\(body\.hole\)\) \{\n\s*const settled = await settle\(client, config, row, 'thin', body\.hole\);/);
    assert.match(route, /creditWallet\(client, row\.user_id, payout, 'ice_fishing_payout', row\.id\)/);
    assert.equal(route.split('recordWager(').length - 1, 1);
    // The thin ice never reaches a browser before the game is over.
    assert.match(route, /thinHoles: settled \? row\.thin_holes : null,/);
    assert.match(route, /serverSeed: settled \? row\.server_seed_reveal : null,/);
  });

  it('widens every source and kind list by Ice Fishing, and keeps one game on the ice per player', async () => {
    const sql = await read('packages/db/migrations/077_ice_fishing.sql');
    for (const list of ['wallet_transactions_kind_check', 'wager_events_source_check', 'faction_contributions_source_check', 'referral_earnings_source_check']) {
      assert.ok(sql.includes(`DROP CONSTRAINT ${list}`), list);
    }
    assert.match(sql, /'fishing_stake', 'fishing_payout',\n\s*'ice_fishing_stake', 'ice_fishing_payout'/);
    assert.match(sql, /CREATE UNIQUE INDEX ice_fishing_games_one_active_idx ON ice_fishing_games \(user_id\) WHERE status = 'active';/);
    assert.match(sql, /CHECK \(outcome IS DISTINCT FROM 'thin' OR \(thin_hit IS NOT NULL AND payout_minor = 0\)\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v77\(\)/);
    const [activity, alerts, stats, app, media, insights] = await Promise.all([
      read('services/api-gateway/src/routes/activity.ts'), read('services/api-gateway/src/lib/staff-alerts.ts'),
      read('services/api-gateway/src/lib/admin-stats.ts'), read('services/api-gateway/src/app.ts'),
      read('services/api-gateway/src/lib/media-test.ts'), read('services/api-gateway/src/routes/insights.ts'),
    ]);
    assert.equal(activity.split("'icefishing'::text AS kind, s.settled_at AS created_at").length - 1, 2);
    assert.match(activity, /FROM ice_fishing_games s, since\n\s*WHERE s\.created_at > since\.at OR s\.settled_at > since\.at/);
    assert.match(alerts, /FROM ice_fishing_games g\n\s*WHERE g\.status = 'settled'/);
    assert.match(stats, /\{ key: 'ice_fishing', label: 'Ice Fishing', stakes: \['ice_fishing_stake'\], payouts: \['ice_fishing_payout'\], refunds: \[\] \}/);
    assert.match(app, /await registerIceFishingRoutes\(app, db, config\);/);
    assert.match(media, /'POST \/v1\/ice-fishing\/games\/:id\/drill',/);
    assert.match(insights, /FROM ice_fishing_games WHERE user_id = \$1 AND status = 'settled'/);
  });
});

describe('ice fishing: the page and the lake', () => {
  it('starts, drills and pulls out as the server says, and loads the 3D lake as its own chunk', async () => {
    const page = await front('assets/js/icefishing.js');
    assert.match(page, /const \{ createIce3d \} = await import\('\.\/icefishing3d\.js'\);/);
    assert.doesNotMatch(page, /^import .*icefishing3d/m);
    assert.match(page, /\{ stakeMinor: stakeMinor\(\)\.toString\(\), thin: thinCount, clientSeed: clientSeed\(\), serverSeedHash \}/);
    assert.match(page, /api\.post\(`\/v1\/ice-fishing\/games\/\$\{game\.id\}\/drill`, \{ hole, drilledCount: game\.drilled\.length \}\)/);
    assert.match(page, /api\.post\(`\/v1\/ice-fishing\/games\/\$\{game\.id\}\/cashout`, \{ drilledCount: game\.drilled\.length \}\)/);
    assert.match(page, /api\.get\('\/v1\/ice-fishing\/games\/active'\)/);
    // The lake draws what the server answered, never ahead of it.
    const drill = page.slice(page.indexOf('async function drill('), page.indexOf('async function cashOut('));
    assert.ok(drill.indexOf('await api.post(') < drill.indexOf('await lake.drill('));
  });

  it('draws only the game’s own pictures, and lets a hole be picked on the lake', async () => {
    const lake = await front('assets/js/icefishing3d.js');
    const lists = [...lake.matchAll(/const (BLOCKS|ENTITY|ENV) = \[([^\]]+)\];/g)];
    assert.equal(lists.length, 3);
    const dirs = { BLOCKS: 'block', ENTITY: 'entity', ENV: 'env' } as const;
    for (const [, kind, names] of lists) {
      for (const name of (names ?? '').match(/'([a-z0-9_]+)'/g)!.map((quoted) => quoted.slice(1, -1))) {
        assert.ok(existsSync(path.join(root, 'DONUTDROP FRONTEND/Donut Drop/assets/img', dirs[kind as keyof typeof dirs], `${name}.png`)), `${kind} ${name}`);
      }
    }
    for (const [, file] of lake.matchAll(/loadImage\('(assets\/img\/[^']+)'\)/g)) {
      assert.ok(existsSync(path.join(root, 'DONUTDROP FRONTEND/Donut Drop', file!)), file);
    }
    assert.match(lake, /const hit = raycaster\.intersectObject\(tiles, false\)\[0\];/);
    assert.match(lake, /import \{ chooseTier, createGovernor, frameMs, minFpsFor, ratioFor \} from '\.\/quality3d\.js';/);
  });

  it('is a page of its own: route, view, lobby card, sidebar, feed, search and sitemap', async () => {
    const [html, app, chat, data, store, ticker, account, seo, sitemap, nginx, css] = await Promise.all([
      front('index.html'), front('assets/js/app.js'), front('assets/js/chat.js'), front('assets/js/data.js'), front('assets/js/store.js'),
      front('assets/js/ticker.js'), front('assets/js/account.js'), front('assets/js/seo.js'), front('sitemap.xml'), read('infra/nginx/nginx.conf'),
      front('assets/css/icefishing.css'),
    ]);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/icefishing\.css" \/>/);
    assert.match(html, /<a class="lxnav" href="\/ice-fishing" data-route="ice-fishing" data-tip="Ice Fishing">/);
    assert.match(html, /<a class="gcard lxcard" href="\/ice-fishing" data-cat="casino" data-game="ice-fishing"/);
    assert.match(html, /<section class="view" data-view="ice-fishing" hidden>[\s\S]*?<div class="icefish" id="icefishRoot"><\/div>/);
    assert.match(app, /'ice-fishing': mountIceFishing,/);
    assert.match(app, /icefishing: \{ name: 'Ice Fishing', art: 'assets\/img\/items\/game-ice-fishing\.svg' \}/);
    assert.match(chat, /\['icefishing', 'Ice Fishing'\]/);
    assert.match(data, /route: '\/ice-fishing', name: 'Ice Fishing', art: 'game-ice-fishing\.svg', shipped: '2026-10-22'/);
    assert.match(store, /raw\.kind === 'icefishing'/);
    assert.match(ticker, /if \(kind === 'icefishing'\) return 'Ice Fishing';/);
    assert.match(account, /ice_fishing_stake: 'Ice Fishing game',\n\s*ice_fishing_payout: 'Ice Fishing catch',/);
    assert.match(seo, /'ice-fishing': \{\n\s*title: 'DonutLuxe Ice Fishing — DonutSMP Mines',/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/ice-fishing<\/loc>/);
    assert.ok(nginx.includes('/ice-fishing "https://donutluxe.com/ice-fishing"'));
    assert.match(nginx, /\|fishing\|ice-fishing\|/);
    assert.match(await front('assets/img/items/game-ice-fishing.svg'), /viewBox="0 0 16 16" shape-rendering="crispEdges"/);
    const rules = css.slice(css.indexOf('/* ─────────── the lake'));
    assert.ok(rules.length > 1000);
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'a raw colour outside the token block');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.icefish\[data-render="3d"\] \.icefish__flat \{ display: none; \}/);
  });
});
