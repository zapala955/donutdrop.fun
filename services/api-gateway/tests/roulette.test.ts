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
    /* The reveal and the clearing of the pending flag happen in the same step — the result reaches
       the face when the wheel stops, not when the snapshot carrying it arrives. Asserted as "both
       are in finish()" rather than as two adjacent lines, so a null guard between them is not a
       test failure. */
    const finishBody = client.slice(
      client.indexOf('const finish = () => {'),
      client.indexOf('void refreshBalance();'),
    );
    assert.match(finishBody, /pendingResultId = null;/);
    assert.match(finishBody, /#rouletteResult/);
    assert.match(client, /\$\('#rouletteResult'[\s\S]*paintHistory\(\);\s*announceResult/);
    assert.doesNotMatch(client, /rouletteAmount|parseAmount|formatAmountInput/);
    assert.match(client, /\[100_000n, '\$100K'\]/);
    assert.match(client, /\[1_000_000_000n, '\$1B'\]/);
    assert.match(client, /void place\(selected\)/);
    assert.match(client, /if \(placing \|\| !isBettingOpen\(\)\) return/);
    assert.match(client, /spinTo\(newest\.result,[\s\S]*spinEndsAt\)/);
    assert.match(client, /Wheel spinning · bets are locked/);
    assert.match(client, /connectionFresh\(\)/);
    assert.match(client, /Reconnecting… bets are locked/);
    assert.match(client, /donut:roulette/);
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

describe('the roulette table limit', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const route = () =>
    readFile(path.join(repo, 'services/api-gateway/src/routes/roulette.ts'), 'utf8');

  it('caps what one player can have riding on a single spin', async () => {
    /* The per-chip maximum is not a limit on its own: a player can place it again, and again,
     * because every chip is a fresh request that passes the same check in isolation. This is the
     * ceiling on the sum. */
    const source = await route();
    assert.match(source, /config\.rouletteMaxRoundStakeMinor/);
    assert.match(source, /ROUND_STAKE_LIMIT/);
    assert.match(
      source,
      /SELECT coalesce\(sum\(stake_minor\), 0\)::text AS staked_minor\s*\n\s*FROM roulette_bets WHERE round_id = \$1 AND user_id = \$2/,
    );
  });

  it('serialises the sum on the player, because the chips race each other', async () => {
    /* The idempotency lock is keyed by idempotency key, so two DIFFERENT chips from one player run
     * concurrently. Two concurrent reads of a 4B total would each see room for another 1B and both
     * commit, which is how a table limit becomes a suggestion. */
    const source = await route();
    assert.match(source, /roulette-round-stake:\$\{userId\}/);
    const check = source.indexOf('roulette-round-stake');
    const sum = source.indexOf('AS staked_minor');
    assert.ok(check > 0 && sum > check, 'the lock must be taken before the sum is read');
  });

  it('refuses a round limit below the chip limit rather than picking one', async () => {
    /* Either way round an operator meant it, one of the two published figures would be a lie: a
     * first chip at the advertised maximum would be refused by a ceiling nobody was shown. */
    const config = await readFile(
      path.join(repo, 'services/api-gateway/src/config.ts'),
      'utf8',
    );
    assert.match(config, /ROULETTE_MAX_ROUND_STAKE_MINOR: positiveBigintString\.default\('5000000000'\)/);
    assert.match(
      config,
      /BigInt\(env\.ROULETTE_MAX_ROUND_STAKE_MINOR\) < BigInt\(env\.ROULETTE_MAX_STAKE_MINOR\)/,
    );
  });

  it('shows the limit before it is hit, and stops offering chips that will not fit', async () => {
    const client = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/roulette.js'),
      'utf8',
    );
    assert.match(client, /maxRoundStakeMinor/);
    assert.match(client, /function roundAllowanceMinor\(\)/);
    // A chip is offered only while it still fits, and the board goes dead at the limit.
    assert.match(client, /allowance === null \|\| value <= allowance/);
    assert.match(client, /const atLimit = allowance !== null && allowance < min;/);
  });
});

