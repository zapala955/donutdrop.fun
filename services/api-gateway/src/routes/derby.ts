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
  DERBY_HOUSE_EDGE_BPS,
  DERBY_PICKS,
  DERBY_RACERS,
  DERBY_SPAN,
  drawRace,
  maxStakeFor,
  oddsX100,
  payoutFor,
} from '../lib/derby.js';
import { announceWin } from '../lib/discord-flex.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { flexName } from '../lib/media-test.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Mob Derby, one request per race, the way Dice settles a roll: the stake is taken, the winner and
 * the track drawn from the player's committed fairness seed, and a winning pick paid, all in one
 * transaction. The page runs a race whose winner already exists.
 *
 * The seed is spent by the race and a fresh one committed in the same transaction; the response
 * carries the new commitment for the next race. Money moves twice, stake then payout, both
 * referenced by the race's id, and the wager is recorded once.
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

const raceSchema = z
  .object({
    stakeMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    pick: z.enum(DERBY_PICKS),
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const historySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

/* Retried on a serialization conflict, spaced out, like Dice: every race runs the wager hooks that
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

interface RaceRow {
  id: string;
  user_id: string;
  request_hash: string;
  stake_minor: string;
  pick: string;
  winner: string;
  roll: number;
  track_seed: string;
  multiplier_x100: number;
  payout_minor: string;
  server_seed_hash: string;
  server_seed_reveal: string;
  client_seed: string;
  nonce: number;
  created_at: Date;
}

function raceView(row: RaceRow) {
  return {
    id: row.id,
    stakeMinor: row.stake_minor,
    pick: row.pick,
    winner: row.winner,
    roll: row.roll,
    trackSeed: row.track_seed,
    multiplierX100: row.multiplier_x100,
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

export async function registerDerbyRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/derby/config', async () => ({
    enabled: config.derbyEnabled,
    minStakeMinor: config.derbyMinStakeMinor.toString(),
    maxStakeMinor: config.derbyMaxStakeMinor.toString(),
    maxPayoutMinor: config.derbyMaxPayoutMinor.toString(),
    houseEdgeBps: DERBY_HOUSE_EDGE_BPS,
    span: DERBY_SPAN,
    racers: DERBY_RACERS.map((racer) => ({
      ...racer,
      oddsX100: oddsX100(racer.id),
      maxStakeMinor: maxStakeFor(racer.id, config.derbyMaxPayoutMinor).toString(),
    })),
    algorithm: 'HMAC-SHA256-v1:8bit-winner',
  }));

  app.get('/v1/derby/races', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const result = await db.query<RaceRow>(
      'SELECT * FROM derby_races WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, query.limit],
    );
    return { races: result.rows.map(raceView) };
  });

  app.post(
    '/v1/derby/races',
    /* A race every few seconds is a player enjoying the game, not an attack. */
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);
      const body = parseWith(raceSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      const stake = BigInt(body.stakeMinor);

      const result = await serializable(db, async (client) => {
        const existing = await client.query<RaceRow>(
          'SELECT * FROM derby_races WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          // A retried request gets its original answer, and pays nothing a second time.
          return { row: existing.rows[0], wager: null as WagerOutcome | null };
        }

        if (!config.derbyEnabled) throw new AppError(503, 'DERBY_CLOSED', 'Mob Derby is closed right now');
        if (stake < config.derbyMinStakeMinor || stake > config.derbyMaxStakeMinor) {
          throw new AppError(
            400,
            'STAKE_OUT_OF_RANGE',
            `A bet stakes between ${config.derbyMinStakeMinor.toString()} and ${config.derbyMaxStakeMinor.toString()}`,
          );
        }
        /* Refused, not capped: a capped win would pay less than the racer's odds. */
        const ceiling = maxStakeFor(body.pick, config.derbyMaxPayoutMinor);
        if (stake > ceiling) {
          throw new AppError(400, 'STAKE_OVER_PAYOUT_LIMIT', `On that racer the largest bet is ${ceiling.toString()}`);
        }

        await assertGameEligible(client, userId);

        const fairnessResult = await client.query<FairnessRow>(
          `SELECT id, server_seed_ciphertext, server_seed_hash, nonce
             FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
          [userId],
        );
        const fairness = fairnessResult.rows[0];
        if (!fairness) {
          throw new AppError(409, 'FAIRNESS_COMMITMENT_REQUIRED', 'Fetch the current server-seed commitment before racing');
        }
        if (fairness.server_seed_hash !== body.serverSeedHash) {
          conflict('FAIRNESS_COMMITMENT_CHANGED', 'The supplied server-seed commitment is no longer active');
        }
        const serverSeed = decryptSecret(
          fairness.server_seed_ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${fairness.id}`,
        );
        if (hashServerSeed(serverSeed) !== fairness.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }

        const raceId = randomUUID();
        await debit(client, userId, stake, raceId);

        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [fairness.id]);
        await insertFairnessSeed(client, config, userId);

        const race = drawRace(serverSeed, body.clientSeed, fairness.nonce);
        const won = payoutFor(stake, body.pick, race.winner);
        if (won.payoutMinor > 0n) await creditWallet(client, userId, won.payoutMinor, 'derby_payout', raceId);

        const inserted = await client.query<RaceRow>(
          `INSERT INTO derby_races
             (id, user_id, idempotency_key, request_hash, stake_minor, pick, winner, roll, track_seed,
              multiplier_x100, payout_minor, fairness_seed_id, server_seed_hash, server_seed_reveal,
              client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING *`,
          [
            raceId,
            userId,
            idempotencyKey,
            requestHash,
            stake.toString(),
            body.pick,
            race.winner,
            race.roll,
            race.trackSeed,
            won.x100,
            won.payoutMinor.toString(),
            fairness.id,
            fairness.server_seed_hash,
            serverSeed,
            body.clientSeed,
            fairness.nonce,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Derby race insert returned no row');

        /* The margin is the game's own edge on the stake, so rakeback and referral shares follow
         * what this game actually keeps. */
        const wager = await recordWager(
          client,
          config,
          userId,
          stake,
          'derby',
          raceId,
          ['wagered_minor'],
          (stake * BigInt(DERBY_HOUSE_EDGE_BPS)) / 10_000n,
        );
        return { row, wager };
      });

      announce(config, flexName(request.authUser), result.row, result.wager, app.log);
      const [balance, next] = await Promise.all([balanceOf(db, userId), currentCommitment(db, userId)]);
      return reply.code(201).send({ race: raceView(result.row), balanceMinor: balance, nextServerSeedHash: next });
    },
  );
}

