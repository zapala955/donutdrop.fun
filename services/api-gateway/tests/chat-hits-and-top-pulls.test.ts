import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

describe('win cards in chat', () => {
  it('shows one win card per player per minute, measured on the rounds themselves', async () => {
    const chat = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/chat.js');
    const drain = chat.slice(chat.indexOf('function drainBigHits()'), chat.indexOf('function resetTimestamp()'));
    assert.match(chat, /const HIT_COOLDOWN_MS = 60_000;/);
    // Oldest first, keyed by player, on each round's own time.
    assert.match(drain, /fresh\.sort\(\(a, b\) => a\.at - b\.at\)/);
    assert.match(drain, /const who = activity\.playerId \?\? activity\.player/);
    assert.match(drain, /Math\.abs\(at - last\) < HIT_COOLDOWN_MS\) continue;/);
    // A big payout that is still a loss (a 0.9x ball, a crate worth less than it cost) is no win.
    assert.match(drain, /if \(BigInt\(activity\.payoutMinor \?\? '0'\) <= BigInt\(activity\.wagerMinor \?\? '0'\)\) continue;/);
    // A held-back win is decided once, and a chat reset forgets the cooldowns with the log.
    assert.ok(drain.indexOf('seenHits.add(activity.id)') < drain.indexOf('fresh.sort('));
    assert.match(chat, /seenHits\.clear\(\);\s+lastHitAt\.clear\(\);/);
  });
});

describe('biggest wins today', () => {
  it('reads every game for the whole UTC day, winning rounds only, biggest profit first', async () => {
    const route = await read('services/api-gateway/src/routes/activity.ts');
    const top = route.slice(route.indexOf("'/v1/activity/top-today'"), route.indexOf("'/v1/activity/playing'"));
    assert.ok(top.length > 0, 'the endpoint is missing');
    assert.match(top, /WITH day AS \(SELECT date_trunc\('day', now\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC' AS at\)/);
    // Every game that pays money is in it, each kept to today and to rounds that won.
    for (const [kind, table, today, won] of [
      ['case', 'case_rounds', /r\.created_at >= day\.at/, /r\.payout_minor > r\.price_minor/],
      ['upgrade', 'upgrader_rounds', /r\.created_at >= day\.at/, /r\.payout_minor > r\.stake_value_minor/],
      ['roulette', 'roulette_bets', /r\.settled_at >= day\.at/, /HAVING sum\(COALESCE\(b\.payout_minor, '0'\)\) > sum\(b\.stake_minor\)/],
      ['blackjack', 'blackjack_hands', /h\.settled_at >= day\.at/, /h\.payout_minor > h\.stake_minor \* CASE WHEN h\.doubled THEN 2 ELSE 1 END/],
      ['crash', 'crash_bets', /b\.settled_at >= day\.at/, /b\.payout_minor > b\.stake_minor/],
      ['mines', 'mines_games', /g\.settled_at >= day\.at/, /g\.payout_minor > g\.stake_minor/],
      ['tower', 'tower_games', /g\.settled_at >= day\.at/, /g\.payout_minor > g\.stake_minor/],
      ['chicken', 'chicken_games', /g\.settled_at >= day\.at/, /g\.payout_minor > g\.stake_minor/],
      ['plinko', 'plinko_bets', /b\.created_at >= day\.at/, /b\.payout_minor > b\.stake_minor/],
      ['coinflip', 'coinflip_games', /g\.settled_at >= day\.at/, /g\.payout_minor > g\.stake_minor/],
      ['minesduel', 'mines_duel_games', /g\.settled_at >= day\.at/, /g\.payout_minor > g\.stake_minor/],
    ] as const) {
      const at = top.indexOf(`'${kind}'::text AS kind`);
      assert.ok(at > 0, `${kind} is missing`);
      const branch = top.slice(at, top.indexOf('UNION ALL', at) > 0 ? top.indexOf('UNION ALL', at) : undefined);
      assert.match(branch, new RegExp(`FROM ${table}\\b`), `${kind} reads ${table}`);
      assert.match(branch, today, `${kind} is not kept to today`);
      assert.match(branch, won, `${kind} lets a loss in`);
    }
    // A duel's winner only, and never a draw; a blackjack double counts what was risked.
    assert.match(top, /u\.id = g\.winner_user_id AND g\.status = 'settled' AND g\.outcome <> 'draw'/);
    // Biggest profit first: a big stake at 1.01x is not a big win.
    assert.match(top, /ORDER BY \(win\.payout_minor - win\.wager_minor\) DESC, win\.created_at DESC/);
    // Media test twins are left out, and the lifetime wager total never rides along.
    assert.match(top, /WHERE NOT EXISTS \(SELECT 1 FROM users d WHERE d\.id = win\.player_id AND d\.demo_of IS NOT NULL\)/);
    assert.doesNotMatch(top, /wagered_minor/);
  });

  it('paints the card from that list, every game, the profit as the figure', async () => {
    const [app, store, html] = await Promise.all([
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/app.js'),
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/store.js'),
      read('DONUTDROP FRONTEND/Donut Drop/index.html'),
    ]);
    assert.match(html, /<span>Biggest wins today<\/span>/);
    assert.doesNotMatch(html, /Biggest pulls today/);
    const paint = app.slice(app.indexOf('const paintActivity = () => {'), app.indexOf('paintActivity();'));
    assert.match(paint, /const rounds = state\.topPulls \?\? \[\];/);
    assert.doesNotMatch(paint, /state\.activities/);
    // Not only item pulls any more: a table game shows its own sprite and name.
    assert.doesNotMatch(paint, /filter\(\(entry\) => entry\.item\)/);
    assert.match(paint, /art\.src = item \? safeImage\(item\.img\) : game\.art;/);
    assert.match(paint, /amount\.textContent = `\+\$\{money\(Number\(payout - wager\)\)\}`;/);
    for (const kind of ['crash', 'mines', 'tower', 'chicken', 'plinko', 'blackjack', 'roulette', 'coinflip', 'minesduel']) {
      assert.match(app, new RegExp(`\\b${kind}: \\{ name: '`), `${kind} has no name and sprite`);
    }
    assert.match(store, /api\.get\('\/v1\/activity\/top-today\?limit=7'\)/);
    // Held like the feed while a round animates, and asked for at most every fifteen seconds.
    const refresh = store.slice(store.indexOf('export async function refreshTopPulls('));
    assert.match(refresh, /if \(liveHolds > 0\) return state\.topPulls;/);
    assert.match(store, /const TOP_PULLS_EVERY_MS = 15_000;/);
  });
});
