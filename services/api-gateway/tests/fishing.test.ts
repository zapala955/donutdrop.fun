import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import {
  FISHING_CATCHES,
  FISHING_GROWTH,
  FISHING_HOUSE_EDGE_BPS,
  FISHING_LADDER,
  FISHING_MAX_X100,
  FISHING_MIN_LAND_X100,
  FISHING_SINKERS,
  catchAt,
  judge,
  maxStakeFor,
  multiplierAt,
  payoutAt,
  secondsToReach,
  snapFromSample,
  snapPoint,
} from '../src/lib/fishing.js';
import { crashPointFromSample } from '../src/lib/crash.js';

const root = path.resolve(import.meta.dirname, '../../..');
const read = async (file: string) => (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
const front = (file: string) => read(`DONUTDROP FRONTEND/Donut Drop/${file}`);
const TWO_POW_52 = 2n ** 52n;

describe('fishing: the line', () => {
  it('snaps on Crash’s own curve, so no landing returns more than 90%', () => {
    assert.equal(FISHING_HOUSE_EDGE_BPS, 1000);
    // The breaking point is lib/crash.ts's formula, sample for sample.
    for (const h of [0n, 1n, 12345678901234n, TWO_POW_52 / 10n, TWO_POW_52 / 2n, TWO_POW_52 - 4504n, TWO_POW_52 - 1n]) {
      assert.equal(snapFromSample(h), crashPointFromSample(h), String(h));
    }
    /* Exactly, in integers. The formula only grows with h, so the samples that hold a line to x
     * are the top ones: count them by bisection. A landing at L is paid L/100 when the line
     * holds past it (S ≥ L + 1); landing · count must stay within 90% of 100 · 2^52. */
    const holding = (x: number) => {
      let lo = 0n;
      let hi = TWO_POW_52;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        if (snapFromSample(mid) >= x) hi = mid;
        else lo = mid + 1n;
      }
      return TWO_POW_52 - lo;
    };
    for (const landing of [101, 102, 150, 199, 200, 333, 1000, 2500, 10_000, 50_000, 99_999]) {
      const wins = landing + 1 > FISHING_MAX_X100 ? 0n : holding(landing + 1);
      assert.ok(BigInt(landing) * wins <= 90n * TWO_POW_52, `landing at ${landing}`);
      assert.ok(BigInt(landing) * wins >= 89n * TWO_POW_52, `landing at ${landing} returns well under 90%`);
    }
    // About one cast in 9.2 snaps on the bite.
    assert.equal(snapFromSample(0n), 100);
    const onTheBite = Number(TWO_POW_52 - holding(101)) / Number(TWO_POW_52);
    assert.ok(Math.abs(onTheBite - (1 - 0.9 / 1.01)) < 1e-9, String(onTheBite));
    assert.equal(snapFromSample(TWO_POW_52 - 1n), FISHING_MAX_X100);
  });

  it('draws from the first 52 bits of the HMAC, exactly as a player can check it', () => {
    const digest = createHmac('sha256', 'server').update('client:7', 'utf8').digest('hex');
    const { snapX100, sample } = snapPoint('server', 'client', 7);
    assert.equal(sample, digest.slice(0, 13));
    assert.equal(snapX100, snapFromSample(BigInt(`0x${digest.slice(0, 13)}`)));
    assert.deepEqual(snapPoint('server', 'client', 7), { snapX100, sample });
  });

  it('holds at Crash’s shape over many seeds: 90% over x hold past x', () => {
    const casts = 40_000;
    const held = { 101: 0, 200: 0, 1000: 0 };
    for (let nonce = 0; nonce < casts; nonce += 1) {
      const { snapX100 } = snapPoint('fairness', 'c', nonce);
      for (const x of [101, 200, 1000] as const) if (snapX100 > x) held[x] += 1;
    }
    assert.ok(Math.abs(held[101] / casts - 0.9 / 1.02) < 0.01, String(held[101]));
    assert.ok(Math.abs(held[200] / casts - 0.9 / 2.01) < 0.01, String(held[200]));
    assert.ok(Math.abs(held[1000] / casts - 0.9 / 10.01) < 0.006, String(held[1000]));
  });

  it('sinks at the sinker’s pace, Crash’s own with a feather, and holds at most 1000x', () => {
    assert.deepEqual(FISHING_SINKERS, ['feather', 'iron', 'anvil']);
    assert.equal(FISHING_GROWTH.feather, 0.07);
    assert.ok(FISHING_GROWTH.feather < FISHING_GROWTH.iron && FISHING_GROWTH.iron < FISHING_GROWTH.anvil);
    assert.equal(multiplierAt('feather', 0), 100);
    assert.equal(multiplierAt('feather', -3), 100);
    assert.equal(multiplierAt('feather', Math.log(2) / 0.07), 200);
    assert.equal(multiplierAt('anvil', 999), FISHING_MAX_X100);
    for (const sinker of FISHING_SINKERS) {
      for (const x of [101, 150, 237, 1000, 54_321]) {
        assert.equal(multiplierAt(sinker, secondsToReach(sinker, x) + 1e-6), x, `${sinker} ${x}`);
      }
    }
  });

  it('judges a cast as it stands: its auto target first, then the snap, then a landing by hand', () => {
    assert.deepEqual(judge(300, 250, null), { outcome: 'open' });
    assert.deepEqual(judge(300, 250, null, true), { outcome: 'landed', landedX100: 250 });
    // At its breaking point the line has snapped, even if a landing is asked for.
    assert.deepEqual(judge(300, 300, null, true), { outcome: 'snapped' });
    // An auto target below the snap lands there, however far the line has gone since ...
    assert.deepEqual(judge(300, 900, 200), { outcome: 'landed', landedX100: 200 });
    // ... and one at or above the snap never does.
    assert.deepEqual(judge(300, 900, 300), { outcome: 'snapped' });
    // Nothing is on the line before 1.01x; on the bite it snaps.
    assert.deepEqual(judge(500, 100, null, true), { outcome: 'open' });
    assert.deepEqual(judge(100, 100, null, true), { outcome: 'snapped' });
  });

  it('names the catch by how far the line held, and pays the multiplier, floored', () => {
    assert.equal(FISHING_LADDER[0]![0], FISHING_MIN_LAND_X100);
    for (const [, id] of FISHING_LADDER) assert.ok(FISHING_CATCHES[id], id);
    assert.equal(catchAt(101), 'cod');
    assert.equal(catchAt(149), 'cod');
    assert.equal(catchAt(150), 'tropical_fish');
    assert.equal(catchAt(999), 'diamond');
    assert.equal(catchAt(10_000), 'enchanted_golden_apple');
    assert.equal(catchAt(99_999), 'enchanted_golden_apple');
    assert.equal(payoutAt(1_000_001n, 237), 2_370_002n);
    assert.equal(maxStakeFor(50_000_000_000n), 50_000_000n);
    assert.ok(payoutAt(maxStakeFor(50_000_000_000n), FISHING_MAX_X100 - 1) <= 50_000_000_000n);
  });
});

