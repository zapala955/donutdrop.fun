import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { queueVaultSweep } from '../src/lib/bots.js';
import type { AppConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';

/* A sweep never takes money the teller already owes.
 *
 * 2026-10-09, 17:01: the vault released $85.8M to the teller for a withdrawal; one second later a
 * sweep, sized against the teller's whole balance, sent $86.8M back. The payout behind the release
 * was refused for funds, and because the payout queue is first come first served, every payout
 * queued on the teller after it stopped too. These run the real queueVaultSweep against a client
 * that answers its queries from a small in-memory picture of the two bots. */

const VAULT_ID = '40987551-3f5e-43f1-ab82-b3c4a4b86139';
const TELLER = { id: 'db57bad1-0000-4000-8000-000000000001', username: 'wymiar' };
const M = 1_000_000n;

const config = {
  botCredentials: new Map([[VAULT_ID, { username: 'n3utr4lizer' }]]),
  tellerSweepThresholdMinor: 50n * M,
  tellerFloatTargetMinor: 1n * M,
} as unknown as AppConfig;

/** A client holding the teller's open payout jobs; records any sweep it is asked to insert. */
function fakeClient(owedJobs: bigint[], tracked = 0n) {
  const sweeps: { amountMinor: string; payee: string; toBotId: string }[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("role = 'vault'")) {
        return {
          rowCount: 1,
          rows: [{ id: VAULT_ID, username: 'n3utr4lizer', server_host: 'donutsmp.net', tracked_balance_minor: '0' }],
        };
      }
      if (sql.includes("kind = 'vault_sweep'") && sql.includes('SELECT 1')) return { rowCount: 0, rows: [] };
      if (sql.includes('AS owed')) {
        // The query sums cash_payout and admin_payout jobs that are queued or leased.
        assert.match(sql, /kind IN \('cash_payout', 'admin_payout'\)/);
        assert.match(sql, /status IN \('queued', 'leased'\)/);
        const owed = owedJobs.reduce((sum, amount) => sum + amount, 0n);
        return { rowCount: 1, rows: [{ owed: owed.toString() }] };
      }
      if (sql.includes('SELECT tracked_balance_minor')) {
        return { rowCount: 1, rows: [{ tracked_balance_minor: tracked.toString() }] };
      }
      if (sql.includes('INSERT INTO bot_jobs')) {
        sweeps.push(JSON.parse(String(params[3])));
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
  return { client: client as unknown as DbClient, sweeps };
}

describe('sweeping the teller while it owes payouts', () => {
  it('replays 17:01:43: the money just released for a payout is not swept back', async () => {
    // $14.3M of its own, plus the $85.8M release; owing the $85.8M payout and two small ones.
    const held = 14_305_952n + 85_799_859n;
    const { client, sweeps } = fakeClient([85_800_000n, 2_833_065n, 5_245_000n]);
    await queueVaultSweep(client, config, TELLER, held);
    assert.deepEqual(sweeps, [], 'a sweep took money the teller was about to pay out');
  });

  it('still sweeps a real surplus, sized after what is owed', async () => {
    const held = 200n * M;
    const { client, sweeps } = fakeClient([85_800_000n]);
    await queueVaultSweep(client, config, TELLER, held);
    const [sweep] = sweeps;
    assert.ok(sweep && sweeps.length === 1, 'expected exactly one sweep');
    // 200M held - 85.8M owed - 1M float.
    assert.equal(sweep.amountMinor, (200n * M - 85_800_000n - M).toString());
    assert.equal(sweep.payee, 'n3utr4lizer');
    assert.equal(sweep.toBotId, VAULT_ID);
  });

  it('behaves exactly as before when nothing is owed', async () => {
    const { client, sweeps } = fakeClient([]);
    await queueVaultSweep(client, config, TELLER, 60n * M);
    const [sweep] = sweeps;
    assert.ok(sweep && sweeps.length === 1, 'expected exactly one sweep');
    assert.equal(sweep.amountMinor, (59n * M).toString());
  });

  it('uses the tracked figure, less what is owed, when no reading is passed', async () => {
    const { client, sweeps } = fakeClient([30n * M], 70n * M);
    await queueVaultSweep(client, config, TELLER);
    // 70M tracked - 30M owed = 40M free, under the 50M threshold: nothing moves.
    assert.deepEqual(sweeps, []);
  });
});
