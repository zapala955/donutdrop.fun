import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * The Holding column read $0 beside accounts holding millions.
 *
 * `tracked_balance_minor` is what the platform BELIEVES, maintained from the receipts the bots
 * report. It is not a balance. DonutSMP's stats API used to say what an account really held; it
 * was switched off, and each bot now reads its own balance with /bal and carries the answer on its
 * heartbeat.
 */
describe('what a bot is really holding', () => {
  it('stores what /bal said on the heartbeat, with the time it was read, not the time it arrived', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const schema = route.slice(route.indexOf('const heartbeatEvent'), route.indexOf('const linkEvent'));
    // Optional: a bot that has not read its balance, or an older build, sends none.
    assert.match(schema, /balance: z\s+\.object\(\{/);
    assert.match(schema, /\.strict\(\)\s+\.optional\(\),/);
    const beat = route.slice(route.indexOf('async function processHeartbeat('), route.indexOf('async function processLinkConfirmation('));
    assert.match(beat, /observed_balance_at = LEAST\(\$5::timestamptz, now\(\)\)/);
    const migration = await read('packages/db/migrations/059_bot_balance_readings.sql');
    assert.match(migration, /ADD COLUMN observed_balance_low_minor bigint/);
    assert.match(migration, /ADD COLUMN observed_balance_step_minor bigint CHECK \(observed_balance_step_minor >= 1\)/);
  });

  it('shows the reading in the console, and says when there is none or it is old', async () => {
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    assert.doesNotMatch(admin, /DonutSmpApi|fetchMoneyMinor|donutsmp-api/);
    const route = admin.slice(admin.indexOf("'/v1/admin/bots'"));
    const handler = route.slice(0, route.indexOf('floatTargetMinor'));
    assert.match(handler, /live_balance_minor: low,/);
    assert.match(handler, /'NO_BALANCE_READING'/);
    assert.match(handler, /'BALANCE_READING_STALE'/);
  });
});

/**
 * $1,932,525 is a figure you read digit by digit. $1.93m is one you take in at a glance, and a
 * column of balances is scanned rather than transcribed.
 */
describe('compact figures in the console', () => {
  const consoleSource = () => read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js');

  it('formats with integer arithmetic, never by dividing into a float', async () => {
    const code = await consoleSource();
    const fn = code.slice(code.indexOf('function compactAmount'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // BigInt scales, and a remainder taken before any division rather than after.
    assert.match(body, /1000000000000n/);
    assert.match(body, /\(\(n % scale\) \* 100n\) \/ scale/);
    assert.doesNotMatch(body, /Number\(/, 'a Number here rounds balances past 2^53');
  });

  /* The distinction worth keeping: $1.93m is three different amounts, so it belongs in a column
   * being scanned and never on a confirmation for money about to move. */
  it('leaves the exact formatter in place for figures being acted on', async () => {
    const code = await consoleSource();
    assert.match(code, /function amountText\(minor\)/);
    // The payout confirmation still quotes the exact figure.
    assert.match(code, /confirmMoney/);
  });

  it('keeps the exact figure reachable from the compact one', async () => {
    const code = await consoleSource();
    const bots = code.slice(code.indexOf('async function loadBots'));
    const cell = bots.slice(0, bots.indexOf('const status ='));
    assert.match(cell, /compactAmount\(liveBalance\)/);
    // Exact live AND the tracked figure, both on the tooltip.
    assert.match(cell, /holding\.title =/);
    assert.match(cell, /amountText\(liveBalance\)/);
    assert.match(cell, /amountText\(bot\.tracked_balance_minor\)/);
  });
});
