import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { DonutSmpApi, MONEY_MINOR_SCALE } from '../lib/donutsmp-api.js';
import { AppError, conflict } from '../lib/errors.js';
import { isDepositEligible, type DepositEligibilityState } from '../lib/eligibility.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';
import { creditWallet } from '../lib/wallet.js';

const AMOUNT_PATTERN = /^[1-9]\d{0,15}$/;
const MAX_DEPOSIT = 9_000_000_000_000_000n;
const CHALLENGE_TTL_MINUTES = 10;
const UNIQUE_VIOLATION = '23505';

const startSchema = z
  .object({
    // The rest of the application calls its whole DonutSMP-dollar ledger values "minor". Keep
    // that API vocabulary here so a $1M catalog item and a $1M deposit are both 1000000.
    amountMinor: z
      .string()
      .regex(AMOUNT_PATTERN)
      .refine(
        (value) => !AMOUNT_PATTERN.test(value) || BigInt(value) <= MAX_DEPOSIT,
        'Deposit amount is too large',
      ),
  })
  .strict();
const statusSchema = z.object({ id: z.uuid() }).strict();

interface CashDepositRow {
  id: string;
  user_id: string;
  bot_id: string;
  amount_minor: string;
  bot_balance_before_minor: string;
  status: 'pending' | 'observed' | 'credited' | 'expired' | 'manual_review';
  displayed_amount: string | null;
  observed_at: Date | null;
  credited_at: Date | null;
  balance_after_minor: string | null;
  expires_at: Date;
  created_at: Date;
  bot_username: string;
  request_hash?: string;
}

function response(row: CashDepositRow) {
  return {
    deposit: {
      id: row.id,
      amountMinor: row.amount_minor,
      status: row.status,
      botUsername: row.bot_username,
      displayedAmount: row.displayed_amount,
      observedAt: row.observed_at,
      creditedAt: row.credited_at,
      balanceMinor: row.balance_after_minor,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    },
    instruction: `/pay ${row.bot_username} ${row.amount_minor}`,
  };
}

function postgresCode(error: unknown): unknown {
  return error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
}

/**
 * DonutSMP cash deposits.
 *
 * Large payment receipts are abbreviated in chat, so the receipt identifies the linked payer
 * while the exact bot balance delta identifies the amount. Only one challenge may occupy a bot's
 * payment lane at a time; otherwise two real payments could be folded into one ambiguous delta.
 */
