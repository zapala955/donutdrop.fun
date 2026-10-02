import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * Every way a cash withdrawal could pay a player twice -- or take their money and never pay --
 * found by the audit of 2026-10-02. None had happened (each of the 74 withdrawals so far has
 * exactly one debit, and a refund only where nothing was paid); these keep it that way.
 */
describe('cash withdrawals cannot pay twice or strand a player', () => {
  it('records a payout the server confirmed even when the bot is degraded right now', async () => {
    /* The bot reports `completed` only after the server's own "You paid" receipt. Refusing it
     * because the bot's heartbeat was stale -- its first one after a reconnect reads `degraded` --
     * parked a paid withdrawal where "Confirm not paid & refund" paid it again. */
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const completion = route.slice(route.indexOf('const safeBot ='));
    assert.match(completion.slice(0, 200), /cashOnly\s+\? \{ rowCount: 1 \}/);
    // Item custody still needs the bot's state: there it IS the evidence.
    assert.match(completion.slice(0, 900), /reconciliation_status = 'matched'/);
  });

  it('records a confirmed payout that reports after its lease ran out, by the token it was issued', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const result = route.slice(route.indexOf('async function processJobResult('));
    const late = result.slice(0, result.indexOf('if (!job || !validLease) {'));
    assert.match(late, /tokenMatches &&\s+event\.outcome === 'completed' &&\s+job\.kind === 'cash_payout'/);
    assert.match(late, /job\.status === 'dead_letter' && job\.last_error_code === 'LEASE_EXPIRED'/);
    assert.match(late, /await acceptConfirmedPayout\(client, job, event\.botId\);/);
    const accept = route.slice(route.indexOf('async function acceptConfirmedPayout('));
    const body = accept.slice(0, accept.indexOf('async function processJobResult('));
    // Only from a state that still owes the player: never over a refund or a rejection.
    assert.match(
      body,
      /status IN \('queued', 'processing'\)\s+OR \(status = 'manual_review' AND error_code IN \('LEASE_EXPIRED', 'INVALID_JOB_LEASE'\)\)/,
    );
    assert.doesNotMatch(body, /'failed'|'rejected'|refundWithdrawal/);
    // The lease token survives expiry, which is what makes the late report checkable at all.
    const expiry = route.slice(
      route.indexOf("UPDATE bot_jobs SET status = 'dead_letter', last_error_code = 'LEASE_EXPIRED'"),
    );
    assert.doesNotMatch(expiry.slice(0, 160), /lease_token_hash = NULL/);
  });

  it('never kills a money job on quarantine or lease sweep, leaving its withdrawal stranded', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const quarantine = route.slice(route.indexOf('async function quarantineBotAndJobs('));
    assert.match(quarantine.slice(0, 1600), /AND NOT \(kind = ANY\(\$3::text\[\]\)\)/);
    assert.match(quarantine.slice(0, 1600), /\[botId, errorCode, \[\.\.\.MONEY_JOB_KINDS\]\]/);
    const discord = await read('services/api-gateway/src/routes/discord-control.ts');
    assert.match(discord, /AND kind NOT IN \('cash_payout', 'admin_payout', 'vault_sweep', 'vault_release'\)/);
    const maintenance = await read('services/api-gateway/scripts/maintenance.ts');
    assert.match(maintenance, /AND kind NOT IN \('admin_payout', 'vault_sweep', 'vault_release'\)/);
    // A player payout it does expire goes to a human together with its withdrawal, not into limbo.
    assert.match(
      maintenance,
      /UPDATE cash_withdrawals AS cash\s+SET status = 'manual_review', error_code = 'LEASE_EXPIRED'/,
    );
    assert.match(maintenance, /WHERE expired\.kind = 'cash_payout'/);
  });

  it('allows one open withdrawal per player, whatever stage it is at', async () => {
    const migration = await read('packages/db/migrations/053_one_open_withdrawal.sql');
    assert.match(migration, /DROP INDEX cash_withdrawals_one_live_idx;/);
    assert.match(
      migration,
      /CREATE UNIQUE INDEX cash_withdrawals_one_live_idx\s+ON cash_withdrawals \(user_id\)\s+WHERE status IN \('pending_approval', 'queued', 'processing', 'awaiting_vault', 'manual_review'\);/,
    );
    const withdrawals = await read('services/api-gateway/src/routes/cash-withdrawals.ts');
    assert.match(
      withdrawals,
      /const OPEN_STATUSES = \['pending_approval', 'queued', 'processing', 'awaiting_vault', 'manual_review'\];/,
    );
    assert.match(withdrawals, /live\.rows\.find\(\(row\) => OPEN_STATUSES\.includes\(row\.status\)\)/);
  });

  it('debits once, refunds at most once, and refunds automatically only what never left', async () => {
    const withdrawals = await read('services/api-gateway/src/routes/cash-withdrawals.ts');
    // The debit and the withdrawal are one transaction, guarded against an overdraft.
    assert.match(withdrawals, /WHERE user_id = \$1 AND balance_minor >= \$2/);
    // The refund's guard is in the UPDATE, so two callers cannot both refund.
    const refund = withdrawals.slice(withdrawals.indexOf('export async function refundWithdrawal('));
    assert.match(
      refund.slice(0, 900),
      /SET status = 'failed', error_code = \$2, updated_at = now\(\)\s+WHERE id = \$1 AND status IN/,
    );
    // The one automatic refund: the command never reached the server.
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const automatic = route.match(/refundWithdrawal\(client, [^)]*\)/g) ?? [];
    assert.deepEqual(automatic, ["refundWithdrawal(client, job.reference_id, 'PAYOUT_NOT_SENT')"]);
    // The admin's refund button says when a refund could pay twice.
    const console = await read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(console, /STOP: this payout may already have reached the player/);
  });
});
