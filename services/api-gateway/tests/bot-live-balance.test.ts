import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MONEY_MINOR_SCALE, parseMoneyToMinor } from '../src/lib/donutsmp-api.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * The Holding column read $0 beside accounts holding millions.
 *
 * `tracked_balance_minor` is what the platform BELIEVES, maintained from the receipts the bots
 * report, and it starts at zero on a float that has only just been switched on. It is not a
 * balance. DonutSMP's own stats endpoint is the only thing that can say what an account actually
 * holds, and until now nothing called it — the client existed and had no consumers at all.
 */
describe('what a bot is really holding', () => {
  /* The trap in this wiring, and the reason the conversion is asserted rather than eyeballed:
   * DonutSMP reports HUNDREDTHS, and every figure in this platform's ledger is a whole dollar.
   * Getting this backwards once paid a $930 login nonce out as $93,000. */
  it('converts DonutSMP hundredths into the whole dollars the rest of the console uses', () => {
    assert.equal(MONEY_MINOR_SCALE, 100n);
    // "1975372.25" is a real shape from that API: money is a float64 rendered as a string.
    const hundredths = parseMoneyToMinor('1975372.25');
    assert.equal(hundredths, 197_537_225n);
    assert.equal(hundredths! / MONEY_MINOR_SCALE, 1_975_372n);
  });

  it('divides by the scale where it reads the balance', async () => {
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const route = admin.slice(admin.indexOf("'/v1/admin/bots'"));
    const handler = route.slice(0, route.indexOf('floatTargetMinor'));
    assert.match(handler, /hundredths \/ MONEY_MINOR_SCALE/);
  });

  /* An operator still needs to quarantine a bot while DonutSMP is down, so a stats API that is
   * slow, rate-limited or simply not configured must not take the table with it. */
  it('degrades to a reason instead of failing the whole endpoint', async () => {
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const route = admin.slice(admin.indexOf("'/v1/admin/bots'"));
    const handler = route.slice(0, route.indexOf('floatTargetMinor'));
    assert.match(handler, /catch \(error\)/);
    assert.match(handler, /live_balance_error/);
    assert.match(handler, /DONUTSMP_API_UNCONFIGURED/);
    // In parallel: two bots must not cost two round trips end to end.
    assert.match(handler, /Promise\.all\(/);
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
