import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager, type WagerOutcome } from '../lib/cash-settlement.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import {
  LIMBO_HOUSE_EDGE_BPS,
  LIMBO_MAX_TARGET_X100,
  LIMBO_MIN_TARGET_X100,
  limboChancePpm,
  limboResult,
  limboWins,
  maxStakeAt,
  payoutAt,
} from '../lib/limbo.js';
import { announceWin } from '../lib/discord-flex.js';
import { flexName } from '../lib/media-test.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Limbo, one request per bet, the way Dice settles a roll: the stake is taken, the multiplier drawn
 * from the player's committed fairness seed (lib/limbo.ts), and a win paid, all in one
 * transaction. The page animates a result that already exists.
 *
 * The seed is spent by the bet and a fresh one committed in the same transaction; the response
 * carries the new commitment for the next roll. Money moves twice, stake then payout, both
 * referenced by the bet's id, and the wager is recorded once, which is what feeds VIP, rakeback,
 * races, referrals, the jackpot and the wager requirement.
 */

const clientSeedSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 128, 'Must not exceed 128 UTF-8 bytes')
  .refine(
    (value) => ![...value].some((c) => (c.codePointAt(0) ?? 0) <= 31 || c.codePointAt(0) === 127),
    'Must not contain control characters',
  );

const betSchema = z
  .object({
    stakeMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    /** The target multiplier, in hundredths: 2.00x is 200. */
    target: z.number().int().min(LIMBO_MIN_TARGET_X100).max(LIMBO_MAX_TARGET_X100),
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const historySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

/* Retried on a serialization conflict, spaced out, like Dice: every bet runs the wager hooks that
 * every other player's bet touches too. */
const RETRIES = 12;

async function serializable<T>(db: Database, work: (client: DbClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(work, 0);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < RETRIES) {
        const ceiling = Math.min(400, 8 * 2 ** attempt);
        await new Promise((resolve) => setTimeout(resolve, ceiling * (0.5 + Math.random())));
        continue;
      }
      throw error;
    }
  }
}

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

interface BetRow {
  id: string;
  user_id: string;
  request_hash: string;
  stake_minor: string;
  target_x100: number;
  result_x100: number;
  win: boolean;
  payout_minor: string;
  server_seed_hash: string;
  server_seed_reveal: string;
  client_seed: string;
  nonce: number;
  created_at: Date;
}

function betView(row: BetRow) {
  return {
    id: row.id,
    stakeMinor: row.stake_minor,
    target: row.target_x100,
    result: row.result_x100,
    win: row.win,
    payoutMinor: row.payout_minor,
    fairness: {
      serverSeedHash: row.server_seed_hash,
      serverSeed: row.server_seed_reveal,
      clientSeed: row.client_seed,
      nonce: row.nonce,
    },
    createdAt: row.created_at,
  };
}

