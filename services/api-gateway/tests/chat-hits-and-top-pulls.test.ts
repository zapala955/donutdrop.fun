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

describe('biggest pulls today', () => {
  it('reads the whole UTC day from the server, winning pulls only, biggest first', async () => {
    const route = await read('services/api-gateway/src/routes/activity.ts');
    const top = route.slice(route.indexOf("'/v1/activity/top-today'"));
    assert.ok(top.length > 0, 'the endpoint is missing');
    assert.equal(top.match(/r\.created_at >= date_trunc\('day', now\(\) AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC'/g)?.length, 2);
    assert.match(top, /r\.payout_minor > r\.price_minor/);
    assert.match(top, /r\.outcome = 'win'\s+AND r\.payout_minor > r\.stake_value_minor/);
    assert.match(top, /ORDER BY pull\.payout_minor DESC, pull\.created_at DESC/);
    // The lifetime wager total never rides along on this list.
    assert.doesNotMatch(top, /wagered_minor/);
  });

  it('paints the card from that list, not from the minutes-wide live feed', async () => {
    const [app, store] = await Promise.all([
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/app.js'),
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/store.js'),
    ]);
    const paint = app.slice(app.indexOf('const paintActivity = () => {'), app.indexOf('paintActivity();'));
    assert.match(paint, /const rounds = \(state\.topPulls \?\? \[\]\)/);
    assert.doesNotMatch(paint, /state\.activities/);
    assert.match(store, /api\.get\('\/v1\/activity\/top-today\?limit=7'\)/);
    // Held like the feed while a round animates, and asked for at most every fifteen seconds.
    const refresh = store.slice(store.indexOf('export async function refreshTopPulls('));
    assert.match(refresh, /if \(liveHolds > 0\) return state\.topPulls;/);
    assert.match(store, /const TOP_PULLS_EVERY_MS = 15_000;/);
  });
});
