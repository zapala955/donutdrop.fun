import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { findVaultBot, pickBot } from '../lib/bots.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { isDepositEligible, type DepositEligibilityState } from '../lib/eligibility.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Cash withdrawals — the bot pays a player with DonutSMP's own `/pay`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE WALLET IS DEBITED BEFORE THE BOT IS ASKED TO PAY
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Not after, and not at the same time. Between the request and the payout there is a queue, a
 * lease and a round trip to a Minecraft server, and for all of that time a balance that still
 * shows the money is a balance the player can stake. The second stake is the one the house funds.
 *
 * The cost of debiting first is that a payout which provably never happened has to be refunded,
 * which is what `refundWithdrawal` is for. That is a much smaller problem than the alternative,
 * and it only fires where the bot reports it never sent the command at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ONE LIVE PAYOUT PER PLAYER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Enforced by `cash_withdrawals_one_live_idx`, not by checking first. Two requests racing each
 * other both debit and both try to insert; exactly one wins, and the loser's transaction rolls
 * back and takes its debit with it. A check-then-insert would let both through under load.
 */

/** Below this, a payout is not worth a command to the server. */
const MIN_WITHDRAWAL_MINOR = 10_000n;

/**
 * Over this, a human approves it before the bot is told anything.
 *
 * The gate is on the amount rather than on the player, because the thing worth catching is a
 * single large outflow, however it came to be — a real cash-out, a bug, or an account that just
 * acquired a balance it should not have.
 */
const APPROVAL_THRESHOLD_MINOR = 500_000_000n;
/**
 * A completed or failed request cannot be immediately followed by another payout request.
 *
 * This is deliberately derived from cash_withdrawals, not stored as account state. Deposits and
 * gameplay have their own eligibility paths and must remain available during this minute.
 */
export const WITHDRAWAL_COOLDOWN_SECONDS = 60;

const requestSchema = z.object({ amountMinor: z.string().regex(/^[1-9]\d{0,18}$/) }).strict();
const idSchema = z.object({ id: z.uuid() }).strict();

interface WithdrawalRow {
  id: string;
  amount_minor: string;
  payee_username: string;
  status: string;
  error_code: string | null;
  created_at: Date;
  paid_at: Date | null;
  cooldown_seconds?: number;
}

