import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  CHICKEN_HOUSE_EDGE_BPS,
  CHICKEN_LANES,
  CHICKEN_MODES,
  CHICKEN_MODE_NAMES,
  cartLane,
  laneHasCart,
  multiplierBps,
  oddsAgainst,
  payoutFor,
  safeChanceBps,
} from '../src/lib/chicken.js';

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');
const route = () => read('services/api-gateway/src/routes/chicken.ts');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('chicken engine', () => {
  it('has four difficulties over twenty lanes', () => {
    assert.deepEqual(CHICKEN_MODE_NAMES, ['easy', 'medium', 'hard', 'hardcore']);
    assert.deepEqual(CHICKEN_MODES, {
      easy: { hit: 1, of: 6 },
      medium: { hit: 1, of: 4 },
      hard: { hit: 1, of: 3 },
      hardcore: { hit: 1, of: 2 },
    });
    assert.equal(CHICKEN_LANES, 20);
  });

  it('returns at most 90% at every cash-out point, in every mode', () => {
    const stake = 10n ** 15n;
    const ninety = (stake * BigInt(10_000 - CHICKEN_HOUSE_EDGE_BPS)) / 10_000n;
    for (const mode of CHICKEN_MODE_NAMES) {
      for (let k = 1; k <= CHICKEN_LANES; k += 1) {
        const { num, den } = oddsAgainst(mode, k);
        const expected = (payoutFor(stake, mode, k) * den) / num;
        assert.ok(expected <= ninety, `${mode}, ${k} lanes returns more than 90%`);
        assert.ok(ninety - expected <= 1n, `${mode}, ${k} lanes returns well under 90%`);
      }
    }
  });

  it('prices the lanes the way the formula says, every first lane above the stake', () => {
    assert.equal(multiplierBps('easy', 1), 10_800); // 6/5 · 0.9
    assert.equal(multiplierBps('medium', 1), 12_000); // 4/3 · 0.9
    assert.equal(multiplierBps('hard', 1), 13_500); // 3/2 · 0.9
    assert.equal(multiplierBps('hardcore', 1), 18_000); // 2 · 0.9
    assert.equal(multiplierBps('easy', 20), 345_038); // (6/5)^20 · 0.9
    assert.equal(multiplierBps('hardcore', 20), 9_437_184_000); // 2^20 · 0.9
    assert.deepEqual(CHICKEN_MODE_NAMES.map(safeChanceBps), [8_333, 7_500, 6_666, 5_000]);
    for (const mode of CHICKEN_MODE_NAMES) {
      assert.ok(multiplierBps(mode, 1) > 10_000, `${mode}'s first lane pays under the stake`);
      for (let k = 2; k <= CHICKEN_LANES; k += 1) assert.ok(multiplierBps(mode, k) > multiplierBps(mode, k - 1));
    }
  });

  it('puts the minecart on the lane the committed seed says, exactly as a player can check it', () => {
    const seed = 'cd'.repeat(32);
    for (const mode of CHICKEN_MODE_NAMES) {
      const { hit, of } = CHICKEN_MODES[mode];
      const lane = cartLane(seed, 'client', 7, mode);
      assert.equal(cartLane(seed, 'client', 7, mode), lane);
      // An independent re-implementation of the published recipe agrees, lane by lane.
      let first: number | null = null;
      for (let i = 0; i < CHICKEN_LANES && first === null; i += 1) {
        const digest = createHmac('sha256', seed).update(`client:7:${i}`).digest('hex');
        if (Math.floor((Number.parseInt(digest.slice(0, 13), 16) / 2 ** 52) * of) < hit) first = i;
      }
      assert.equal(lane, first);
      if (lane !== null) {
        assert.equal(laneHasCart(seed, 'client', 7, mode, lane), true);
        for (let i = 0; i < lane; i += 1) assert.equal(laneHasCart(seed, 'client', 7, mode, i), false);
      }
    }
  });

  it('puts a minecart on a lane as often as the difficulty says', () => {
    const games = 20_000;
    for (const mode of CHICKEN_MODE_NAMES) {
      const { hit, of } = CHICKEN_MODES[mode];
      let carts = 0;
      for (let game = 0; game < games; game += 1) {
        if (laneHasCart(randomBytes(32).toString('hex'), 'c', 0, mode, 0)) carts += 1;
      }
      const expected = (games * hit) / of;
      assert.ok(Math.abs(carts - expected) < expected * 0.06, `${mode}: ${carts} vs ${expected}`);
    }
  });
});