/** Takes the stake off the wallet, refusing an overdraft, and writes the ledger line for it. */
async function debit(client: DbClient, userId: string, amount: bigint, raceId: string): Promise<void> {
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
     VALUES ($1, $2, $3, $4, 'derby_stake', $5)`,
    [randomUUID(), userId, (-amount).toString(), balanceAfter, raceId],
  );
}

async function insertFairnessSeed(client: DbClient, config: AppConfig, userId: string) {
  const id = randomUUID();
  const seed = generateServerSeed();
  await client.query(
    `INSERT INTO fairness_seeds(id, user_id, server_seed_ciphertext, server_seed_hash, nonce)
     VALUES ($1, $2, $3, $4, 0)`,
    [id, userId, encryptSecret(seed, config.dataEncryptionKey, `fairness:${userId}:${id}`), hashServerSeed(seed)],
  );
}

async function balanceOf(db: Database, userId: string): Promise<string> {
  const result = await db.query<{ balance_minor: string }>('SELECT balance_minor FROM user_wallets WHERE user_id = $1', [userId]);
  return result.rows[0]?.balance_minor ?? '0';
}

/** The commitment the player's next race must be sent against. */
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
  row: RaceRow,
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
      { username, amountMinor: payout, mode: 'Mob Derby', multiplier: row.multiplier_x100 / 100, path: '/derby' },
      logger,
    );
  }
  // The jackpot draws on every wager, a losing bet included.
  const jackpotWin = wager.jackpot.win;
  if (jackpotWin) {
    void announceWin(config, { username, amountMinor: jackpotWin.amountMinor, mode: 'Vault Jackpot', path: '/derby' }, logger);
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
