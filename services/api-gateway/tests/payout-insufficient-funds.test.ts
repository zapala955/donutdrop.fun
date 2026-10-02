import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';
import { recoverRelease, type ReleaseJob } from '../src/routes/minecraft-in.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000001': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  LOG_LEVEL: 'silent',
});

const release = (attempts: number, ageHours: number): ReleaseJob => ({
  id: 'job-1',
  reference_id: 'withdrawal-1',
  attempts,
  created_at: new Date(Date.now() - ageHours * 3_600_000),
  payload: { amountMinor: '8461222', toBotId: 'teller-1' },
});

function recorder() {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DbClient;
  return { client, statements };
}

/**
 * Nearly every "unconfirmed" payout was the server answering "You don't have enough funds to do
 * this": the paying bot held less in game than it was asked to send. On 2026-09-30 one release
 * burned all five of its attempts in sixteen minutes against an empty vault and was parked, while
 * the operator saw only "PAYOUT_UNCONFIRMED" and two buttons that both said to check in game.
 */
describe('a payout the server refused for funds', () => {
  it('keeps a release waiting and tries again every five minutes, without spending attempts', async () => {
    // Even past the five attempts allowed for silence: a refusal is a known outcome, not one.
    for (const attempts of [1, 5, 40]) {
      const { client, statements } = recorder();
      await recoverRelease(client, config, release(attempts, 1), 'vault-1', 'PAYOUT_INSUFFICIENT_FUNDS');
      const requeue = statements.find(({ sql }) => sql.includes("SET status = 'queued'"));
      assert.ok(requeue, `attempt ${attempts} was not queued again`);
      assert.match(requeue.sql, /attempts = GREATEST\(attempts - 1, 0\)/);
      assert.deepEqual(requeue.values, ['job-1', 300, 'PAYOUT_INSUFFICIENT_FUNDS']);
      assert.ok(!statements.some(({ sql }) => sql.includes("'dead_letter'")));
      // The withdrawal keeps waiting, and says why.
      const marked = statements.find(({ sql }) => sql.includes('UPDATE cash_withdrawals'));
      assert.ok(marked);
      assert.doesNotMatch(marked.sql, /manual_review/);
      assert.match(marked.sql, /WHERE id = \$1 AND status = 'awaiting_vault'/);
      assert.deepEqual(marked.values, ['withdrawal-1', 'PAYOUT_INSUFFICIENT_FUNDS']);
    }
  });

  it('waits in the queue however long the vault is short, never parking or refunding', async () => {
    // A day and a half short: still waiting its turn, not in front of an operator.
    const { client, statements } = recorder();
    await recoverRelease(client, config, release(3, 36), 'vault-1', 'PAYOUT_INSUFFICIENT_FUNDS');
    assert.ok(statements.some(({ sql }) => sql.includes("SET status = 'queued'")));
    assert.ok(
      !statements.some(({ sql }) => sql.includes("'dead_letter'") || sql.includes("'manual_review'")),
    );
  });

  it("never settles a refused release from another release's receipt", async () => {
    /* The receipt search matches on amount alone. A refusal says this attempt moved nothing, so
     * looking would only let a same-sized release's money mark this one done. */
    const { client, statements } = recorder();
    await recoverRelease(client, config, release(1, 1), 'vault-1', 'PAYOUT_INSUFFICIENT_FUNDS');
    assert.ok(!statements.some(({ sql }) => sql.includes('FROM cash_payment_receipts')));
  });

  it('keeps a player payout in the queue while the teller is short, with no refund', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const result = route.slice(route.indexOf('async function processJobResult('));
    const branch = result.slice(
      result.indexOf("if (job.kind === 'cash_payout' && event.errorCode === PAYOUT_INSUFFICIENT_FUNDS)"),
      result.indexOf('const terminal = !event.retryable'),
    );
    assert.ok(branch.length > 0, 'a payout refused for funds falls through to the generic dead-letter');
    assert.match(branch, /await requeueForFunds\(client, job\.id\);/);
    assert.match(branch, /SET status = 'queued', error_code = \$2/);
    assert.doesNotMatch(branch, /refundWithdrawal|dead_letter|withinFundsWindow/);
    // A payout that lands later is marked paid without the stale reason.
    assert.match(route, /SET status = 'paid', paid_at = now\(\), error_code = NULL/);
    const withdrawals = await read('services/api-gateway/src/routes/cash-withdrawals.ts');
    assert.match(withdrawals, /SET status = 'queued', vault_released_at = now\(\), error_code = NULL/);
  });

  it('tells the operator which bot is short, and counts withdrawals stuck on the vault', async () => {
    const admin = await read('services/api-gateway/src/routes/admin-operations.ts');
    const overview = admin.slice(admin.indexOf("app.get('/v1/admin/overview'"), admin.indexOf("app.get('/v1/admin/economy'"));
    assert.match(overview, /WHERE j\.last_error_code = 'PAYOUT_INSUFFICIENT_FUNDS'/);
    assert.match(overview, /shortBots: short\.rows/);
    assert.match(overview, /status = 'awaiting_vault' AND updated_at < now\(\) - interval '1 hour'/);
    const retry = admin.slice(admin.indexOf("app.post('/v1/admin/jobs/:id/retry'"));
    assert.match(retry.slice(0, 2500), /'PAYOUT_INSUFFICIENT_FUNDS'/);
    const console = await read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(console, /PAYOUT_INSUFFICIENT_FUNDS:\s+'Bot did not have the money in game/);
    assert.match(console, /is out of money in game/);
    assert.doesNotMatch(console, /refunded to their wallets/);
  });

  it('serves the queue in arrival order, and wakes it the moment money lands', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const claim = route.slice(route.indexOf('SELECT id, kind, reference_id, payload FROM bot_jobs'));
    const predicate = claim.slice(0, claim.indexOf('ORDER BY'));
    // No newer money job on a bot while an older one there is waiting for funds.
    assert.match(predicate, /NOT \(bot_jobs\.kind = ANY\(\$3::text\[\]\) AND EXISTS \(/);
    assert.match(predicate, /ahead\.bot_id = bot_jobs\.bot_id AND ahead\.status = 'queued'/);
    assert.match(predicate, /ahead\.last_error_code = \$4/);
    assert.match(predicate, /\(ahead\.created_at, ahead\.id\) < \(bot_jobs\.created_at, bot_jobs\.id\)/);
    assert.match(claim.slice(0, 2500), /\[\.\.\.MONEY_JOB_KINDS\], PAYOUT_INSUFFICIENT_FUNDS\]/);
    assert.match(route, /MONEY_JOB_KINDS = \['cash_payout', 'admin_payout', 'vault_sweep', 'vault_release'\]/);
    // Every receipt on a bot, ours or a player's, wakes what is waiting on it.
    const receipts = route.slice(route.indexOf('async function processCashPaymentObserved('));
    const body = receipts.slice(0, receipts.indexOf('\n}\n'));
    assert.equal(body.split('await wakeFundsQueue(client, event.botId);').length - 1, 2);
  });

  it('shows each player their place in the queue', async () => {
    const withdrawals = await read('services/api-gateway/src/routes/cash-withdrawals.ts');
    assert.match(withdrawals, /async function queuePositionOf\(/);
    assert.match(withdrawals, /\(created_at, id\) < \(\$2, \$3\)/);
    assert.match(withdrawals, /return \{ withdrawal: view\(row, await queuePositionOf\(db, row\)\) \};/);
    const page = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/app.js');
    assert.match(page, /in the queue/);
  });
});
