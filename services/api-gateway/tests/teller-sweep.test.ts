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
    /* Measured on what the teller holds FREE of the payouts it still owes; see
     * teller-sweep-owed.test.ts for why, and for the sweep run against today's figures. */
    assert.ok(fn.includes('if (free < config.tellerSweepThresholdMinor) return;'));
    // And then empties down to the float, rather than to the threshold.
    assert.ok(fn.includes('const excess = free - config.tellerFloatTargetMinor;'));
  });

  it('defaults the threshold to $50M and keeps it runtime-manageable', async () => {
    const config = await read('services/api-gateway/src/config.ts');
    assert.ok(config.includes("TELLER_SWEEP_THRESHOLD_MINOR: nonNegativeBigintString.default('50000000')"));
    const settings = await read('services/api-gateway/src/lib/runtime-settings.ts');
    assert.ok(settings.includes('tellerSweepThresholdMinor'));
  });

  /* DonutSMP switched its stats API off. The teller's real balance is now what its own /bal last
   * read, kept on its row by the heartbeat -- and only a reading taken after the last money booked
   * on the bot, or "correcting" by it would book that movement twice. */
  it("sweeps from the bot's own /bal, and only from a fresh reading newer than every booked movement", async () => {
    const code = await sweeper();
    assert.doesNotMatch(code, /DonutSmpApi|fetchMoneyMinor/);
    assert.match(code, /const reading = await trustedReading\(client, teller\.id\);/);
    const trusted = code.slice(code.indexOf('export async function trustedReading('));
    assert.match(trusted, /b\.observed_balance_at > now\(\) - \(\$2::integer \* interval '1 millisecond'\) AS fresh/);
    assert.match(trusted, /\(SELECT max\(t\.created_at\) FROM bot_transfers t WHERE t\.bot_id = b\.id\)/);
    assert.match(trusted, /FROM bot_accounts b WHERE b\.id = \$1 FOR UPDATE/);
    assert.match(trusted, /if \(!bot\.fresh \|\| !bot\.after_last_movement\) return undefined;/);
  });

  /* "1.97M" is a band a hundred thousand wide. Inside it the tracked figure is as right as the
   * reading can say; outside it, the floor is the one value the reading guarantees -- and the
   * sweep is sized from the floor, so it never asks the teller for money it may not hold. */
  it('reads an abbreviated balance as a band, corrects only outside it, and sweeps from its floor', async () => {
    const code = await sweeper();
    assert.match(code, /const fits = tracked >= low && tracked < low \+ step;/);
    assert.match(code, /correctedTo: fits \? tracked : low,/);
    assert.match(code, /\{ id: teller\.id, username: teller\.username \},\s+reading\.low,/);
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