describe('chicken routes', () => {
  it('never shows the minecart or the seed while a run is in play', async () => {
    const source = await route();
    const view = source.slice(source.indexOf('function gameView('), source.indexOf('interface Settlement'));
    assert.match(view, /cartLane: settled \? row\.cart_lane : undefined/);
    assert.match(view, /serverSeed: settled \? row\.server_seed_reveal : null/);
    assert.equal(view.split('row.cart_lane').length - 1, 1, 'cart_lane is read once, behind settled');
  });

  it('locks the run, refuses a stale press, and settles exactly once', async () => {
    const source = await route();
    assert.match(source, /SELECT \* FROM chicken_games WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
    const step = source.slice(source.indexOf("'/v1/chicken/games/:id/step'"), source.indexOf("'/v1/chicken/games/:id/cashout'"));
    assert.match(step, /if \(row\.status !== 'active'\) return/);
    assert.match(step, /if \(row\.crossed !== body\.lane\) \{\s*conflict\('STALE_ACTION'/);
    assert.match(step, /if \(row\.cart_lane === row\.crossed\) \{\s*const settled = await settle\(client, config, row, 'hit'\);/);
    assert.match(step, /const end = next\.crossed === CHICKEN_LANES;/);
    assert.match(step, /if \(end \|\| capped\)/);
    const cashout = source.slice(source.indexOf("'/v1/chicken/games/:id/cashout'"));
    assert.match(cashout, /if \(row\.crossed !== body\.crossed\)/);
    const settle = source.slice(source.indexOf('async function settle('), source.indexOf('async function debit('));
    assert.match(settle, /WHERE id = \$1 AND status = 'active'/);
    assert.match(settle, /conflict\('NOTHING_TO_CASH'/);
    assert.match(settle, /creditWallet\(client, row\.user_id, payout, 'chicken_payout', row\.id\)/);
    assert.match(settle, /recordWager\(client, config, row\.user_id, BigInt\(row\.stake_minor\), 'chicken', row\.id/);
    assert.equal(source.split('creditWallet(').length - 1, 1);
    assert.match(source, /VALUES \(\$1, \$2, \$3, \$4, 'chicken_stake', \$5\)/);
    // A test-mode win is never posted.
    assert.equal(source.match(/announce\(config, flexName\(request\.authUser\)/g)?.length, 2);
  });

  it('spends the fairness seed when the run starts, and closing it never strands one', async () => {
    const source = await route();
    const start = source.slice(source.indexOf("'/v1/chicken/games',"), source.indexOf("'/v1/chicken/games/:id/step'"));
    assert.match(start, /UPDATE fairness_seeds SET used_at = now\(\) WHERE id = \$1/);
    assert.match(start, /await insertFairnessSeed\(client, config, userId\)/);
    assert.match(start, /conflict\('GAME_IN_PLAY'/);
    assert.match(start, /cartLane\(serverSeed, body\.clientSeed, fairness\.nonce, body\.mode\)/);
    assert.match(start, /if \(!config\.chickenEnabled\)/);
    assert.doesNotMatch(source.slice(source.indexOf("'/v1/chicken/games/:id/step'")), /chickenEnabled/);
  });

  it('only widens the constraints it touches, from the lists in force', async () => {
    const values = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/069_chicken.sql');
    const previous = await read('packages/db/migrations/068_tower.sql');
    const lists: Array<[string, string[]]> = [
      ['wallet_transactions_kind_check', ['chicken_stake', 'chicken_payout']],
      ['wager_events_source_check', ['chicken']],
      ['faction_contributions_source_check', ['chicken']],
      ['referral_earnings_source_check', ['chicken']],
    ];
    for (const [constraint, added] of lists) {
      const before = values(previous, constraint);
      const after = values(migration, constraint);
      for (const value of before) assert.ok(after.has(value), `069 drops ${value} from ${constraint}`);
      assert.deepEqual([...after].filter((value) => !before.has(value)).sort(), [...added].sort());
    }
    assert.match(migration, /CHECK \(cart_lane IS NULL OR crossed <= cart_lane\)/);
    assert.match(migration, /CHECK \(outcome IS DISTINCT FROM 'hit' OR \(cart_lane = crossed AND payout_minor = 0\)\)/);
    assert.match(migration, /CREATE UNIQUE INDEX chicken_games_one_active_idx ON chicken_games \(user_id\) WHERE status = 'active'/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE chicken_games TO donut_api_runtime;/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v69\(\) RETURNS boolean/);
  });

  it('is counted everywhere a game is', async () => {
    const [settlement, wallet, activity, stats, settings, app, compose, media] = await Promise.all([
      read('services/api-gateway/src/lib/cash-settlement.ts'),
      read('services/api-gateway/src/lib/wallet.ts'),
      read('services/api-gateway/src/routes/activity.ts'),
      read('services/api-gateway/src/lib/admin-stats.ts'),
      read('services/api-gateway/src/lib/runtime-settings.ts'),
      read('services/api-gateway/src/app.ts'),
      read('infra/docker/compose.yml'),
      read('services/api-gateway/src/lib/media-test.ts'),
    ]);
    assert.match(settlement, /\| 'chicken'/);
    assert.match(wallet, /\| 'chicken_payout'/);
    assert.equal(activity.match(/'chicken'::text AS kind/g)?.length, 2, 'the live feed and the day’s wins');
    assert.match(activity, /SELECT 'chicken', g\.user_id FROM chicken_games g, since/);
    assert.match(stats, /key: 'chicken', label: 'Chicken', stakes: \['chicken_stake'\], payouts: \['chicken_payout'\]/);
    for (const key of ['chickenEnabled', 'chickenMinStakeMinor', 'chickenMaxStakeMinor', 'chickenMaxPayoutMinor']) {
      assert.match(settings, new RegExp(`${key}: \\{`));
    }
    assert.match(app, /await registerChickenRoutes\(app, db, config\);/);
    assert.match(compose, /CHICKEN_MAX_PAYOUT_MINOR: '\$\{CHICKEN_MAX_PAYOUT_MINOR:-50000000000\}'/);
    assert.match(media, /'POST \/v1\/chicken\/games\/:id\/step'/);
  });
});

describe('the chicken page', () => {
  it('is a page, a lobby card, a sidebar link and a sitemap entry', async () => {
    const [html, app, nginx, sitemap, seo, data, admin] = await Promise.all([
      front('index.html'),
      front('assets/js/app.js'),
      read('infra/nginx/nginx.conf'),
      front('sitemap.xml'),
      front('assets/js/seo.js'),
      front('assets/js/data.js'),
      front('admin/admin.js'),
    ]);
    assert.match(html, /<section class="view" data-view="chicken" hidden>/);
    assert.match(html, /<div class="chicken" id="chickenRoot"><\/div>/);
    assert.match(html, /<a class="gcard lxcard" href="\/chicken" data-cat="casino" data-game="chicken"/);
    assert.match(html, /<img class="lxcard__art retroart" src="assets\/img\/items\/chicken\.svg"/);
    assert.match(html, /<a class="lxnav" href="\/chicken" data-route="chicken" data-tip="Chicken">/);
    assert.match(html, /href="assets\/css\/chicken\.css"/);
    assert.match(app, /chicken: mountChicken,/);
    assert.match(app, /chicken: \{ name: 'Chicken', art: 'assets\/img\/items\/chicken\.svg' \}/);
    assert.match(nginx, /\|tower\|chicken\|plinko\|/);
    assert.match(nginx, /\/chicken "https:\/\/donutluxe\.com\/chicken";/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/chicken<\/loc>/);
    assert.match(seo, /chicken: \{\s*title: 'DonutLuxe Chicken/);
    assert.match(data, /route: '\/chicken', name: 'Chicken', art: 'chicken\.svg', shipped: '2026-10-15'/);
    assert.match(admin, /chicken: 'Chicken',/);
    assert.match(admin, /tower: 'Tower',/);
  });

  it('prices the lanes with the server’s formula and asks the server for every step', async () => {
    const page = await front('assets/js/chicken.js');
    for (const [mode, of] of [['easy', 6], ['medium', 4], ['hard', 3], ['hardcore', 2]] as const) {
      assert.match(page, new RegExp(`${mode}: \\{ hit: 1, of: ${of},`));
    }
    assert.match(page, /const EDGE_BPS = 1000n;/);
    assert.match(page, /api\.post\(`\/v1\/chicken\/games\/\$\{game\.id\}\/step`, \{ lane \}\)/);
    assert.match(page, /api\.post\(`\/v1\/chicken\/games\/\$\{game\.id\}\/cashout`, \{ crossed: game\.crossed \}\)/);
    assert.match(page, /role="radiogroup" aria-labelledby="chickenModeLabel"/);
  });

  it('scrolls the road inside its own box, in the site’s tokens, with reduced motion honoured', async () => {
    const [frame, css, sprite] = await Promise.all([
      front('assets/css/luxe-games.css'),
      front('assets/css/chicken.css'),
      front('assets/img/items/chicken.svg'),
    ]);
    assert.match(frame, /body\.lx :is\(\.crash, \.mines, \.tower, \.chicken, [^)]*\.plinko\) \{/);
    assert.match(css, /\.chicken__road \{[^}]*overflow-x: auto;/);
    assert.match(css, /\.chicken__road:focus-visible/);
    const rules = css.slice(css.indexOf('/* ─────────── the road'));
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'a raw colour outside the token block');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(sprite, /viewBox="0 0 16 16" shape-rendering="crispEdges"/);
  });
});

describe('chicken in 3D', () => {
  const front = (relative: string) => readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop', relative), 'utf8');
  const img = (relative: string) => path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/img', relative);

  it('lays the meadow out of the game’s own pictures and models', async () => {
    const meadow = await front('assets/js/chicken3d.js');
    const quoted = (list: string) => [...(meadow.match(new RegExp(`const ${list} = \\[([^;]+)\\];`))?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    for (const name of quoted('BLOCKS')) assert.ok(existsSync(img(`block/${name}.png`)), `block ${name}`);
    for (const name of quoted('ENTITY')) assert.ok(existsSync(img(`entity/${name}.png`)), `entity ${name}`);
    for (const [, file] of meadow.matchAll(/loadImage\('assets\/img\/([^']+)'\)/g)) assert.ok(existsSync(img(file!)), file);
    // MinecartModel (shared in mcmodels.js): the floor turned flat and four sides round it.
    const models = await front('assets/js/mcmodels.js');
    assert.ok(models.includes("{ name: 'bottom', pivot: [0, 4, 0], rot: [Math.PI / 2, 0, 0], cubes: [{ u: 0, v: 10, x: -10, y: -8, z: -1, w: 20, h: 16, d: 2 }] }"));
    assert.ok(models.includes("{ name: 'front', pivot: [-9, 4, 0], rot: [0, (3 * Math.PI) / 2, 0]"));
    assert.ok(meadow.includes('def: MINECART'));
    assert.ok(meadow.includes('def: CHICKEN'));
    // What a line pays, on its sign, in the game's font.
    assert.match(meadow, /drawText\(g, font, text,/);
  });

  it('hops when the page says, and keeps the flat road for a screen reader', async () => {
    const [meadow, page, css] = await Promise.all([front('assets/js/chicken3d.js'), front('assets/js/chicken.js'), front('assets/css/chicken.css')]);
    assert.match(page, /await import\('\.\/chicken3d\.js'\)/);
    // The hop (and the minecart) play out before the page says what happened.
    assert.match(page, /game = response\.game;\n\s*if \(road3d\) await road3d\.step\(lane, game\.outcome === 'hit'\);/);
    assert.match(page, /times\(multiplierBps\(name, lane \+ 1\)\)\.replace\('×', 'x'\)/);
    assert.match(css, /\.chicken:is\(\[data-render="3d"\], \[data-render="loading"\]\) \.chicken__road \{\n  position: absolute;\n  width: 1px;/);
    assert.match(meadow, /import \{ BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor \} from '\.\/quality3d\.js';/);
  });
});
