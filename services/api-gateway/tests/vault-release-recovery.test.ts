import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';
import {
  displayedAmountCovers,
  recoverRelease,
  type ReleaseJob,
} from '../src/routes/minecraft-in.js';

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

const release = (attempts: number): ReleaseJob => ({
  id: 'job-1',
  reference_id: 'withdrawal-1',
  attempts,
  created_at: new Date('2026-09-24T15:23:00Z'),
  payload: { amountMinor: '75000000', toBotId: 'teller-1' },
});

/** A database that has seen no receipt from the vault, and records everything asked of it. */
function silentTeller() {
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
 * Two players waited a day for money sitting in the vault. The vault's /pay to the teller went
 * unconfirmed, the release was dead-lettered, and the withdrawal behind it stayed `awaiting_vault`
 * -- a state that appears on no attention list -- with nothing that would ever try again.
 */
describe('a vault release whose outcome is unknown', () => {
  it('matches the abbreviated amounts DonutSMP actually shows', () => {
    // The server truncates: 86,999,159 arrived as "86.9M" and 2,577,727 as "2.5M".
    assert.ok(displayedAmountCovers('86.9M', 86_999_159n));
    assert.ok(displayedAmountCovers('2.5M', 2_577_727n));
    assert.ok(displayedAmountCovers('75M', 75_000_000n));
    assert.ok(displayedAmountCovers('740', 740n));
    assert.ok(!displayedAmountCovers('86.9M', 87_000_000n));
    assert.ok(!displayedAmountCovers('86.9M', 86_899_999n));
    assert.ok(!displayedAmountCovers('75M', 76_000_000n));
    assert.ok(!displayedAmountCovers('nonsense', 1n));
  });

  it('sends it again later when the teller has not seen the money, backing off', async () => {
    for (const [attempts, delay] of [[1, 30], [2, 120], [3, 270], [4, 480]] as const) {
      const { client, statements } = silentTeller();
      await recoverRelease(client, config, release(attempts), 'vault-1', 'PAYOUT_UNCONFIRMED');
      const requeue = statements.find(({ sql }) => sql.includes("SET status = 'queued'"));
      assert.ok(requeue, `attempt ${attempts} was not queued again`);
      assert.deepEqual(requeue.values, ['job-1', delay, 'PAYOUT_UNCONFIRMED']);
      // The player's withdrawal keeps waiting on it rather than being parked.
      assert.ok(!statements.some(({ sql }) => sql.includes('UPDATE cash_withdrawals')));
    }
  });

  it('stops after the last attempt and puts the withdrawal in front of an operator', async () => {
    const { client, statements } = silentTeller();
    await recoverRelease(client, config, release(5), 'vault-1', 'PAYOUT_UNCONFIRMED');
    assert.ok(statements.some(({ sql }) => sql.includes("SET status = 'dead_letter'")));
    const parked = statements.find(({ sql }) => sql.includes('UPDATE cash_withdrawals'));
    assert.ok(parked, 'the withdrawal was left awaiting a release that will never come');
    assert.match(parked.sql, /status = 'manual_review'/);
    assert.match(parked.sql, /status = 'awaiting_vault'/);
    assert.deepEqual(parked.values, ['withdrawal-1', 'PAYOUT_UNCONFIRMED']);
  });

  it('checks for the money having landed before sending it again', async () => {
    const { client, statements } = silentTeller();
    await recoverRelease(client, config, release(1), 'vault-1', 'PAYOUT_UNCONFIRMED');
    const receipts = statements.findIndex(({ sql }) => sql.includes('FROM cash_payment_receipts'));
    const requeue = statements.findIndex(({ sql }) => sql.includes("SET status = 'queued'"));
    assert.ok(receipts >= 0 && receipts < requeue);
    // Only receipts from after the job existed, and none already used to settle another release.
    assert.match(statements[receipts]?.sql ?? '', /r\.created_at >= \$3/);
    assert.match(statements[receipts]?.sql ?? '', /settledByReceipt/);
  });

  it('is wired into every way a release can fail, and into the teller seeing the money', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    // A failed result, whatever the bot called it, before the generic dead-letter logic.
    const result = route.slice(route.indexOf('async function processJobResult('));
    const hook = result.indexOf("if (job.kind === 'vault_release') {\n    await recoverRelease(");
    const generic = result.indexOf('const terminal = !event.retryable');
    assert.ok(hook > 0 && hook < generic, 'a failed release still falls through to dead-letter');
    // A lease that ran out, which used to leave cash withdrawals behind dead jobs too.
    const claim = route.slice(route.indexOf("last_error_code = 'LEASE_EXPIRED'"));
    assert.match(claim.slice(0, 2500), /recoverRelease\(client, config, release, body\.botId, 'LEASE_EXPIRED'\)/);
    assert.match(claim.slice(0, 2500), /UPDATE cash_withdrawals SET status = 'manual_review', error_code = 'LEASE_EXPIRED'/);
    // The teller's receipt settles a release the vault never saw confirmed.
    const receipt = route.slice(route.indexOf("VALUES ($1, $2, $3, $4, $5, $6, NULL, 'internal_transfer', NULL, NULL)"));
    assert.match(receipt.slice(0, 900), /await settleReleaseFromReceipt\(/);
  });

  it('can be retried by an operator, but only while the player is still unpaid', async () => {
    const admin = await read('services/api-gateway/src/routes/admin-operations.ts');
    const retry = admin.slice(admin.indexOf("app.post('/v1/admin/jobs/:id/retry'"));
    const body = retry.slice(0, retry.indexOf('appendAudit'));
    assert.match(body, /kind = 'vault_release' AND EXISTS/);
    assert.match(body, /w\.status = 'awaiting_vault'/);
    // A withdrawal already paid, refunded or rejected cannot have its release sent again.
    assert.doesNotMatch(body, /'paid'|'refunded'|'rejected'/);
  });
});