export async function registerCashDepositRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];
  const donutsmp = new DonutSmpApi(config);

  app.post(
    '/v1/cash-deposits',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const body = parseWith(startSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      if (!donutsmp.configured) {
        throw new AppError(503, 'CASH_DEPOSITS_UNAVAILABLE', 'Cash deposits are not configured');
      }
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));

      const prior = await db.query<CashDepositRow>(
        `SELECT d.*, b.username AS bot_username
           FROM cash_deposit_challenges d JOIN bot_accounts b ON b.id = d.bot_id
          WHERE d.user_id = $1 AND d.idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) {
          conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
        }
        return reply.send(response(prior.rows[0]));
      }

      // Reopening the modal must recover the live command instead of stranding the player behind
      // the one-active-challenge guard until it expires.
      const active = await db.query<CashDepositRow>(
        `SELECT d.*, b.username AS bot_username
           FROM cash_deposit_challenges d JOIN bot_accounts b ON b.id = d.bot_id
          WHERE d.user_id = $1 AND d.status IN ('pending', 'observed')
            AND (d.status = 'observed' OR d.expires_at > now())
          ORDER BY d.created_at DESC LIMIT 1`,
        [userId],
      );
      if (active.rows[0]) return reply.send(response(active.rows[0]));

      const bots = await db.query<{ id: string; username: string; server_host: string }>(
        `SELECT id, username, server_host FROM bot_accounts
          WHERE id = ANY($1::uuid[]) AND status = 'online'
            AND last_heartbeat_at > now() - interval '45 seconds'
          ORDER BY last_heartbeat_at DESC`,
        [provisionedBotIds],
      );
      const bot = bots.rows.find((candidate) => {
        const provisioned = config.botCredentials.get(candidate.id);
        return (
          provisioned &&
          candidate.username.toLowerCase() === provisioned.username.toLowerCase() &&
          candidate.server_host.toLowerCase().replace(/\.$/, '') === provisioned.serverHost
        );
      });
      if (!bot) throw new AppError(503, 'BOT_OFFLINE', 'No payment bot is currently online');

      // This read must predate the /pay command shown to the player.
      const balanceBefore = await donutsmp.fetchMoneyMinor(bot.username);
      let created: CashDepositRow;
      try {
        created = await db.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8841))', [
            `${userId}:${idempotencyKey}`,
          ]);
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8842))', [
            `payment-lane:${bot.id}`,
          ]);
          const replay = await client.query<CashDepositRow>(
            `SELECT d.*, b.username AS bot_username
               FROM cash_deposit_challenges d JOIN bot_accounts b ON b.id = d.bot_id
              WHERE d.user_id = $1 AND d.idempotency_key = $2`,
            [userId, idempotencyKey],
          );
          if (replay.rows[0]) {
            if (replay.rows[0].request_hash !== requestHash) {
              conflict(
                'IDEMPOTENCY_KEY_REUSED',
                'Idempotency key was used with a different request',
              );
            }
            return replay.rows[0];
          }

          await client.query(
            `UPDATE cash_deposit_challenges SET status = 'expired', updated_at = now()
              WHERE status = 'pending' AND expires_at <= now()`,
          );
          await client.query(
            `UPDATE cash_deposit_challenges SET status = 'manual_review', updated_at = now()
              WHERE status = 'observed' AND expires_at <= now()`,
          );
          const pendingLogin = await client.query(
            `SELECT 1 FROM auth_link_challenges
              WHERE bot_id = $1 AND method = 'payment' AND completed_at IS NULL
                AND confirmed_at IS NULL AND expires_at > now()
              LIMIT 1`,
            [bot.id],
          );
          if (pendingLogin.rowCount) {
            throw new AppError(
              409,
              'PAYMENT_LANE_BUSY',
              'Another payment is being verified; try again in a moment',
            );
          }

          const user = await client.query<DepositEligibilityState>(
            `SELECT account.status, account.country_code, account.terms_accepted_at,
                    account.age_verified_at, account.kyc_status, limits.cooldown_until,
                    limits.self_excluded_until
               FROM users account
               JOIN responsible_limits limits ON limits.user_id = account.id
              WHERE account.id = $1 FOR UPDATE OF account, limits`,
            [userId],
          );
          if (
            !isDepositEligible(
              user.rows[0],
              config.allowedCountries,
              Date.now(),
              config.gameCurrencyOnly,
            )
          ) {
            throw new AppError(403, 'ACCOUNT_RESTRICTED', 'Account cannot create deposits');
          }

          const inserted = await client.query<CashDepositRow>(
            `INSERT INTO cash_deposit_challenges
               (id, user_id, bot_id, amount_minor, bot_balance_before_minor,
                idempotency_key, request_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7,
                     now() + make_interval(mins => $8))
             RETURNING *, $9::varchar AS bot_username`,
            [
              randomUUID(),
              userId,
              bot.id,
              body.amountMinor,
              balanceBefore.toString(),
              idempotencyKey,
              requestHash,
              CHALLENGE_TTL_MINUTES,
              bot.username,
            ],
          );
          const row = inserted.rows[0];
          if (!row) throw new Error('Cash deposit insert returned no row');
          return row;
        });
      } catch (error) {
        if (postgresCode(error) === UNIQUE_VIOLATION) {
          throw new AppError(
            409,
            'PAYMENT_LANE_BUSY',
            'Another payment is being verified; try again in a moment',
          );
        }
        throw error;
      }
      return reply.code(201).send(response(created));
    },
  );

  app.get(
    '/v1/cash-deposits/:id',
    {
      preHandler: guards.authenticate,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request) => {
      const params = parseWith(statusSchema, request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const found = await db.query<CashDepositRow>(
        `SELECT d.*, b.username AS bot_username
           FROM cash_deposit_challenges d JOIN bot_accounts b ON b.id = d.bot_id
          WHERE d.id = $1 AND d.user_id = $2`,
        [params.id, userId],
      );
      const deposit = found.rows[0];
      if (!deposit) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Cash deposit was not found');
      if (deposit.status === 'credited' || deposit.status === 'manual_review') {
        return response(deposit);
      }
      if (deposit.status === 'expired') return response(deposit);
      if (deposit.status === 'pending' && deposit.expires_at.getTime() <= Date.now()) {
        await db.query(
          `UPDATE cash_deposit_challenges SET status = 'expired', updated_at = now()
            WHERE id = $1 AND status = 'pending'`,
          [deposit.id],
        );
        return response({ ...deposit, status: 'expired' });
      }
      if (deposit.status === 'pending') return response(deposit);

      const current = await donutsmp.fetchMoneyMinor(deposit.bot_username);
      const expected =
        BigInt(deposit.bot_balance_before_minor) + BigInt(deposit.amount_minor) * MONEY_MINOR_SCALE;
      if (current < expected) return response(deposit);
      if (current > expected) {
        await db.query(
          `UPDATE cash_deposit_challenges
              SET status = 'manual_review', updated_at = now()
            WHERE id = $1 AND status = 'observed'`,
          [deposit.id],
        );
        return response({ ...deposit, status: 'manual_review' });
      }

      const credited = await db.transaction<CashDepositRow>(async (client) => {
        const locked = await client.query<CashDepositRow>(
          `SELECT d.*, b.username AS bot_username
             FROM cash_deposit_challenges d JOIN bot_accounts b ON b.id = d.bot_id
            WHERE d.id = $1 AND d.user_id = $2 FOR UPDATE OF d`,
          [deposit.id, userId],
        );
        const row = locked.rows[0];
        if (!row) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Cash deposit was not found');
        if (row.status === 'credited') return row;
        if (row.status !== 'observed') {
          conflict('DEPOSIT_STATE_CHANGED', 'Cash deposit state changed while it was verified');
        }
        const balanceAfter = await creditWallet(
          client,
          userId,
          BigInt(row.amount_minor),
          'cash_deposit',
          row.id,
        );
        const updated = await client.query<CashDepositRow>(
          `UPDATE cash_deposit_challenges
              SET status = 'credited', credited_at = now(), balance_after_minor = $2,
                  updated_at = now()
            WHERE id = $1
            RETURNING *, $3::varchar AS bot_username`,
          [row.id, balanceAfter, row.bot_username],
        );
        const result = updated.rows[0];
        if (!result) throw new Error('Cash deposit credit returned no row');
        return result;
      });
      return response(credited);
    },
  );
}