describe('the roulette client keeps itself current', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const client = () =>
    readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/roulette.js'), 'utf8');

  it('refreshes on the round’s own deadlines rather than on a blind interval', async () => {
    /* The bug this replaces: the fallback poll was raised to 15s on the assumption that live
     * events would carry the loop. A round is roundSeconds + spinSeconds — thirteen by default —
     * so one missed event left the page blind for longer than a whole round and it sat on
     * SETTLING until something else happened to fetch.
     *
     * The round publishes both of its own boundaries, so the client can ask at exactly the moment
     * the answer changes. Two timed requests per round, correct even if the stream never
     * delivers. */
    const source = await client();
    assert.match(source, /function scheduleDeadlineRefresh\(\)/);
    assert.match(source, /untilOpen > 0\s*\n?\s*\?\s*untilOpen \+ 250/);
    assert.match(source, /untilClose > 0/);
    // Re-armed on both outcomes, or the chain ends at the first blip and never recovers.
    assert.equal(
      (source.match(/scheduleDeadlineRefresh\(\);/g) ?? []).length >= 2,
      true,
      'the chain must be re-armed after a failed refresh as well as a successful one',
    );
  });

  it('never lets the blind poll be slower than a round on its own', async () => {
    /* A backstop is fine; a backstop that is the ONLY mechanism and is slower than the game is
     * not. Asserted as a relationship rather than a number so raising the poll cannot silently
     * outrun the round again. */
    const source = await client();
    const poll = Number(/const POLL_MS = [^;]*?(\d[\d_]*)\s*;/.exec(source)?.[1]?.replace(/_/g, ''));
    assert.ok(Number.isFinite(poll), 'POLL_MS must be readable');
    const config = await readFile(
      path.join(repo, 'services/api-gateway/src/config.ts'),
      'utf8',
    );
    const round = Number(/ROULETTE_ROUND_SECONDS:[^;]*?default\((\d+)\)/.exec(config)?.[1]);
    const spin = Number(/ROULETTE_SPIN_SECONDS:[^;]*?default\((\d+)\)/.exec(config)?.[1]);
    assert.ok(Number.isFinite(round) && Number.isFinite(spin));
    // Either the poll is faster than a round, or the deadline chain is there to carry it.
    assert.ok(
      poll <= (round + spin) * 1000 || /function scheduleDeadlineRefresh\(\)/.test(source),
      'a poll slower than one round needs the deadline refresh to remain correct',
    );
  });

  it('does not lock betting when only one of the two freshness sources is alive', async () => {
    /* Trusting the event stream alone meant a stream that connected and then went quiet left
     * betting locked forever on a page that was fetching perfectly well. */
    const source = await client();
    assert.match(source, /return liveFresh \|\| pollFresh;/);
    /* And the poll window has to cover the longest gap the deadline chain leaves, which is a whole
     * betting window — a fixed 4.5s locked betting part-way into every round. */
    assert.match(source, /roundSeconds \|\| 0\) \+ Number\(snapshot\?\.config\?\.spinSeconds/);
  });
});

describe('the roulette does not spoil its own spin', () => {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const client = () =>
    readFile(path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/js/roulette.js'), 'utf8');

  it('freezes the wallet figure for the length of the animation', async () => {
    /* Settlement credits winners the instant the server resolves the round, and creditWallet
     * publishes a balance invalidation as it goes. Acting on that immediately made the header
     * balance jump to its post-spin value while the wheel was still turning — a player could read
     * the result off their own wallet seconds before the ball landed. */
    const source = await client();
    assert.match(source, /function takeSpinHold\(\)/);
    assert.match(source, /spinHold = holdLiveFigures\(\);/);
    // Taken before the animation starts, released when it ends.
    const spin = source.slice(source.indexOf('function spinTo('));
    assert.ok(
      spin.indexOf('takeSpinHold()') < spin.indexOf('cubic-bezier'),
      'the hold must be taken before the transition is armed',
    );
  });

  it('releases the hold even when the page is gone by the time the timer fires', async () => {
    /* finish() runs from a timer that fires whether or not the view is still mounted. A detached
     * root makes the DOM work throw, and a hold that escaped would freeze the wallet figure for
     * the whole site until a reload — far worse than the spoiler it was taken to prevent. */
    const source = await client();
    const finish = source.slice(source.indexOf('const finish = () => {'));
    const body = finish.slice(0, finish.indexOf('\n  };'));
    assert.match(body, /\} finally \{\s*\n\s*releaseSpinHold\(\);/);
    // And a result the wheel cannot render must not strand one either.
    assert.match(source, /if \(index < 0\) \{\s*\n\s*releaseSpinHold\(\);/);
  });

  it('shows what YOU have on a spot, not only what the table has', async () => {
    const source = await client();
    const css = await readFile(
      path.join(repo, 'DONUTDROP FRONTEND/Donut Drop/assets/css/roulette.css'),
      'utf8',
    );
    assert.match(source, /function mineBySelection\(\)/);
    assert.match(source, /class = 'roulette__mine'|className = 'roulette__mine'/);
    assert.match(source, /button\.dataset\.mine = own > 0n \? '1' : '0';/);
    // The spot itself is marked too, so a covered number is findable without reading a figure.
    assert.match(css, /\.roulette__mine \{/);
    assert.match(css, /\[data-mine='1'\]/);
  });
});