export async function registerLimboRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/limbo/config', async () => ({
    enabled: config.limboEnabled,
    minStakeMinor: config.limboMinStakeMinor.toString(),
    maxStakeMinor: config.limboMaxStakeMinor.toString(),
    maxPayoutMinor: config.limboMaxPayoutMinor.toString(),
    houseEdgeBps: LIMBO_HOUSE_EDGE_BPS,
    minTarget: LIMBO_MIN_TARGET_X100,
    maxTarget: LIMBO_MAX_TARGET_X100,
    algorithm: 'HMAC-SHA256-v1:52bit',
  }));

  app.get('/v1/limbo/bets', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const result = await db.query<BetRow>(
      'SELECT * FROM limbo_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, query.limit],
    );
    return { bets: result.rows.map(betView) };
  });

  app.post(
    '/v1/limbo/bets',
    /* A bet every couple of hundred milliseconds is a player enjoying the game, not an attack. */
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 480, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);
      const body = parseWith(betSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      const stake = BigInt(body.stakeMinor);

      const result = await serializable(db, async (client) => {
        const existing = await client.query<BetRow>(
          'SELECT * FROM limbo_bets WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          // A retried request gets its original answer, and pays nothing a second time.
          return { row: existing.rows[0], wager: null as WagerOutcome | null };
        }

        if (!config.limboEnabled) throw new AppError(503, 'LIMBO_CLOSED', 'Limbo is closed right now');
        // The schema bounds the target; this proves it again where the money is decided.
        limboChancePpm(body.target);
        if (stake < config.limboMinStakeMinor || stake > config.limboMaxStakeMinor) {
          throw new AppError(
            400,
            'STAKE_OUT_OF_RANGE',
            `A bet stakes between ${config.limboMinStakeMinor.toString()} and ${config.limboMaxStakeMinor.toString()}`,
          );
        }
        /* Refused, not capped: a capped win would pay less than the multiplier the player chose. */
        const ceiling = maxStakeAt(body.target, config.limboMaxPayoutMinor);
        if (stake > ceiling) {
          throw new AppError(
            400,
            'STAKE_OVER_PAYOUT_LIMIT',
            `At that target the largest bet is ${ceiling.toString()}`,
          );
        }

        await assertGameEligible(client, userId);

        const fairnessResult = await client.query<FairnessRow>(
          `SELECT id, server_seed_ciphertext, server_seed_hash, nonce
             FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
          [userId],
        );
        const fairness = fairnessResult.rows[0];
        if (!fairness) {
          throw new AppError(
            409,
            'FAIRNESS_COMMITMENT_REQUIRED',
            'Fetch the current server-seed commitment before betting',
          );
        }
        if (fairness.server_seed_hash !== body.serverSeedHash) {
          conflict(
            'FAIRNESS_COMMITMENT_CHANGED',
            'The supplied server-seed commitment is no longer active',
          );
        }
        const serverSeed = decryptSecret(
          fairness.server_seed_ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${fairness.id}`,
        );
        if (hashServerSeed(serverSeed) !== fairness.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }

        const betId = randomUUID();
        await debit(client, userId, stake, betId);

        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [
          fairness.id,
        ]);
        await insertFairnessSeed(client, config, userId);

        const result = limboResult(serverSeed, body.clientSeed, fairness.nonce);
        const win = limboWins(body.target, result);
        const payout = win ? payoutAt(stake, body.target) : 0n;
        if (payout > 0n) await creditWallet(client, userId, payout, 'limbo_payout', betId);

        const inserted = await client.query<BetRow>(
          `INSERT INTO limbo_bets
             (id, user_id, idempotency_key, request_hash, stake_minor, target_x100, result_x100, win,
              payout_minor, fairness_seed_id, server_seed_hash, server_seed_reveal, client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING *`,
          [
            betId,
            userId,
            idempotencyKey,
            requestHash,
            stake.toString(),
            body.target,
            result,
            win,
            payout.toString(),
            fairness.id,
            fairness.server_seed_hash,
            serverSeed,
            body.clientSeed,
            fairness.nonce,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Limbo bet insert returned no row');

        /* The margin is Limbo's own edge on the stake, so rakeback and referral shares follow what
         * this game actually keeps. */
        const wager = await recordWager(
          client,
          config,
          userId,
          stake,
          'limbo',
          betId,
          ['wagered_minor'],
          (stake * BigInt(LIMBO_HOUSE_EDGE_BPS)) / 10_000n,
        );
        return { row, wager };
      });

      announce(config, flexName(request.authUser), result.row, result.wager, app.log);
      const [balance, next] = await Promise.all([
        balanceOf(db, userId),
        currentCommitment(db, userId),
      ]);
      return reply
        .code(201)
        .send({ bet: betView(result.row), balanceMinor: balance, nextServerSeedHash: next });
    },
  );
}

/** Takes the stake off the wallet, refusing an overdraft, and writes the ledger line for it. */
async function debit(
  client: DbClient,
  userId: string,
  amount: bigint,
  betId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const debited = await client.query<{ balance_minor: string }>(
    `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
      WHERE user_id = $1 AND balance_minor >= $2
      RETURNING balance_minor`,
    [userId, amount.toString()],
  );
  const balanceAfter = debited.rows[0]?.balance_minor;
  if (balanceAfter === undefined) {
    throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for that stake');
  }
  await client.query(
    `INSERT INTO wallet_transactions (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
     VALUES ($1, $2, $3, $4, 'limbo_stake', $5)`,
    [randomUUID(), userId, (-amount).toString(), balanceAfter, betId],
  );
}

async function insertFairnessSeed(client: DbClient, config: AppConfig, userId: string) {
  const id = randomUUID();
  const seed = generateServerSeed();
  await client.query(
    `INSERT INTO fairness_seeds(id, user_id, server_seed_ciphertext, server_seed_hash, nonce)
     VALUES ($1, $2, $3, $4, 0)`,
    [
      id,
      userId,
      encryptSecret(seed, config.dataEncryptionKey, `fairness:${userId}:${id}`),
      hashServerSeed(seed),
    ],
  );
}

async function balanceOf(db: Database, userId: string): Promise<string> {
  const result = await db.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM user_wallets WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.balance_minor ?? '0';
}

/** The commitment the player's next bet must be sent against. */
async function currentCommitment(db: Database, userId: string): Promise<string | null> {
  const result = await db.query<{ server_seed_hash: string }>(
    'SELECT server_seed_hash FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
  return result.rows[0]?.server_seed_hash ?? null;
}

/* After the commit, never inside it, and never awaited: a slow webhook is not a slow payout. */
function announce(
  config: AppConfig,
  username: string | undefined,
  row: BetRow,
  wager: WagerOutcome | null,
  logger: { error: (context: unknown, message: string) => void },
): void {
  // A replayed request settled nothing new.
  if (!wager || !username) return;
  const stake = BigInt(row.stake_minor);
  const payout = BigInt(row.payout_minor);
  if (payout > stake) {
    void announceWin(
      config,
      {
        username,
        amountMinor: payout,
        mode: 'Limbo',
        multiplier: row.target_x100 / 100,
        path: '/limbo',
      },
      logger,
    );
  }
  // The jackpot draws on every wager, a losing bet included.
  const jackpotWin = wager.jackpot.win;
  if (jackpotWin) {
    void announceWin(
      config,
      { username, amountMinor: jackpotWin.amountMinor, mode: 'Vault Jackpot', path: '/limbo' },
      logger,
    );
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
