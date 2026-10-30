import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import {
  DERBY_HOUSE_EDGE_BPS,
  DERBY_PICKS,
  DERBY_RACERS,
  DERBY_SPAN,
  drawRace,
  maxStakeFor,
  oddsX100,
  payoutFor,
  winnerOf,
} from '../src/lib/derby.js';

const root = path.resolve(import.meta.dirname, '../../..');
const read = async (file: string) => (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
const front = (file: string) => read(`DONUTDROP FRONTEND/Donut Drop/${file}`);

describe('mob derby: the race', () => {
  it('returns exactly 90% on every racer, counted over all 256 rolls', () => {
    assert.equal(DERBY_RACERS.reduce((sum, racer) => sum + racer.weight, 0), DERBY_SPAN);
    for (const racer of DERBY_RACERS) {
      // Over every roll 0..255, what a 100-hundredths bet on this racer pays back.
      let paid = 0n;
      for (let roll = 0; roll < DERBY_SPAN; roll += 1) paid += payoutFor(100n * 10_000n, racer.id, winnerOf(roll).id).payoutMinor;
      assert.equal(paid * 10_000n, BigInt(DERBY_SPAN) * 100n * 10_000n * BigInt(10_000 - DERBY_HOUSE_EDGE_BPS), racer.id);
    }
    assert.deepEqual(DERBY_RACERS.map((racer) => oddsX100(racer.id)), [288, 360, 480, 720, 1152, 1920]);
  });

  it('draws the winner from the HMAC’s first byte, as a player can check it', () => {
    const serverSeed = 'b'.repeat(64);
    const digest = createHmac('sha256', serverSeed).update('player:3', 'utf8').digest();
    const race = drawRace(serverSeed, 'player', 3);
    assert.equal(race.roll, digest[0]);
    assert.equal(race.winner, winnerOf(digest[0]!).id);
    assert.equal(race.trackSeed, digest.subarray(1, 17).toString('hex'));
    assert.equal(winnerOf(0).id, 'pig');
    assert.equal(winnerOf(79).id, 'pig');
    assert.equal(winnerOf(80).id, 'cow');
    assert.equal(winnerOf(255).id, 'black_sheep');
    assert.throws(() => winnerOf(256), RangeError);
  });

  it('pays only the winner, floored, and refuses a stake whose win would pass the ceiling', () => {
    assert.deepEqual(payoutFor(1_000_000n, 'pig', 'pig'), { x100: 288, payoutMinor: 2_880_000n });
    assert.deepEqual(payoutFor(1_000_000n, 'pig', 'cow'), { x100: 0, payoutMinor: 0n });
    assert.equal(payoutFor(3n, 'mooshroom', 'mooshroom').payoutMinor, 34n);
    assert.equal(maxStakeFor('black_sheep', 19_200n), 1_000n);
    assert.deepEqual([...DERBY_PICKS], DERBY_RACERS.map((racer) => racer.id));
  });
});

describe('mob derby: the route and the schema', () => {
  it('stakes, draws and pays in one transaction, from the player’s committed seed', async () => {
    const route = await read('services/api-gateway/src/routes/derby.ts');
    const start = route.slice(route.indexOf("'/v1/derby/races',\n"), route.indexOf('async function debit('));
    assert.ok(start.indexOf('await debit(') < start.indexOf('drawRace(serverSeed, body.clientSeed, fairness.nonce)'));
    assert.match(start, /creditWallet\(client, userId, won\.payoutMinor, 'derby_payout', raceId\)/);
    assert.equal(route.split('recordWager(').length - 1, 1);
    assert.match(route, /pick: z\.enum\(DERBY_PICKS\),/);
    assert.match(route, /const ceiling = maxStakeFor\(body\.pick, config\.derbyMaxPayoutMinor\);/);
  });

  it('widens every list by the derby, and ties the pay to the pick and the winner', async () => {
    const sql = await read('packages/db/migrations/078_derby.sql');
    assert.match(sql, /'ice_fishing_stake', 'ice_fishing_payout',\n\s*'derby_stake', 'derby_payout'/);
    assert.equal(sql.split("'slots', 'fishing', 'ice_fishing',\n                      'derby'));").length - 1, 3);
    assert.match(sql, /CHECK \(\(pick = winner\) = \(multiplier_x100 > 0\)\)/);
    assert.match(sql, /CHECK \(payout_minor = stake_minor \* multiplier_x100 \/ 100\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v78\(\)/);
    const [activity, stats, app, media, alerts] = await Promise.all([
      read('services/api-gateway/src/routes/activity.ts'), read('services/api-gateway/src/lib/admin-stats.ts'),
      read('services/api-gateway/src/app.ts'), read('services/api-gateway/src/lib/media-test.ts'), read('services/api-gateway/src/lib/staff-alerts.ts'),
    ]);
    assert.equal(activity.split("'derby'::text AS kind").length - 1, 2);
    assert.match(activity, /SELECT 'derby', r\.user_id FROM derby_races r, since WHERE r\.created_at > since\.at/);
    assert.match(stats, /\{ key: 'derby', label: 'Mob Derby', stakes: \['derby_stake'\], payouts: \['derby_payout'\], refunds: \[\] \}/);
    assert.match(app, /await registerDerbyRoutes\(app, db, config\);/);
    assert.match(media, /'POST \/v1\/derby\/races',/);
    assert.match(alerts, /FROM derby_races r/);
  });
});

describe('mob derby: the page and the track', () => {
  it('runs the race the server decided, the winner always first over the line', async () => {
    const page = await front('assets/js/derby.js');
    assert.match(page, /const \{ createDerby3d \} = await import\('\.\/derby3d\.js'\);/);
    assert.doesNotMatch(page, /^import .*derby3d/m);
    assert.match(page, /stakeMinor: stake\.toString\(\), pick, clientSeed: clientSeed\(\), serverSeedHash: seedHash/);
    assert.match(page, /const script = raceScript\(result\.trackSeed, winner, racers\(\)\.length\);/);
    assert.doesNotMatch(page, /Math\.random/);
    const { raceScript } = (await import(pathToFileURL(path.join(root, 'DONUTDROP FRONTEND/Donut Drop/assets/js/derbyrace.js')).href)) as {
      raceScript: (seed: string, winner: number, count?: number) => { finish: number[]; progress: (i: number, ms: number) => number; order: (ms: number) => number[]; duration: number };
    };
    for (let n = 0; n < 300; n += 1) {
      const seed = createHmac('sha256', 'track').update(String(n)).digest('hex').slice(0, 32);
      const winner = n % 6;
      const script = raceScript(seed, winner);
      assert.equal(Math.min(...script.finish), script.finish[winner]);
      assert.equal(script.order(script.duration + 400)[0], winner);
      // Nobody runs backwards, and everybody gets home.
      for (let i = 0; i < 6; i += 1) {
        let last = 0;
        for (let ms = 0; ms <= script.duration; ms += 97) {
          const p = script.progress(i, ms);
          assert.ok(p >= last - 1e-9, `racer ${i} at ${ms}`);
          last = p;
        }
        assert.ok(script.progress(i, script.finish[i]!) >= 1 - 1e-9);
      }
      // The same seed runs the same race.
      assert.deepEqual(raceScript(seed, winner).finish, script.finish);
    }
  });

  it('draws only the game’s own pictures, and builds the mobs on the game’s models', async () => {
    const [lake, models] = await Promise.all([front('assets/js/derby3d.js'), front('assets/js/mcmodels.js')]);
    const lists = [...lake.matchAll(/const (BLOCKS|ENTITY|ENV) = \[([^\]]+)\];/g)];
    assert.equal(lists.length, 3);
    const dirs = { BLOCKS: 'block', ENTITY: 'entity', ENV: 'env' } as const;
    for (const [, kind, names] of lists) {
      for (const name of (names ?? '').match(/'([a-z0-9_]+)'/g)!.map((quoted) => quoted.slice(1, -1))) {
        assert.ok(existsSync(path.join(root, 'DONUTDROP FRONTEND/Donut Drop/assets/img', dirs[kind as keyof typeof dirs], `${name}.png`)), `${kind} ${name}`);
      }
    }
    for (const name of ['heart', ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `spark_${i}`)]) {
      assert.ok(existsSync(path.join(root, `DONUTDROP FRONTEND/Donut Drop/assets/img/particle/${name}.png`)), name);
    }
    // PigModel's head and snout, CowModel's horns, SheepFurModel's swelling, ChickenModel's wattle.
    assert.match(models, /\{ u: 16, v: 16, x: -2, y: 0, z: -9, w: 4, h: 3, d: 1 \}/);
    assert.match(models, /\{ u: 22, v: 0, x: 4, y: -5, z: -5, w: 1, h: 3, d: 1 \}/);
    assert.match(models, /w: 8, h: 16, d: 6, inflate: 1\.75/);
    assert.match(models, /\{ name: 'redThing', cubes: \[\{ u: 14, v: 4, x: -1, y: -2, z: -3, w: 2, h: 2, d: 2 \}\] \}/);
    assert.match(lake, /import \{ BRIGHTNESS, chooseTier, createGovernor, frameMs, minFpsFor, ratioFor \} from '\.\/quality3d\.js';/);
    assert.match(lake, /const shadows = tier\.name !== 'low';/);
  });

  it('is a page of its own: route, view, lobby card, sidebar, feed, search and sitemap', async () => {
    const [html, app, chat, data, store, ticker, account, seo, sitemap, nginx, css] = await Promise.all([
      front('index.html'), front('assets/js/app.js'), front('assets/js/chat.js'), front('assets/js/data.js'), front('assets/js/store.js'),
      front('assets/js/ticker.js'), front('assets/js/account.js'), front('assets/js/seo.js'), front('sitemap.xml'), read('infra/nginx/nginx.conf'),
      front('assets/css/derby.css'),
    ]);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/derby\.css" \/>/);
    assert.match(html, /<a class="lxnav" href="\/derby" data-route="derby" data-tip="Mob Derby">/);
    assert.match(html, /<a class="gcard lxcard" href="\/derby" data-cat="casino" data-game="derby"/);
    assert.match(html, /<section class="view" data-view="derby" hidden>[\s\S]*?<div class="derby" id="derbyRoot"><\/div>/);
    assert.match(app, /  derby: mountDerby,/);
    assert.match(app, /derby: \{ name: 'Mob Derby', art: 'assets\/img\/items\/game-derby\.svg' \}/);
    assert.match(chat, /\['derby', 'Mob Derby'\]/);
    assert.match(data, /route: '\/derby', name: 'Mob Derby', art: 'game-derby\.svg', shipped: '2026-10-22'/);
    assert.match(store, /raw\.kind === 'derby'/);
    assert.match(ticker, /if \(kind === 'derby'\) return 'Mob Derby';/);
    assert.match(account, /derby_stake: 'Mob Derby bet',\n\s*derby_payout: 'Mob Derby win',/);
    assert.match(seo, /derby: \{\n\s*title: 'DonutLuxe Mob Derby — DonutSMP Racing',/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/derby<\/loc>/);
    assert.match(nginx, /\|ice-fishing\|derby\|/);
    assert.match(await front('assets/img/items/game-derby.svg'), /viewBox="0 0 16 16" shape-rendering="crispEdges"/);
    const rules = css.slice(css.indexOf('/* ─────────── the track'));
    assert.ok(rules.length > 1000);
    assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'a raw colour outside the token block');
    assert.match(css, /\.derby:is\(\[data-render="3d"\], \[data-render="loading"\]\) \.derby__lanes \{ display: none; \}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
