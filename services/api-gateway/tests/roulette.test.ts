import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ROULETTE_ORDER,
  rouletteColor,
  roulettePayout,
  roulettePayoutBps,
  rouletteResult,
  rouletteWins,
  type RouletteSelection,
} from '../src/lib/roulette.js';

describe('shared roulette rules', () => {
  it('uses every European pocket exactly once and the standard colors', () => {
    assert.equal(ROULETTE_ORDER.length, 37);
    assert.equal(new Set(ROULETTE_ORDER).size, 37);
    assert.deepEqual(
      [...ROULETTE_ORDER].sort((a, b) => a - b),
      Array.from({ length: 37 }, (_, index) => index),
    );
    assert.equal(rouletteColor(0), 'green');
    assert.equal(rouletteColor(1), 'red');
    assert.equal(rouletteColor(2), 'black');
    assert.equal(rouletteColor(36), 'red');
  });

  it('gives every supported market the configured ten-percent expected edge', () => {
    const selections: RouletteSelection[] = [
      'straight:17',
      'dozen:2',
      'red',
      'black',
      'odd',
      'even',
      'low',
      'high',
    ];
    for (const selection of selections) {
      const wins = Array.from({ length: 37 }, (_, result) => result).filter((result) =>
        rouletteWins(selection, result),
      ).length;
      const payoutBps = roulettePayoutBps(selection, 1_000);
      const returnRate = (wins / 37) * (payoutBps / 10_000);
      assert.ok(Math.abs(returnRate - 0.9) < 0.0001, `${selection} return rate was ${returnRate}`);
    }
    assert.equal(roulettePayoutBps('straight:0', 1_000), 333_000);
    assert.equal(roulettePayoutBps('dozen:1', 1_000), 27_750);
    assert.equal(roulettePayoutBps('red', 1_000), 18_500);
  });

  it('settles zero and outside bets correctly and returns the stake inside the multiplier', () => {
    assert.equal(rouletteWins('straight:0', 0), true);
    for (const selection of ['red', 'black', 'odd', 'even', 'low', 'high', 'dozen:1'] as const) {
      assert.equal(rouletteWins(selection, 0), false, `${selection} should lose on zero`);
    }
    assert.equal(rouletteWins('red', 19), true);
    assert.equal(rouletteWins('black', 20), true);
    assert.equal(rouletteWins('even', 36), true);
    assert.equal(rouletteWins('dozen:3', 25), true);
    assert.equal(roulettePayout(1_000_000n, 'red', 19, 18_500), 1_850_000n);
    assert.equal(roulettePayout(1_000_000n, 'red', 20, 18_500), 0n);
  });

  it('derives the same deterministic result and digest from the committed seed and round id', () => {
    const seed = 'ab'.repeat(32);
    const round = '10000000-0000-4000-8000-000000000001';
    assert.deepEqual(rouletteResult(seed, round), rouletteResult(seed, round));
    assert.match(rouletteResult(seed, round).digest, /^[a-f0-9]{64}$/);
    assert.ok(rouletteResult(seed, round).result >= 0 && rouletteResult(seed, round).result <= 36);
  });
});

