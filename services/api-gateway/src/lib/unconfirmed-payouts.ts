import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import { refundWithdrawal } from '../routes/cash-withdrawals.js';
import { appendAudit } from './audit.js';
import { recordBotTransfer } from './bots.js';
import type { DbClient } from './db.js';
import { noticeSoon } from './notifications.js';

/**
 * Settling a payout the server never answered, from the teller's own balance.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * When DonutSMP restarts the region the teller is on, a /pay can go out and get no reply at all.
 * The withdrawal then waits in manual_review for an operator, who has to work out from the bot's
 * balance whether the money left. On 2026-10-28 that happened five times in two hours, every one
 * of them unpaid, and each was settled by hand from the next /bal -- which is all this does.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE EVIDENCE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The unanswered payout is not in the books. So once the teller reads /bal again, after every
 * movement the platform has booked since:
 *   - the reading equals the books        -> the money never left: refund the player;
 *   - the reading is the books less it     -> it was paid: book it and mark it paid.
 * Anything else -- a reading that is abbreviated, two unanswered payouts at once, or a residual
 * that fits neither -- is left for an operator exactly as before.
 *
 * Small money nobody booked arrives all the time (a few hundred dollars paid while the bot was
 * offline), so each outcome is matched within a tolerance: a quarter of the payout, capped at
 * $100,000. The two outcomes are a whole payout apart, so the windows can never overlap.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE SWEEPER MUST WAIT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The teller sweeper corrects the books to /bal every minute. Run first, it would book a paid
 * payout's absence as an adjustment, the books would then match the reading, and the payout
 * would look unpaid and be refunded: the player paid twice. So while a payout's outcome is
 * still open, the sweeper does not correct anything (see startTellerSweeper).
 */

/** How long an unanswered payout keeps the books uncorrected while its evidence is awaited. */
export const UNCONFIRMED_EVIDENCE_WINDOW_MINUTES = 30;
const TOLERANCE_CAP_MINOR = 100_000n;

export type PayoutVerdict = 'paid' | 'not_paid' | 'unclear';

/** Reads the outcome of one unanswered payout off a /bal taken after it. */
export function judgeUnconfirmedPayout(input: {
  readonly tracked: bigint;
  readonly readingLow: bigint;
  readonly readingStep: bigint;
  readonly amount: bigint;
}): PayoutVerdict {
  // An abbreviated reading ("1.2B") is too coarse to tell a payout apart from rounding.
  if (input.readingStep !== 1n || input.amount <= 0n) return 'unclear';
  const quarter = input.amount / 4n;
  const tolerance = quarter < TOLERANCE_CAP_MINOR ? quarter : TOLERANCE_CAP_MINOR;
  const residual = input.readingLow - input.tracked;
  const distance = (value: bigint): bigint => (value < 0n ? -value : value);
  if (distance(residual) <= tolerance) return 'not_paid';
  if (distance(residual + input.amount) <= tolerance) return 'paid';
  return 'unclear';
}

export interface UnconfirmedPayout {
  readonly withdrawalId: string;
  readonly jobId: string | null;
  readonly payee: string;
  readonly amount: bigint;
  /** Whether the bot's latest /bal was taken after the payout went unanswered. */
  readonly readingAfter: boolean;
}

/**
 * The bot's payouts that went unanswered recently and are still open. Read inside the sweeper's
 * transaction, which already holds the bot row.
 */
export async function openUnconfirmedPayouts(
  client: DbClient,
  botId: string,
): Promise<UnconfirmedPayout[]> {
  const rows = await client.query<{
    id: string;
    job_id: string | null;
    payee_username: string;
    amount_minor: string;
    reading_after: boolean | null;
  }>(
    `SELECT w.id, w.payee_username, w.amount_minor,
            b.observed_balance_at > w.updated_at AS reading_after,
            (SELECT j.id FROM bot_jobs j
              WHERE j.kind = 'cash_payout' AND j.reference_id = w.id
              ORDER BY j.created_at DESC LIMIT 1) AS job_id
       FROM cash_withdrawals w
       JOIN bot_accounts b ON b.id = w.bot_id
      WHERE w.bot_id = $1 AND w.status = 'manual_review' AND w.error_code = 'PAYOUT_UNCONFIRMED'
        AND w.updated_at > now() - make_interval(mins => $2::integer)`,
    [botId, UNCONFIRMED_EVIDENCE_WINDOW_MINUTES],
  );
  return rows.rows.map((row) => ({
    withdrawalId: row.id,
    jobId: row.job_id,
    payee: row.payee_username,
    amount: BigInt(row.amount_minor),
    readingAfter: row.reading_after === true,
  }));
}

/**
 * Applies a verdict, in its own transaction: the withdrawal row first, then the wallet or the bot,
 * the same order the operator's resolve button takes. Does nothing if an operator got there first.
 */
export async function settleUnconfirmedPayout(
  client: DbClient,
  config: AppConfig,
  log: FastifyBaseLogger,
  botId: string,
  payout: UnconfirmedPayout,
  verdict: 'paid' | 'not_paid',
  evidence: { readonly readingLow: bigint; readonly tracked: bigint },
): Promise<void> {
  const locked = await client.query<{ status: string; error_code: string | null }>(
    'SELECT status, error_code FROM cash_withdrawals WHERE id = $1 FOR UPDATE',
    [payout.withdrawalId],
  );
  const row = locked.rows[0];
  if (!row || row.status !== 'manual_review' || row.error_code !== 'PAYOUT_UNCONFIRMED') return;

  if (verdict === 'paid') {
    const paid = await client.query<{ user_id: string }>(
      `UPDATE cash_withdrawals SET status = 'paid', paid_at = now(), error_code = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING user_id`,
      [payout.withdrawalId],
    );
    for (const user of paid.rows) noticeSoon(user.user_id);
    // The leg the confirmation would have booked, keyed the same way (see bookPayoutLeg).
    await recordBotTransfer(client, {
      botId,
      direction: 'out',
      counterparty: payout.payee,
      amountMinor: payout.amount,
      reason: 'withdrawal',
      referenceId: payout.jobId ?? payout.withdrawalId,
    });
  } else {
    await refundWithdrawal(client, payout.withdrawalId, 'BALANCE_SHOWS_NOT_PAID');
  }
  await client.query(
    `UPDATE bot_jobs SET status = 'completed', lease_token_hash = NULL,
            lease_expires_at = NULL, updated_at = now()
      WHERE kind = 'cash_payout' AND reference_id = $1 AND status = 'dead_letter'`,
    [payout.withdrawalId],
  );
  await appendAudit(client, config, {
    actorUserId: null,
    action: `cash_withdrawal.auto_resolve.${verdict}`,
    targetType: 'cash_withdrawal',
    targetId: payout.withdrawalId,
    details: {
      amountMinor: payout.amount.toString(),
      balanceReadMinor: evidence.readingLow.toString(),
      booksMinor: evidence.tracked.toString(),
    },
  });
  log.info(
    { withdrawalId: payout.withdrawalId, payee: payout.payee, verdict },
    'Unanswered payout settled from the bot balance',
  );
}
