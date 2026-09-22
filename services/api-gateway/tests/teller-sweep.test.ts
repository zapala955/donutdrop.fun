import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * A vault release sat queued and due while the vault polled past it every two seconds.
 *
 * The claim query only offers a job to a bot that is `item_capable` -- a matched reconciliation, a
 * fresh snapshot, the transfer flag -- unless the kind is on a short allow-list. `vault_sweep` and
 * `vault_release` were not on it, and physical item transfer is switched off on every deployment
 * this runs on, so those two kinds were invisible forever. The withdrawal behind the release
 * waited with nothing logged at either end: the bot saw an empty queue, the job saw no claimant.
 *
 * The comment directly above that query already warns about precisely this failure for payouts.
 * The completion path was taught about the new kinds; the path that HANDS THEM OUT was not.
 */
describe('a bot-to-bot job can actually be claimed', () => {
  it('offers both internal kinds to any live bot, not only an item-capable one', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const claim = route.slice(route.indexOf("app.post('/internal/v1/minecraft/jobs/claim'"));
    const query = claim.slice(claim.indexOf('SELECT id, kind, reference_id, payload FROM bot_jobs'));
    const predicate = query.slice(0, query.indexOf('ORDER BY'));
    for (const kind of ['cash_payout', 'admin_payout', 'reconnect', 'vault_sweep', 'vault_release']) {
      assert.ok(predicate.includes(`'${kind}'`), `${kind} is not claimable by a live bot`);
    }
  });

  /* The two sides have to agree. A kind that can be claimed but not completed dead-letters after
   * its lease expires, which is a slower version of the same bug. */
  it('agrees with the completion path about which kinds never touch an inventory', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const completion = route.slice(route.indexOf('const cashOnly ='));
    const body = completion.slice(0, completion.indexOf(';'));
    assert.ok(body.includes("job.kind === 'vault_sweep'"));
    assert.ok(body.includes("job.kind === 'vault_release'"));
  });
});

/**
 * The teller is emptied on a threshold, and against its REAL balance.
 *
 * `tracked_balance_minor` counts only what has moved through the platform since the ledger began,
 * so on an account that already held money it reads zero beside a real balance of over a billion.
 * A sweep sized against it moves nothing.
 */
describe('emptying the teller into the vault', () => {
  const sweeper = () => read('services/api-gateway/src/lib/teller-sweeper.ts');

  it('does nothing until the teller is holding the threshold', async () => {
    const bots = await read('services/api-gateway/src/lib/bots.ts');
    const fn = bots.slice(bots.indexOf('export async function queueVaultSweep'));
    assert.ok(fn.includes('if (held < config.tellerSweepThresholdMinor) return;'));
    // And then empties down to the float, rather than to the threshold.
    assert.ok(fn.includes('const excess = held - config.tellerFloatTargetMinor;'));
  });

  it('defaults the threshold to $50M and keeps it runtime-manageable', async () => {
    const config = await read('services/api-gateway/src/config.ts');
    assert.ok(config.includes("TELLER_SWEEP_THRESHOLD_MINOR: nonNegativeBigintString.default('50000000')"));
    const settings = await read('services/api-gateway/src/lib/runtime-settings.ts');
    assert.ok(settings.includes('tellerSweepThresholdMinor'));
  });

  /* The whole reason this is a timer. An eight-second HTTP call inside the transaction that
   * credits a deposit would hold row locks across a network round trip on the hottest path here. */
  it('reads the balance outside any transaction, and sweeps inside one', async () => {
    const code = await sweeper();
    const fetchAt = code.indexOf('await donutsmp.fetchMoneyMinor');
    const transactionAt = code.indexOf('await db.transaction(async (client)');
    assert.ok(fetchAt > 0 && transactionAt > fetchAt, 'the stats call happens inside a transaction');
  });

  it('converts hundredths to whole dollars before comparing against anything', async () => {
    const code = await sweeper();
    assert.ok(code.includes('hundredths / MONEY_MINOR_SCALE'));
  });

  /* A corrected balance that left no trace is a figure nobody can explain afterwards, and this
   * one moves on its own without an operator ever touching it. */
  it('books drift as an adjustment rather than overwriting the tracked figure', async () => {
    const code = await sweeper();
    assert.ok(code.includes("reason: 'adjustment'"));
    assert.ok(!code.includes('SET tracked_balance_minor ='), 'the sweeper overwrites the balance');
  });

  /* A stats API that is rate-limiting or briefly down is ordinary. The next tick retries, and
   * nothing about the platform is broken meanwhile. */
  it('survives a stats API that will not answer', async () => {
    const code = await sweeper();
    assert.ok(code.includes('log.warn('), 'a failed sweep check is logged as an error, not a warning');
    assert.ok(code.includes('finally'), 'the running flag is not released on failure');
    assert.ok(code.includes('timer.unref()'), 'the timer keeps the process alive');
  });
});