describe('roulette persistence and client contract', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');

  it('stores exactly one shared open round and makes settlement ledger-backed', async () => {
    const sql = await readFile(
      path.join(repo, 'packages/db/migrations/039_shared_roulette.sql'),
      'utf8',
    );
    assert.match(sql, /CREATE UNIQUE INDEX roulette_one_open_round_idx/);
    assert.match(sql, /WHERE status = 'open'/);
    assert.match(sql, /UNIQUE \(user_id, idempotency_key\)/);
    assert.match(sql, /'roulette_stake', 'roulette_win'/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v39\(\)/);
    assert.match(sql, /CHECK \(closes_at > opens_at\)/);
  });

  it('keeps the browser synchronized to server timestamps and contains no outcome RNG', async () => {
    const client = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/roulette.js'),
      'utf8',
    );
    const html = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/index.html'),
      'utf8',
    );
    const nginx = await readFile(path.join(repo, 'infra/nginx/nginx.conf'), 'utf8');
    assert.doesNotMatch(client, /Math\.random|crypto\.getRandomValues/);
    assert.match(client, /api\.get\('\/v1\/roulette'\)/);
    assert.match(client, /Date\.parse\(next\.serverTime\)/);
    assert.match(client, /Date\.parse\(next\.round\?\.opensAt/);
    assert.match(client, /Date\.parse\(snapshot\?\.round\?\.closesAt/);
    assert.match(client, /api\.post\(\s*'\/v1\/roulette\/bets'/);
    assert.match(client, /if \(shouldSpin\) pendingResultId = newest\.id/);
    assert.match(client, /filter\(\(round\) => round\.id !== pendingResultId\)/);
    assert.match(client, /pendingResultId = null;\s*\$\('#rouletteResult'/);
    assert.match(client, /\$\('#rouletteResult'[\s\S]*paintHistory\(\);\s*announceResult/);
    assert.doesNotMatch(client, /rouletteAmount|parseAmount|formatAmountInput/);
    assert.match(client, /\[100_000n, '\$100K'\]/);
    assert.match(client, /\[1_000_000_000n, '\$1B'\]/);
    assert.match(client, /void place\(selected\)/);
    assert.match(client, /if \(placing \|\| !isBettingOpen\(\)\) return/);
    assert.match(client, /spinTo\(newest\.result,[\s\S]*next\.round\.opensAt\)/);
    assert.match(client, /Wheel spinning · bets are locked/);
    assert.doesNotMatch(client, /<span>DONUT<\/span>/);
    assert.match(html, /href="\/roulette" data-route="roulette"/);
    assert.match(html, /data-view="roulette"/);
    assert.match(nginx, /\|roulette\|/);
  });

  it('schedules the full betting countdown after the shared spin and locks early bets', async () => {
    const route = await readFile(
      path.join(repo, 'services/api-gateway/src/routes/roulette.ts'),
      'utf8',
    );
    assert.match(route, /opens_at, closes_at/);
    assert.match(route, /make_interval\(secs => \$4::double precision\)/);
    assert.match(route, /make_interval\(secs => \$4::double precision \+ \$5::double precision\)/);
    assert.match(route, /createRound\(client, config, config\.rouletteSpinSeconds\)/);
    assert.match(route, /round\.opens_at\.getTime\(\) > Date\.now\(\)/);
    assert.match(route, /ROUND_SPINNING/);
  });

  it('returns a bounded live bet table with masked names and opaque avatar ids', async () => {
    const route = await readFile(
      path.join(repo, 'services/api-gateway/src/routes/roulette.ts'),
      'utf8',
    );
    const client = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/roulette.js'),
      'utf8',
    );
    assert.match(route, /maskedName\('u\.minecraft_username'\)/);
    assert.match(route, /u\.id AS player_id/);
    assert.match(route, /WHERE b\.round_id = \$1[\s\S]*LIMIT 100/);
    assert.match(route, /publicBets: publicBets\.rows\.map/);
    assert.match(client, /tableAvatar\(bet\.playerId\)/);
    assert.match(client, /bet\.isViewer \? 'You' : bet\.player/);
  });

  it('publishes one recognizable activity card per player and settled roulette round', async () => {
    const activity = await readFile(
      path.join(repo, 'services/api-gateway/src/routes/activity.ts'),
      'utf8',
    );
    const ticker = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/ticker.js'),
      'utf8',
    );
    const store = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/store.js'),
      'utf8',
    );
    const chat = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/chat.js'),
      'utf8',
    );
    assert.match(activity, /FROM roulette_bets b/);
    assert.match(activity, /'roulette'::text AS kind/);
    assert.match(activity, /r\.status = 'settled'/);
    assert.match(activity, /sum\(b\.stake_minor\)::bigint AS wager_minor/);
    assert.match(activity, /sum\(COALESCE\(b\.payout_minor, '0'\)\)::bigint AS payout_minor/);
    assert.match(activity, /count\(\*\)::integer AS quantity/);
    assert.match(activity, /GROUP BY r\.id, r\.settled_at, r\.result, u\.id/);
    assert.match(ticker, /kind === 'roulette'/);
    assert.match(ticker, /return 'Roulette'/);
    assert.match(store, /rouletteResult: isRoulette/);
    assert.match(store, /item:\s*isFaction \|\| isRoulette\s*\? null/);
    assert.match(chat, /msg__badge--roulette/);
    assert.match(chat, /flexwin__roulette/);
    assert.match(chat, /Roulette · \$\{count\}/);
  });
});