function view(row: WithdrawalRow) {
  return {
    id: row.id,
    amountMinor: row.amount_minor,
    payeeUsername: row.payee_username,
    status: row.status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

/**
 * Returns a debited payout's money.
 *
 * Exported because the bot-event path needs it too: a job that dead-letters without the command
 * ever reaching the server is the one case where the money is provably still ours.
 */
export async function refundWithdrawal(
  client: DbClient,
  withdrawalId: string,
  errorCode: string,
): Promise<void> {
  /* The guard is in the UPDATE, not in a prior SELECT. Refunding is the one operation here that
   * creates money, so it has to be impossible to run twice even if two callers race. */
  const closed = await client.query<{ user_id: string; amount_minor: string }>(
    `UPDATE cash_withdrawals
        SET status = 'failed', error_code = $2, updated_at = now()
      WHERE id = $1 AND status IN ('pending_approval', 'queued', 'processing', 'manual_review')
      RETURNING user_id, amount_minor`,
    [withdrawalId, errorCode],
  );
  const row = closed.rows[0];
  if (!row) return;

  const credited = await client.query<{ balance_minor: string }>(
    `UPDATE user_wallets SET balance_minor = balance_minor + $2, updated_at = now()
      WHERE user_id = $1 RETURNING balance_minor`,
    [row.user_id, row.amount_minor],
  );
  const balanceAfter = credited.rows[0]?.balance_minor;
  if (balanceAfter === undefined) throw new Error('Withdrawal refund returned no balance');

  await client.query(
    `INSERT INTO wallet_transactions
       (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
     VALUES ($1, $2, $3, $4, 'cash_withdrawal_refund', $5)`,
    [randomUUID(), row.user_id, row.amount_minor, balanceAfter, withdrawalId],
  );
}

/**
 * Sends an approved payout on its way, out of whichever pocket can cover it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ONE HOP OR TWO
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * If the teller already holds enough, it pays the player directly and the vault is never
 * involved -- that is what the float is for. If it does not, the vault is asked for enough to
 * cover the payout AND to put the teller back on its float, and the payout itself is queued only
 * once that first transfer confirms.
 *
 * A deployment with no vault provisioned takes the direct path unconditionally, which is exactly
 * what this function did before there were two bots.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE VAULT DOES NOT HAVE TO BE ONLINE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The release is queued whatever the vault is currently doing. A job row waits in `bot_jobs`
 * until the vault reconnects and claims it, so a vault that is down delays a withdrawal instead
 * of failing it. The player's balance is already debited by this point; turning that into a
 * refusal would be a second movement of their money that nobody asked for.
 */
export async function queueWithdrawalJob(
  client: DbClient,
  config: AppConfig,
  withdrawal: { id: string; bot_id: string; payee_username: string; amount_minor: string },
): Promise<void> {
  const amount = BigInt(withdrawal.amount_minor);
  const vault = await findVaultBot(client, config);

  const payPlayerDirectly = async (availableIn = 0) => {
    await client.query(
      `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload, available_at)
       VALUES ($1, $2, 'cash_payout', $3, $4, now() + ($5::integer * interval '1 second'))
       ON CONFLICT (kind, reference_id) DO NOTHING`,
      [
        randomUUID(),
        withdrawal.bot_id,
        withdrawal.id,
        JSON.stringify({
          withdrawalId: withdrawal.id,
          payee: withdrawal.payee_username,
          amountMinor: withdrawal.amount_minor,
        }),
        availableIn,
      ],
    );
  };

  // Single-bot deployment: nothing to route through, so this is the old behaviour unchanged.
  if (!vault) {
    await payPlayerDirectly();
    return;
  }

  /* The teller's row is locked before its balance is read, because two withdrawals deciding at
   * the same instant that the float covers them would both take the direct path and the second
   * would find the money gone. */
  const teller = await client.query<{ tracked_balance_minor: string; username: string }>(
    'SELECT tracked_balance_minor, username FROM bot_accounts WHERE id = $1 FOR UPDATE',
    [withdrawal.bot_id],
  );
  const held = BigInt(teller.rows[0]?.tracked_balance_minor ?? '0');

  if (held >= amount) {
    await client.query(
      "UPDATE cash_withdrawals SET funding = 'float', updated_at = now() WHERE id = $1",
      [withdrawal.id],
    );
    await payPlayerDirectly();
    return;
  }

  /* Enough to pay the player and leave the teller sitting on its float afterwards, so a run of
   * withdrawals does not mean a trip to the vault for every one of them. With the float at zero
   * this is exactly the payout amount, and every withdrawal is a strict pass-through. */
  const release = amount + config.tellerFloatTargetMinor - held;
  await client.query(
    `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload)
     VALUES ($1, $2, 'vault_release', $3, $4)
     ON CONFLICT (kind, reference_id) DO NOTHING`,
    [
      randomUUID(),
      vault.id,
      withdrawal.id,
      JSON.stringify({
        withdrawalId: withdrawal.id,
        payee: teller.rows[0]?.username ?? '',
        amountMinor: release.toString(),
        toBotId: withdrawal.bot_id,
      }),
    ],
  );
  await client.query(
    `UPDATE cash_withdrawals SET status = 'awaiting_vault', funding = 'vault', updated_at = now()
      WHERE id = $1 AND status IN ('queued', 'pending_approval')`,
    [withdrawal.id],
  );
}

/**
 * Queues the player-facing hop of a two-hop withdrawal, once the vault's transfer has confirmed.
 *
 * Delayed by `withdrawalHopDelaySeconds`. The two transfers are otherwise adjacent in the
 * server's own public chat log, where the pairing -- an unknown account paying the teller, the
 * teller immediately paying a player the same amount -- is exactly what the split was meant to
 * hide.
 */
export async function queueWithdrawalPayoutAfterRelease(
  client: DbClient,
  config: AppConfig,
  withdrawalId: string,
): Promise<void> {
  const row = await client.query<{
    id: string;
    bot_id: string;
    payee_username: string;
    amount_minor: string;
  }>(
    `UPDATE cash_withdrawals
        SET status = 'queued', vault_released_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'awaiting_vault'
      RETURNING id, bot_id, payee_username, amount_minor`,
    [withdrawalId],
  );
  const withdrawal = row.rows[0];
  if (!withdrawal) return;
  await client.query(
    `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload, available_at)
     VALUES ($1, $2, 'cash_payout', $3, $4, now() + ($5::integer * interval '1 second'))
     ON CONFLICT (kind, reference_id) DO NOTHING`,
    [
      randomUUID(),
      withdrawal.bot_id,
      withdrawal.id,
      JSON.stringify({
        withdrawalId: withdrawal.id,
        payee: withdrawal.payee_username,
        amountMinor: withdrawal.amount_minor,
      }),
      config.withdrawalHopDelaySeconds,
    ],
  );
}

export async function registerCashWithdrawalRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  /* The teller, always. A withdrawal has to arrive from the account players already associate
   * with the site, and the vault's name must never appear on a payment a player receives. */
  const onlineBot = (client: DbClient) => pickBot(client, config, 'teller');

  app.get(
    '/v1/cash-withdrawals/info',
    { preHandler: guards.authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = request.authUser?.id;
      const live = await db.query<WithdrawalRow>(
        `SELECT id, amount_minor, payee_username, status, error_code, created_at, paid_at,
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM
                  (created_at + ($2::integer * interval '1 second') - now()))))::int AS cooldown_seconds
           FROM cash_withdrawals
          WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 5`,
        [userId, WITHDRAWAL_COOLDOWN_SECONDS],
      );
      const pending = live.rows.find((row) =>
        ['pending_approval', 'queued', 'processing'].includes(row.status),
      );
      return {
        payeeUsername: request.authUser?.minecraftUsername ?? null,
        minimumMinor: MIN_WITHDRAWAL_MINOR.toString(),
        approvalThresholdMinor: APPROVAL_THRESHOLD_MINOR.toString(),
        cooldownSeconds: WITHDRAWAL_COOLDOWN_SECONDS,
        cooldownRemainingSeconds: live.rows[0]?.cooldown_seconds ?? 0,
        pending: pending ? view(pending) : null,
        recent: live.rows.map(view),
      };
    },
  );

  app.post(
    '/v1/cash-withdrawals',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = parseWith(requestSchema, request.body ?? {});
      const userId = request.authUser?.id;
      const payee = request.authUser?.minecraftUsername;
      if (!userId || !payee) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);

      const amount = BigInt(body.amountMinor);
      if (amount < MIN_WITHDRAWAL_MINOR) {
        throw new AppError(
          400,
          'WITHDRAWAL_TOO_SMALL',
          `The smallest withdrawal is $${MIN_WITHDRAWAL_MINOR.toString()}`,
        );
      }

      const created = await db.transaction(async (client) => {
        const replayed = await client.query<WithdrawalRow>(
          `SELECT id, amount_minor, payee_username, status, error_code, created_at, paid_at
             FROM cash_withdrawals WHERE user_id = $1 AND idempotency_key = $2`,
          [userId, idempotencyKey],
        );
        if (replayed.rows[0]) return { row: replayed.rows[0], replay: true };

        /* One row, one column. This used to join responsible_limits for a cooldown and a
         * self-exclusion window and read four compliance fields off users; none of them exists
         * any more. The lock stays, because money is about to leave this account. */
        const account = await client.query<DepositEligibilityState>(
          'SELECT status FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        if (!isDepositEligible(account.rows[0])) {
          throw new AppError(403, 'ACCOUNT_RESTRICTED', 'This account cannot withdraw right now');
        }

        /* The first lookup above makes ordinary retries cheap. This second lookup is what closes
         * the race between two identical requests: the account lock makes the second transaction
         * wait, then it sees and replays the row the first one committed instead of mistaking it
         * for a new withdrawal inside the cooldown. */
        const replayedAfterLock = await client.query<WithdrawalRow>(
          `SELECT id, amount_minor, payee_username, status, error_code, created_at, paid_at
             FROM cash_withdrawals WHERE user_id = $1 AND idempotency_key = $2`,
          [userId, idempotencyKey],
        );
        if (replayedAfterLock.rows[0]) {
          return { row: replayedAfterLock.rows[0], replay: true };
        }

        /* The account row lock serializes this check with the insert below. Without that lock,
         * two requests could both see no recent row and create withdrawals a few milliseconds
         * apart. Database time is used so clock drift between API instances cannot shorten the
         * minute. */
        const cooldown = await client.query<{ retry_after_seconds: number }>(
          `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM
                    (created_at + ($2::integer * interval '1 second') - now()))))::int AS retry_after_seconds
             FROM cash_withdrawals
            WHERE user_id = $1 AND created_at > now() - ($2::integer * interval '1 second')
            ORDER BY created_at DESC
            LIMIT 1`,
          [userId, WITHDRAWAL_COOLDOWN_SECONDS],
        );
        const retryAfterSeconds = cooldown.rows[0]?.retry_after_seconds;
        if (retryAfterSeconds !== undefined) {
          throw new AppError(
            429,
            'WITHDRAWAL_COOLDOWN',
            `Wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'} before withdrawing again`,
            { retryAfterSeconds },
          );
        }

        const bot = await onlineBot(client);
        if (!bot) throw new AppError(503, 'BOT_OFFLINE', 'No payment bot is currently online');

        /* Debit inside the same transaction as the insert. The `balance_minor >= $2` guard is what
         * refuses an overdraft — the wallet's own CHECK would also catch it, but as a 500 rather
         * than as something the player can read. */
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 AND balance_minor >= $2
            RETURNING balance_minor`,
          [userId, amount.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) {
          throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Not enough balance for that withdrawal');
        }

        const needsApproval = amount > APPROVAL_THRESHOLD_MINOR;
        const withdrawalId = randomUUID();
        let inserted;
        try {
          inserted = await client.query<WithdrawalRow>(
            `INSERT INTO cash_withdrawals
               (id, user_id, bot_id, payee_username, amount_minor, status, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, amount_minor, payee_username, status, error_code, created_at, paid_at`,
            [
              withdrawalId,
              userId,
              bot.id,
              payee,
              amount.toString(),
              needsApproval ? 'pending_approval' : 'queued',
              idempotencyKey,
            ],
          );
        } catch (error) {
          // cash_withdrawals_one_live_idx. The debit rolls back with the transaction.
          if ((error as { code?: string }).code === '23505') {
            conflict('WITHDRAWAL_IN_FLIGHT', 'You already have a withdrawal being processed');
          }
          throw error;
        }

        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'cash_withdrawal', $5)`,
          [randomUUID(), userId, (-amount).toString(), balanceAfter, withdrawalId],
        );

        if (!needsApproval) {
          await queueWithdrawalJob(client, config, {
            id: withdrawalId,
            bot_id: bot.id,
            payee_username: payee,
            amount_minor: amount.toString(),
          });
        }
        return { row: inserted.rows[0]!, replay: false };
      });

      reply.code(created.replay ? 200 : 202);
      return { withdrawal: view(created.row) };
    },
  );

  app.get(
    '/v1/cash-withdrawals/:id',
    { preHandler: guards.authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(idSchema, request.params);
      const result = await db.query<WithdrawalRow>(
        `SELECT id, amount_minor, payee_username, status, error_code, created_at, paid_at
           FROM cash_withdrawals WHERE id = $1 AND user_id = $2`,
        [params.id, request.authUser?.id],
      );
      const row = result.rows[0];
      if (!row) throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'No such withdrawal');
      return { withdrawal: view(row) };
    },
  );
}
