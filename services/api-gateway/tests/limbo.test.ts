import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  LIMBO_HOUSE_EDGE_BPS,
  LIMBO_MAX_RESULT_X100,
  LIMBO_MIN_TARGET_X100,
  drawBits,
  limboChancePpm,
  limboResult,
  limboWins,
  maxStakeAt,
  payoutAt,
} from '../src/lib/limbo.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('limbo: the draw', () => {
  it('is the first 52 bits of the HMAC, turned into a multiplier with integers only, and reproducible', () => {
    const serverSeed = 'a'.repeat(64);
    const digest = createHmac('sha256', serverSeed).update('client:7', 'utf8').digest();
    const n = BigInt(digest.readUIntBE(0, 6)) * 16n + BigInt(digest[6]! >> 4);
    assert.equal(drawBits(serverSeed, 'client', 7), n);
    const expected = (90n * 2n ** 52n) / (2n ** 52n - n);
    assert.equal(limboResult(serverSeed, 'client', 7), Number(expected > 100_000_000n ? 100_000_000n : expected));
    assert.equal(limboResult(serverSeed, 'client', 7), limboResult(serverSeed, 'client', 7));
  });

  it('starts at 0.90x and is capped', () => {
    for (let nonce = 0; nonce < 2_000; nonce += 1) {
      const result = limboResult('b'.repeat(64), 'seed', nonce);
      assert.ok(result >= 90 && result <= LIMBO_MAX_RESULT_X100, String(result));
    }
  });

  it('wins a target exactly 90% / T of the time, over many draws', () => {
    /* A Monte Carlo check of the edge, with a tolerance a correct draw clears easily: at 2.00x the
     * win rate is 45%, at 10x 9%. */
    const draws = 40_000;
    for (const [target, expect] of [[200, 0.45], [1_000, 0.09], [110, 90 / 110]] as const) {
      let wins = 0;
      for (let nonce = 0; nonce < draws; nonce += 1) {
        if (limboWins(target, limboResult('c'.repeat(64), `edge-${target}`, nonce))) wins += 1;
      }
      const rate = wins / draws;
      assert.ok(Math.abs(rate - expect) < 0.012, `target ${target}: ${rate} vs ${expect}`);
    }
    assert.equal(LIMBO_HOUSE_EDGE_BPS, 1000);
    assert.equal(limboChancePpm(200), 450_000);
  });
});

describe('limbo: the bet', () => {
  it('pays the stake times the target, floored, and refuses a target under 1.01x', () => {
    assert.equal(payoutAt(1_000_000n, 200), 2_000_000n);
    assert.equal(payoutAt(3n, 150), 4n);
    assert.equal(LIMBO_MIN_TARGET_X100, 101);
    assert.throws(() => limboChancePpm(100), RangeError);
    // A win is a draw that reached the target.
    assert.equal(limboWins(200, 200), true);
    assert.equal(limboWins(200, 199), false);
  });

  it('caps the stake so a win never pays past the ceiling', () => {
    assert.equal(maxStakeAt(1_000, 50_000_000_000n), 5_000_000_000n);
    assert.ok(payoutAt(maxStakeAt(1_000, 50_000_000_000n), 1_000) <= 50_000_000_000n);
  });

  it('settles in one transaction like Dice: stake, seed, draw, payout, wager', async () => {
    const route = await read('services/api-gateway/src/routes/limbo.ts');
    assert.match(route, /'\/v1\/limbo\/bets'/);
    assert.match(route, /const result = limboResult\(serverSeed, body\.clientSeed, fairness\.nonce\);/);
    assert.match(route, /creditWallet\(client, userId, payout, 'limbo_payout', betId\)/);
    assert.match(route, /'limbo_stake'/);
    assert.match(route, /recordWager\(\s*client,\s*config,\s*userId,\s*stake,\s*'limbo',/);
    assert.match(route, /STAKE_OVER_PAYOUT_LIMIT/);
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerLimboRoutes\(app, db, config\);/);
  });

  it('has its table, ledger kinds and wager source in one migration', async () => {
    const sql = await read('packages/db/migrations/090_limbo.sql');
    assert.match(sql, /CREATE TABLE limbo_bets \(/);
    assert.match(sql, /CHECK \(win = \(result_x100 >= target_x100\)\)/);
    assert.match(sql, /'limbo_stake', 'limbo_payout'/);
    assert.equal((sql.match(/'derby', 'limbo'\)\);/g) ?? []).length, 3);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v90\(\) RETURNS boolean/);
  });
});

describe('limbo: the page', () => {
  it('is on the menu, in the lobby, routed and mounted', async () => {
    const [html, app, data, nginx, sitemap] = await Promise.all([
      front('index.html'), front('assets/js/app.js'), front('assets/js/data.js'),
      read('infra/nginx/nginx.conf'), front('sitemap.xml'),
    ]);
    assert.match(html, /<a class="lxnav" href="\/limbo" data-route="limbo"/);
    assert.match(html, /<a class="gcard lxcard" href="\/limbo" data-cat="casino" data-game="limbo"/);
    assert.match(html, /<section class="view" data-view="limbo" hidden>/);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/limbo\.css" \/>/);
    assert.match(app, /limbo: mountLimbo/);
    assert.match(data, /route: '\/limbo', name: 'Limbo', art: 'game-limbo\.svg'/);
    assert.match(nginx, /\|dice\|limbo\|/);
    assert.match(sitemap, /<loc>https:\/\/donutluxe\.com\/limbo<\/loc>/);
  });

  it('looks like the rest of the floor: flat, a number that climbs, its own sounds, no source of chance', async () => {
    const [page, css, audio] = await Promise.all([
      front('assets/js/limbo.js'), front('assets/css/limbo.css'), front('assets/js/audio-engine.js'),
    ]);
    assert.doesNotMatch(page, /Math\.random|crypto\.getRandomValues/);
    assert.match(page, /node\.textContent = times\(Math\.round\(100 \* Math\.exp\(span \* eased\)\)\);/);
    assert.match(page, /if \(reduceMotion\(\) \|\| !node\.animate\) \{/);
    for (const cue of ['limboRise', 'limboWin', 'limboBig', 'limboLose']) {
      assert.match(audio, new RegExp(`\\n  ${cue}\\(ctx\\) \\{`), cue);
      assert.ok(page.includes(`'${cue}'`), `limbo.js plays ${cue}`);
    }
    assert.doesNotMatch(css, /blur\(|drop-shadow|text-shadow/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    // The same stake field as every game: the full keyboard, ½ 2× Max.
    assert.match(page, /<input id="limboStake" inputmode="text" autocapitalize="off"/);
    assert.match(page, /class="limbo__adj" data-adj="max" aria-label="Bet the most you can">Max<\/button>/);
  });
});