describe('fishing: the route and the schema', () => {
  it('stakes and draws the breaking point in one transaction, and settles once', async () => {
    const route = await read('services/api-gateway/src/routes/fishing.ts');
    const start = route.slice(route.indexOf("app.post(\n    '/v1/fishing/casts',"), route.indexOf("'/v1/fishing/casts/:id/land'"));
    assert.match(start, /SELECT \*, clock_timestamp\(\) AS db_now FROM fishing_casts WHERE user_id = \$1 AND idempotency_key = \$2/);
    assert.ok(start.indexOf('await debit(') < start.indexOf('snapPoint(serverSeed, body.clientSeed, fairness.nonce)'));
    assert.match(start, /clock_timestamp\(\) \+ make_interval\(secs => \$9\)/);
    assert.match(start, /if \(judged\.row\.status === 'open'\) conflict\('CAST_IN_PLAY', 'Land the cast you are on first'\);/);
    assert.match(route, /const ceiling = maxStakeFor\(config\.fishingMaxPayoutMinor\);/);
    assert.match(route, /UPDATE fairness_seeds SET used_at = now\(\) WHERE id = \$1/);
    // Paid and recorded once, at settlement, and only from an open cast.
    const settle = route.slice(route.indexOf('async function settle('), route.indexOf('async function debit('));
    assert.match(settle, /creditWallet\(client, row\.user_id, payout, 'fishing_payout', row\.id\)/);
    assert.match(settle, /WHERE id = \$1 AND status = 'open'/);
    assert.match(settle, /recordWager\(\s*client,\s*config,\s*row\.user_id,\s*stake,\s*'fishing',\s*row\.id,/);
    assert.match(settle, /\(stake \* BigInt\(FISHING_HOUSE_EDGE_BPS\)\) \/ 10_000n/);
    assert.equal(route.split('recordWager(').length - 1, 1);
    // The breaking point never leaves the row while the cast is open.
    assert.match(route, /snapX100: settled \? row\.snap_x100 : null,/);
    assert.match(route, /serverSeed: settled \? row\.server_seed_reveal : null,/);
    // A landing is judged on the server's clock, never on a number the browser sends.
    assert.match(route, /parseWith\(z\.object\(\{\}\)\.strict\(\), request\.body \?\? \{\}\);/);
    assert.match(route, /return multiplierAt\(row\.sinker, \(row\.db_now\.getTime\(\) - row\.hooked_at\.getTime\(\)\) \/ 1000\);/);
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerFishingRoutes\(app, db, config\);/);
  });

  it('widens every source and kind list by Fishing, and keeps one open cast per player', async () => {
    const kinds = (sql: string, constraint: string) => {
      const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
      return new Set([...sql.slice(start, sql.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    };
    const migration = await read('packages/db/migrations/076_fishing.sql');
    const previous = await read('packages/db/migrations/072_slots.sql');
    for (const constraint of ['wallet_transactions_kind_check', 'wager_events_source_check', 'faction_contributions_source_check', 'referral_earnings_source_check']) {
      const before = kinds(previous, constraint);
      const after = kinds(migration, constraint);
      for (const value of before) assert.ok(after.has(value), `076 drops ${value} from ${constraint}`);
      assert.equal(after.size, before.size + (constraint === 'wallet_transactions_kind_check' ? 2 : 1));
    }
    assert.ok(kinds(migration, 'wallet_transactions_kind_check').has('fishing_stake'));
    assert.ok(kinds(migration, 'wager_events_source_check').has('fishing'));
    assert.match(migration, /UNIQUE \(fairness_seed_id\)/);
    assert.match(migration, /CREATE UNIQUE INDEX fishing_casts_one_open_idx ON fishing_casts \(user_id\) WHERE status = 'open';/);
    assert.match(migration, /landed_x100 < snap_x100 AND catch IS NOT NULL AND payout_minor = stake_minor \* landed_x100 \/ 100/);
    assert.match(migration, /snap_x100 integer NOT NULL CHECK \(snap_x100 BETWEEN 100 AND 100000\)/);
    assert.match(migration, /sinker text NOT NULL CHECK \(sinker IN \('feather', 'iron', 'anvil'\)\)/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v76\(\) RETURNS boolean/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE fishing_casts TO donut_api_runtime;/);
  });

  it('is in the feed, the day’s top wins, the lobby count, the alerts, the stats and the settings, once settled', async () => {
    const [activity, alerts, stats, settings, media, insights] = await Promise.all([
      read('services/api-gateway/src/routes/activity.ts'),
      read('services/api-gateway/src/lib/staff-alerts.ts'),
      read('services/api-gateway/src/lib/admin-stats.ts'),
      read('services/api-gateway/src/lib/runtime-settings.ts'),
      read('services/api-gateway/src/lib/media-test.ts'),
      read('services/api-gateway/src/routes/insights.ts'),
    ]);
    assert.match(activity, /FROM \(SELECT \* FROM fishing_casts WHERE status <> 'open' ORDER BY settled_at DESC LIMIT \$1\) c/);
    assert.match(activity, /WHERE u\.id = c\.user_id AND c\.status = 'landed' AND c\.settled_at >= day\.at/);
    assert.match(activity, /SELECT 'fishing', c\.user_id FROM fishing_casts c, since\n\s*WHERE c\.created_at > since\.at OR c\.settled_at > since\.at/);
    assert.match(alerts, /WHERE c\.status <> 'open' AND c\.settled_at >= now\(\) - make_interval\(mins => \$1\)/);
    assert.match(stats, /key: 'fishing', label: 'Fishing', stakes: \['fishing_stake'\], payouts: \['fishing_payout'\]/);
    for (const key of ['fishingEnabled', 'fishingMinStakeMinor', 'fishingMaxStakeMinor', 'fishingMaxPayoutMinor']) {
      assert.match(settings, new RegExp(`${key}: \\{\\n?\\s*kind: '(boolean|bigint)',\\s*group: 'fishing',`));
    }
    assert.match(media, /'POST \/v1\/fishing\/casts',\n\s*'POST \/v1\/fishing\/casts\/:id\/land',/);
    assert.match(insights, /fishing: 'Fishing',/);
    assert.match(insights, /FROM fishing_casts WHERE user_id = \$1 AND status <> 'open'/);
  });
});

describe('fishing: the page and the dive', () => {
  it('casts on the click, draws the dive from the server’s time, and loads the 3D sea as its own chunk', async () => {
    const page = await front('assets/js/fishing.js');
    // Its own download: a player without WebGL never fetches three.js or the sea.
    assert.match(page, /const \{ createPond3d \} = await import\('\.\/fishing3d\.js'\);/);
    assert.doesNotMatch(page, /^import .*fishing3d/m);
    assert.match(page, /stakeMinor: stake\.toString\(\), sinker, autoLandX100: autoX100\(\), clientSeed: clientSeed\(\), serverSeedHash: seedHash/);
    assert.match(page, /api\.post\('\/v1\/fishing\/casts', body\(\), \{ idempotencyKey: idempotencyKey\(\) \}\)/);
    // The line goes out on the click; the live figures are held until the cast is over.
    const cast = page.slice(page.indexOf('async function cast()'), page.indexOf('function begin('));
    assert.ok(cast.indexOf('holdLiveFigures()') < cast.indexOf('pond.cast()'));
    assert.ok(cast.indexOf('pond.cast()') < cast.indexOf('await send(stake)'));
    assert.match(cast, /begin\(response\.cast, response\.serverNow, sent, Date\.now\(\), release\);/);
    assert.match(cast, /if \(pond\) await pond\.slack\(\);/);
    const finish = page.slice(page.indexOf('async function finish('), page.indexOf('function present('));
    assert.ok(finish.indexOf('await pond.land(') < finish.indexOf('r.release();'));
    assert.ok(finish.indexOf('await pond.snap()') < finish.indexOf('r.release();'));
    // The dive is the server's curve, drawn from the time it gave on its clock, with the sinker it took.
    assert.match(page, /return Math\.min\(max, Math\.max\(100, Math\.floor\(100 \* Math\.exp\(growth \* seconds\) \+ 1e-9\)\)\);/);
    const lib = await read('services/api-gateway/src/lib/fishing.ts');
    assert.match(lib, /Math\.floor\(100 \* Math\.exp\(FISHING_GROWTH\[sinker\] \* seconds\) \+ 1e-9\)/);
    assert.match(page, /offset: Date\.parse\(serverNow\) - \(sent \+ received\) \/ 2,/);
    assert.match(page, /pond\?\.setSinker\(cast\.sinker\);/);
    // Reeling up is a request with nothing in it; a cut is only ever the server's word.
    assert.match(page, /api\.post\(`\/v1\/fishing\/casts\/\$\{id\}\/land`, \{\}\)/);
    assert.match(page, /api\.get\(`\/v1\/fishing\/casts\/\$\{id\}`\)/);
    // Where the line is cut is only ever read off a cast the server has settled.
    assert.ok([...page.matchAll(/(\w*)\.?snapX100/g)].every((m) => m[1] === 'cast'));
    assert.doesNotMatch(page, /Math\.random/);
    // Every catch on the ladder has its sprite (the enchanted apple the golden apple's, as the game
    // draws it), and a cut line shows the string.
    assert.match(page, /const SPRITES = \{ enchanted_golden_apple: 'golden_apple' \};/);
    for (const id of [...Object.keys(FISHING_CATCHES), 'string']) {
      const sprite = id === 'enchanted_golden_apple' ? 'golden_apple' : id;
      assert.ok(existsSync(path.join(root, `DONUTDROP FRONTEND/Donut Drop/assets/img/items/${sprite}.png`)), id);
    }
    // Every sinker the server takes is one the page offers.
    for (const sinker of FISHING_SINKERS) assert.match(page, new RegExp(`\\{ id: '${sinker}', label: `));
  });

  it('names the same depths as the sea it draws, at the same depth, and cuts with what lives there', async () => {
    const [page, lake] = await Promise.all([front('assets/js/fishing.js'), front('assets/js/fishing3d.js')]);
    const pageZones = [...page.matchAll(/\{ id: '(\w+)', name: '[^']+', fromX100: (\d+), cutter: '(\w+)' \}/g)].map((m) => [m[1], Number(m[2]), m[3]]);
    const lakeZones = [...lake.matchAll(/id: '(\w+)', fromX: ([\d.]+),/g)].map((m) => [m[1], Math.round(Number(m[2]) * 100)]);
    assert.equal(pageZones.length, 7);
    assert.deepEqual(pageZones.map(([id, from]) => [id, from]), lakeZones);
    const cutter = /export const CUTTER = \{ ([^}]+) \};/.exec(lake)![1]!;
    for (const [id, , who] of pageZones) assert.ok(cutter.includes(`${id}: '${who}'`), `${id} is cut by ${who}`);
    // 22 blocks a doubling, on both sides.
    assert.match(page, /const PER_DOUBLING = 22;/);
    assert.match(lake, /const PER_DOUBLING = 22;/);
    // Each depth's first catch is on the ladder at the depth it starts at.
    for (const [, from] of pageZones.slice(1)) assert.ok(FISHING_LADDER.some(([x]) => x === from), `a rung at ${from}`);
  });

  it('draws only the game’s own pictures, and hangs the line as the game does', async () => {
    const lake = await front('assets/js/fishing3d.js');
    const lists = [...lake.matchAll(/const (TILES|BLOCKS|ENTITY|ENV) = \[([^\]]+)\];/g)];
    assert.equal(lists.length, 4);
    const dirs = { TILES: 'block', BLOCKS: 'block', ENTITY: 'entity', ENV: 'env' } as const;
    for (const [, kind, names] of lists) {
      for (const name of (names ?? '').match(/'([a-z0-9_]+)'/g)!.map((quoted) => quoted.slice(1, -1))) {
        const file = path.join(root, 'DONUTDROP FRONTEND/Donut Drop/assets/img', dirs[kind as keyof typeof dirs], `${name}.png`);
        assert.ok(existsSync(file), `${kind} ${name}.png`);
      }
    }
    // The particles, each animation every frame of it.
    for (const [name, frames] of [['bubble_pop', 5], ['splash', 4], ['spark', 8], ['sonic_boom', 16], ['sculk_soul', 11]] as const) {
      for (let i = 0; i < frames; i += 1) {
        assert.ok(existsSync(path.join(root, `DONUTDROP FRONTEND/Donut Drop/assets/img/particle/${name}_${i}.png`)), `${name}_${i}`);
      }
    }
    for (const [, file] of lake.matchAll(/loadImage\('(assets\/img\/[^']+)'\)/g)) {
      assert.ok(existsSync(path.join(root, 'DONUTDROP FRONTEND/Donut Drop', file!)), file);
    }
    // The game's own models: Steve, his boat, the fish, squid, dolphins, guardians, a drowned, the warden.
    for (const model of [
      '{ material: steveSkin, def: PLAYER }', '{ material: skin, def: BOAT }', "kind === 'cod' ? COD : SALMON",
      '{ material, def: SQUID }', '{ material: dolphinSkin, def: DOLPHIN }', '{ material, def: GUARDIAN }', 'def: drownedModel(0.25)',
      '{ material: skin(ent.warden), def: WARDEN }',
    ]) assert.ok(lake.includes(model), model);
    assert.match(lake, /itemModel\(THREE, source\)/);
    // The bobber at half scale, the line sagging to the rod as FishingHookRenderer sags it.
    assert.match(lake, /hook\.scale\.set\(0\.5, 0\.5, 0\.5\)/);
    assert.match(lake, /\(tipWorld\.y - from\.y\) \* \(f \* f \+ f\) \* 0\.5/);
    // Nothing on the page waits on a frame that never comes.
    // Not even one the frame cap skips: the line steps before the cap can return.
    assert.match(lake, /\/\/ The cast goes on by the clock even off screen, so the page is never left waiting on it\.\n\s*stepLine\(now\);\n\s*\/\/ The tier's frame cap/);
    assert.ok(lake.indexOf('stepLine(now);') < lake.indexOf('if (now < nextFrameAt - 2) return;'));
    assert.ok(lake.indexOf('if (now < nextFrameAt - 2) return;') < lake.indexOf('if (lost ||', lake.indexOf('function frame()')));
    // Nothing is built where the lure and its line go down.
    assert.match(lake, /if \(nb >= BLOCK_CAP \|\| inShaft\(x, z\)\) return;/);
  });

  it('is a page of its own: route, view, lobby card, sidebar, feed, search and sitemap', async () => {
    const [html, app, chat, data, store, ticker, account, seo, sitemap, nginx, nudge, popups, audio] = await Promise.all([
      front('index.html'), front('assets/js/app.js'), front('assets/js/chat.js'), front('assets/js/data.js'),
      front('assets/js/store.js'), front('assets/js/ticker.js'), front('assets/js/account.js'), front('assets/js/seo.js'),
      front('sitemap.xml'), read('infra/nginx/nginx.conf'), front('assets/js/nudge.js'), front('assets/js/popups.js'),
      front('assets/js/audio-engine.js'),
    ]);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/fishing\.css" \/>/);
    assert.match(html, /<a class="lxnav" href="\/fishing" data-route="fishing" data-tip="Fishing">/);
    assert.match(html, /<a class="gcard lxcard" href="\/fishing" data-cat="casino" data-game="fishing"/);
    assert.match(html, /<section class="view" data-view="fishing" hidden>[\s\S]*?<div class="fishing" id="fishingRoot"><\/div>/);
    assert.match(html, /data-tip="Cast, and the lure dives:/);
    assert.match(app, /fishing: mountFishing,/);
    assert.match(app, /fishing: \{ name: 'Fishing', art: 'assets\/img\/items\/game-fishing\.svg' \}/);
    assert.match(chat, /\['fishing', 'Fishing'\]/);
    assert.match(data, /route: '\/fishing', name: 'Fishing', art: 'game-fishing\.svg', shipped: '2026-10-19'/);
    assert.match(store, /raw\.kind === 'fishing'/);
    assert.match(ticker, /if \(kind === 'fishing'\) return 'Fishing';/);
    assert.match(account, /fishing_stake: 'Fishing cast',\n\s*fishing_payout: 'Fishing catch',/);
    assert.match(seo, /fishing: \{\n\s*title: 'DonutLuxe Fishing — DonutSMP Fishing',/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/fishing<\/loc>/);
    for (const map of ['"DonutLuxe Fishing — DonutSMP Fishing"', '"https://donutluxe.com/fishing"']) assert.ok(nginx.includes(`/fishing ${map}`), map);
    assert.match(nginx, /\|dice\|fishing\|/);
    for (const list of [nudge, popups]) assert.match(list, /'dice', 'fishing', 'ice-fishing', 'derby', 'ore-rush'/);
    // Its icon is the game's rod, pixel for pixel, on the lobby's 16-pixel grid.
    assert.match(await front('assets/img/items/game-fishing.svg'), /viewBox="0 0 16 16" shape-rendering="crispEdges"/);
    for (const cue of ['cast', 'splash', 'thunder']) assert.ok(audio.includes(`\n  ${cue}(ctx) {`), cue);
  });

  it('dives as Crash climbs, and the sea reels up and cuts as the server says', async () => {
    const [page, lake, css] = await Promise.all([front('assets/js/fishing.js'), front('assets/js/fishing3d.js'), front('assets/css/fishing.css')]);
    // The one button: Cast, then Reel up; Space does both.
    assert.match(page, /if \(phase === 'climbing'\) void landNow\(\);\n\s*else void cast\(\);/);
    assert.match(page, /text = `Reel up · \$\{money\(Number\(\(round\.stake \* BigInt\(round\.shown\)\) \/ 100n\)\)\}`;/);
    // At its auto target the line holds still until the server says how it went.
    assert.match(page, /if \(round\.autoX100 && x100 >= round\.autoX100\) x100 = round\.autoX100;/);
    // Polling starts as the lure goes under, a few times a second, and stops when the cast is over.
    assert.match(page, /const POLL_MS = 250;/);
    assert.match(page, /pollTimer = setTimeout\(poll, Math\.max\(POLL_MS, biteIn \+ 60\)\);/);
    // A cast left open is picked up again.
    assert.match(page, /api\.get\('\/v1\/fishing\/casts\/active'\)/);
    // The HUD: the multiplier, the depth, the ladder, a depth's title, the recent casts, the splash; the graphics.
    for (const id of ['fishingMult', 'fishingDepth', 'fishingLadder', 'fishingZone', 'fishingRecent', 'fishingSplash', 'fishingGfx']) {
      assert.match(page, new RegExp(`id="${id}"`));
    }
    assert.match(css, /\.fishing__hud\[data-state="snapped"\]/);
    // The sea's side of it, none of it waiting on a frame that never comes.
    for (const name of ['setSinker(name)', 'hookAt(perfMs)', 'climb(x100, tierId)', "land(catchId, x100, kind = 'fish')", 'snap()', 'slack()']) {
      assert.ok(lake.includes(`\n    ${name} {`), name);
    }
    assert.equal(lake.split('}, 7000);').length - 1, 2);
    // What cuts the line: a drowned's grab, a guardian's beam charging, the warden's sonic boom.
    assert.match(lake, /line\.cutter = CUTTER\[zoneAt\(line\.depth\)\.id\];/);
    assert.match(lake, /\/\/ GuardianRenderer's beam colour: \(64, 32, 128\) to \(255, 223, 64\) as it charges\./);
    assert.match(lake, /sonic_boom_\$\{i\}/);
    // A great catch gets fireworks.
    assert.match(lake, /atlas\(THREE, \[0, 1, 2, 3, 4, 5, 6, 7\]\.map\(\(i\) => part\[`spark_\$\{i\}`\]\), 8, 8\)/);
  });

  it('asks of a machine only what it can do, and steps down when it cannot keep up', async () => {
    const lake = await front('assets/js/fishing3d.js');
    assert.match(lake, /import \{ BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor \} from '\.\/quality3d\.js';/);
    for (const use of ['tier.particles', 'tier.creatures', 'tier.view', 'tier.waves', 'tier.mirror', 'tier.composer', 'tier.antialias', 'frameMs(tier)', 'minFpsFor(tier)']) {
      assert.ok(lake.includes(use), use);
    }
    const q = (await import(pathToFileURL(path.join(root, 'DONUTDROP FRONTEND/Donut Drop/assets/js/quality3d.js')).href)) as {
      TIERS: Record<'low' | 'medium' | 'high', { bloom: boolean; composer: boolean; particles: number; antialias: boolean }>;
      guessTier: (gl: unknown) => string;
      createGovernor: (steps: (() => void)[], options?: { minFps?: number }) => { taken: number; frame: (elapsed: number) => void };
      chooseTier: (gl: unknown) => { name: string };
    };
    assert.equal(q.TIERS.low.bloom, false);
    assert.equal(q.TIERS.low.composer, false);
    assert.equal(q.TIERS.low.antialias, false);
    assert.ok(q.TIERS.low.particles < q.TIERS.medium.particles && q.TIERS.medium.particles < q.TIERS.high.particles);
    const gl = (name: string) => ({
      getExtension: (ext: string) => (ext === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1 } : null),
      getParameter: () => name,
      RENDERER: 2,
    });
    assert.equal(q.guessTier(gl('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')), 'low');
    assert.equal(q.guessTier(gl('Mali-G52 MC2')), 'low');
    assert.equal(q.guessTier(gl('ANGLE (Intel, Intel(R) HD Graphics 4000 Direct3D11 vs_5_0 ps_5_0)')), 'low');
    // The player's choice wins over the guess.
    const prefs = globalThis as { DonutPrefs?: unknown };
    prefs.DonutPrefs = { get: () => ({ gfx: 'low' }) };
    try {
      assert.equal(q.chooseTier(gl('ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11)')).name, 'low');
    } finally {
      delete prefs.DonutPrefs;
    }
    // Under 28 frames a second for two and a half seconds is one step down; a quick machine is left alone.
    let taken = 0;
    const governor = q.createGovernor([() => { taken += 1; }, () => { taken += 1; }]);
    for (let i = 0; i < 120; i += 1) governor.frame(1 / 60);
    assert.equal(taken, 0);
    for (let i = 0; i < 60; i += 1) governor.frame(1 / 20);
    assert.equal(taken, 1);
    // A scene held to thirty frames a second is not slow at thirty: its floor is lower.
    const held = q.createGovernor([() => { taken += 1; }], { minFps: 22 });
    for (let i = 0; i < 300; i += 1) held.frame(1 / 29);
    assert.equal(taken, 1);
  });

  it('draws the sea’s page in its own tokens, in the shared frame, with reduced motion honoured', async () => {
    const [frame, css] = await Promise.all([front('assets/css/luxe-games.css'), front('assets/css/fishing.css')]);
    assert.match(frame, /body\.lx :is\(\.crash, \.mines, \.tower, \.chicken, \.dice, \.fishing, \.icefish, \.derby, \.slots, \.plinko\) \{/);
    const rules = css.slice(css.indexOf('/* ─────────── the lake'));
    assert.ok(rules.length > 1000);
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'a raw colour outside the token block');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.fishing\[data-render="3d"\] \.fishing__flat \{ display: none; \}/);
    assert.match(css, /\.fishing__zone,\n/);
  });
});
