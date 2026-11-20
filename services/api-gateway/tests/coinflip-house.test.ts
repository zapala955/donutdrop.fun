import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HOUSE_FLIP_PAYOUT_BPS, houseFlip, houseFlipPayout } from '../src/lib/coinflip.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('coinflip against the house: the coin', () => {
  it('reads the first byte of HMAC(serverSeed, "client:nonce"), the reading the fairness page has', () => {
    const serverSeed = 'a'.repeat(64);
    for (let nonce = 0; nonce < 50; nonce += 1) {
      const digest = createHmac('sha256', serverSeed).update(`client:${nonce}`, 'utf8').digest();
      const flip = houseFlip(serverSeed, 'client', nonce);
      assert.equal(flip.side, digest[0]! < 128 ? 'heads' : 'tails');
      assert.equal(flip.digestHex, digest.toString('hex'));
    }
  });

  it('is an even coin over many flips', () => {
    let heads = 0;
    const flips = 40_000;
    for (let nonce = 0; nonce < flips; nonce += 1) {
      if (houseFlip('b'.repeat(64), 'even', nonce).side === 'heads') heads += 1;
    }
    assert.ok(Math.abs(heads / flips - 0.5) < 0.01, String(heads / flips));
  });

  it('pays a right call 1.8x, floored', () => {
    assert.equal(HOUSE_FLIP_PAYOUT_BPS, 18_000);
    assert.equal(houseFlipPayout(1_000_000n), 1_800_000n);
    assert.equal(houseFlipPayout(3n), 5n);
    assert.throws(() => houseFlipPayout(0n), RangeError);
  });
});

describe('coinflip against the house: the server', () => {
  it('settles in one transaction like Dice: stake, seed, coin, payout, wager', async () => {
    const route = await read('services/api-gateway/src/routes/coinflip-house.ts');
    assert.match(route, /'\/v1\/coinflip\/bets'/);
    assert.match(route, /const landed = houseFlip\(serverSeed, body\.clientSeed, fairness\.nonce\)\.side;/);
    assert.match(route, /const win = landed === body\.side;/);
    assert.match(route, /creditWallet\(client, userId, payout, 'coinflip_win', betId\)/);
    assert.match(route, /'coinflip_stake'/);
    assert.match(route, /recordWager\(\s*client,\s*config,\s*userId,\s*stake,\s*'coinflip',/);
    // Its own ceiling, never above the board's.
    assert.match(route, /config\.coinflipHouseMaxStakeMinor < config\.coinflipMaxStakeMinor/);
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerCoinflipHouseRoutes\(app, db, config\);/);
  });

  it('has its table in one migration, and is a house game for test mode', async () => {
    const sql = await read('packages/db/migrations/104_coinflip_house.sql');
    assert.match(sql, /CREATE TABLE coinflip_bets \(/);
    assert.match(sql, /CHECK \(win = \(side = result\)\)/);
    assert.match(sql, /CHECK \(win = \(payout_minor > 0\)\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v104\(\) RETURNS boolean/);
    const media = await read('services/api-gateway/src/lib/media-test.ts');
    assert.match(media, /'POST \/v1\/coinflip\/bets',/);
  });

  it('is in history, the fairness list, the feed, the insights and the staff alerts', async () => {
    for (const file of ['lib/player-rounds.ts', 'lib/fair-rounds.ts', 'routes/activity.ts', 'routes/insights.ts', 'lib/staff-alerts.ts']) {
      assert.match(await read(`services/api-gateway/src/${file}`), /coinflip_bets/, file);
    }
  });
});

describe('coinflip against the house: the page', () => {
  it('is on the menu, in the lobby, routed and framed like every table', async () => {
    const [html, app, luxe] = await Promise.all([front('index.html'), front('assets/js/app.js'), front('assets/js/luxe.js')]);
    // On the menu by its category, not a link of its own (the preview's sidebar, 2026-11-20).
    assert.match(html, /<a class="gcard lxcard" href="\/coinflip" data-cat="casino"/);
    assert.match(html, /<a class="lxnav" href="\/\?c=casino" data-cat="casino"/);
    assert.match(html, /<a class="gcard lxcard" href="\/coinflip" data-cat="casino" data-game="coinflip"/);
    assert.match(html, /<div class="cflip" id="coinflipRoot"><\/div>/);
    assert.match(app, /coinflip: mountCoinflip/);
    assert.match(luxe, /const TABLES = '[^']*\.cflip, /);
  });

  it('flips on the server, holds the pill, and has no source of chance of its own', async () => {
    const [page, css] = await Promise.all([front('assets/js/coinflip.js'), front('assets/css/coinflip.css')]);
    assert.doesNotMatch(page, /Math\.random|crypto\.getRandomValues/);
    assert.match(page, /'\/v1\/coinflip\/bets',\n\s*\{ stakeMinor: stake, side: call, clientSeed: clientSeed\(\), serverSeedHash \}/);
    assert.match(page, /if \(reduceMotion\(\) \|\| !body\.animate\) \{/);
    assert.doesNotMatch(css, /blur\(|drop-shadow|text-shadow/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    // The same stake field as every game: the full keyboard, ½ 2× Max.
    assert.match(page, /<input id="cflipStake" inputmode="text" autocapitalize="off"/);
    assert.match(page, /class="cflip__adj" data-adj="max" aria-label="Bet the most you can">Max<\/button>/);
  });
});
