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

  it('puts a release in front of an operator once the vault has been short for six hours', async () => {
    const { client, statements } = recorder();
    await recoverRelease(client, config, release(3, 7), 'vault-1', 'PAYOUT_INSUFFICIENT_FUNDS');
    assert.ok(statements.some(({ sql }) => sql.includes("SET status = 'dead_letter'")));
    const parked = statements.find(({ sql }) => sql.includes("status = 'manual_review'"));
    assert.deepEqual(parked?.values, ['withdrawal-1', 'PAYOUT_INSUFFICIENT_FUNDS']);
  });

  it('retries a player payout while the teller is short, and refunds it once the window closes', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const result = route.slice(route.indexOf('async function processJobResult('));
    const branch = result.slice(
      result.indexOf("if (job.kind === 'cash_payout' && event.errorCode === PAYOUT_INSUFFICIENT_FUNDS)"),
      result.indexOf('const terminal = !event.retryable'),
    );
    assert.ok(branch.length > 0, 'a payout refused for funds falls through to the generic dead-letter');
    assert.match(branch, /if \(withinFundsWindow\(job\.created_at\)\) \{\s+await requeueForFunds\(client, job\.id\);/);
    assert.match(branch, /refundWithdrawal\(client, job\.reference_id, PAYOUT_INSUFFICIENT_FUNDS\)/);
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
  });
});
