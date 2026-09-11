import type { DbClient } from './db.js';

export interface DepositMaintenanceResult {
  expiredDeposits: number;
  depositsManualReview: number;
}

export async function maintainDepositIntents(client: DbClient): Promise<DepositMaintenanceResult> {
  // Once a handoff was authorized, expiry is ambiguous: the bot may already
  // hold the items. Preserve the intent and route it to human reconciliation.
  const depositsManualReview = await client.query(
    `UPDATE deposit_intents AS deposit
        SET status = 'manual_review'
      WHERE deposit.status = 'pending'
        AND EXISTS (
          SELECT 1
            FROM deposit_authorization_leases AS lease
           WHERE lease.deposit_id = deposit.id
             AND (lease.expires_at <= now() OR deposit.expires_at <= now())
        )`,
  );

  // Only an intent for which no capability was ever issued can safely expire
  // without reconciliation.
  const expiredDeposits = await client.query(
    `UPDATE deposit_intents AS deposit
        SET status = 'expired'
      WHERE deposit.status = 'pending'
        AND deposit.expires_at <= now()
        AND NOT EXISTS (
          SELECT 1
            FROM deposit_authorization_leases AS lease
           WHERE lease.deposit_id = deposit.id
        )`,
  );

  return {
    expiredDeposits: expiredDeposits.rowCount ?? 0,
    depositsManualReview: depositsManualReview.rowCount ?? 0,
  };
}
