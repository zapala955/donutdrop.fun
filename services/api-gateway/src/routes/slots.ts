import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager, type WagerOutcome } from '../lib/cash-settlement.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { announceWin } from '../lib/discord-flex.js';
import { flexName } from '../lib/media-test.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import {
  SLOTS_LINES,
  SLOTS_MACHINES,
  SLOTS_MACHINE_IDS,
  SLOTS_MAX_FREE_SPINS,
  SLOTS_MAX_WIN_X,
  maxStakeFor,
  playRound,
  roundFromStops,
  type SlotMachineId,
  type SlotRound,
} from '../lib/slots.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Slots, one request per paid spin: the stake is taken, the spin and every free spin it leads to
 * are drawn from the player's committed fairness seed, and the round's pay is credited, all in one
 * transaction. The page animates a round that already exists, free spins included.
 *
 * The seed is spent by the spin and a fresh one committed in the same transaction, and the
 * response carries the new commitment, so auto-spin sends each spin against the commitment the last
 * one handed back.
 *
 * Money moves twice per spin, stake then payout, both referenced by the spin's id. The wager is
 * recorded once, at the stake: free spins are part of the round the stake bought, not new wagers.
 *
 * Two machines share the routes (lib/slots.ts): Ore Rush, and the Ocean Monument. A request names its
 * machine, Ore Rush when it does not, and the spin is stored with it, so its history replays on the
 * strips it was played on. Both count as Slots on the wallet, the wager and the limits.
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

const machineSchema = z.enum(SLOTS_MACHINE_IDS);

const spinSchema = z
  .object({
    stakeMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
    machine: machineSchema.default('ore-rush'),
  })
  .strict();

const configSchema = z.object({ machine: machineSchema.default('ore-rush') }).strict();

const historySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    machine: machineSchema.optional(),
  })
  .strict();

/* Retries for a serialization conflict, spaced out. Every spin runs the wager hooks (jackpot, races,
 * rakeback, the faction war) that every other player's bet touches too, so a busy site conflicts
 * and one side has to go again; retried at once they collide again. */
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

interface SpinRow {
  id: string;
  user_id: string;
  machine: SlotMachineId;
  request_hash: string;
  stake_minor: string;
  stops: number[];
  free_spins: number;
  multiplier_bps: number;
  payout_minor: string;
  capped: boolean;
  fairness_seed_id: string;
  server_seed_hash: string;
  server_seed_reveal: string;
  client_seed: string;
  nonce: number;
  created_at: Date;
}

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

function roundView(round: SlotRound) {
  return round.spins.map((spin) => ({
    stops: spin.stops,
    grid: spin.grid,
    free: spin.free,
    lines: spin.lines,
    books: spin.books,
    awarded: spin.awarded,
    payoutMinor: spin.payoutMinor.toString(),
  }));
}

function spinView(row: SpinRow) {
  const stake = BigInt(row.stake_minor);
  return {
    id: row.id,
    machine: row.machine,
    stakeMinor: row.stake_minor,
    spins: roundView(roundFromStops(stake, row.stops.map(Number), SLOTS_MACHINES[row.machine])),
    freeSpins: row.free_spins,
    multiplierBps: row.multiplier_bps,
    payoutMinor: row.payout_minor,
    capped: row.capped,
    fairness: {
      serverSeedHash: row.server_seed_hash,
      serverSeed: row.server_seed_reveal,
      clientSeed: row.client_seed,
      nonce: row.nonce,
    },
    createdAt: row.created_at,
  };
}

export async function registerSlotsRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/slots/config', async (request) => {
    const machine = SLOTS_MACHINES[parseWith(configSchema, request.query ?? {}).machine];
    return {
      machine: machine.id,
      name: machine.name,
      enabled: config.slotsEnabled,
      minStakeMinor: config.slotsMinStakeMinor.toString(),
      maxStakeMinor: config.slotsMaxStakeMinor.toString(),
      maxPayoutMinor: config.slotsMaxPayoutMinor.toString(),
      houseEdgeBps: machine.houseEdgeBps,
      maxWinX: SLOTS_MAX_WIN_X,
      maxFreeSpins: SLOTS_MAX_FREE_SPINS,
      freeMultiplier: machine.freeMultiplier,
      wildMultiplier: machine.wildMultiplier,
      symbols: machine.symbols,
      wild: machine.wild,
      scatter: machine.scatter,
      scatterPayX: machine.scatterPayX,
      scatterSpins: machine.scatterSpins,
      strips: machine.strips,
      lines: SLOTS_LINES,
      algorithm: 'HMAC-SHA256-v1:52bit',
    };
  });

  app.get('/v1/slots/spins', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const result = query.machine
      ? await db.query<SpinRow>(
        'SELECT * FROM slots_spins WHERE user_id = $1 AND machine = $3 ORDER BY created_at DESC LIMIT $2',
        [userId, query.limit, query.machine],
      )
      : await db.query<SpinRow>(
        'SELECT * FROM slots_spins WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, query.limit],
      );
    return { spins: result.rows.map(spinView) };
  });

  app.post(
    '/v1/slots/spins',
    /* Auto-spin with turbo is a spin every second or so; this is several times that. */
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);
      const body = parseWith(spinSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      const stake = BigInt(body.stakeMinor);
      const machine = SLOTS_MACHINES[body.machine];

      const result = await serializable(db, async (client) => {
        const existing = await client.query<SpinRow>(
          'SELECT * FROM slots_spins WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          // A retried request gets its original answer, and pays nothing a second time.
          return { row: existing.rows[0], wager: null as WagerOutcome | null };
        }

        if (!config.slotsEnabled) {
          throw new AppError(503, 'SLOTS_CLOSED', 'Slots is closed right now');
        }
        if (stake < config.slotsMinStakeMinor || stake > config.slotsMaxStakeMinor) {
          throw new AppError(
            400,
            'STAKE_OUT_OF_RANGE',
            `A spin stakes between ${config.slotsMinStakeMinor.toString()} and ${config.slotsMaxStakeMinor.toString()}`,
          );
        }
        /* Refused, not capped further: the 1,000x round ceiling is part of the game and priced into
         * its return, but a lower one set by the payout limit would quietly make big stakes a worse
         * bet than small ones. */
        const ceiling = maxStakeFor(config.slotsMaxPayoutMinor);
        if (stake > ceiling) {
          throw new AppError(400, 'STAKE_OVER_PAYOUT_LIMIT', `The largest spin is ${ceiling.toString()}`);
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
            'Fetch the current server-seed commitment before spinning',
          );
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

        const spinId = randomUUID();
        await debit(client, userId, stake, spinId);

        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [fairness.id]);
        await insertFairnessSeed(client, config, userId);

        const round = playRound(serverSeed, body.clientSeed, fairness.nonce, stake, machine);
        const payout = round.payoutMinor;
        if (payout > 0n) await creditWallet(client, userId, payout, 'slots_payout', spinId);
        const multiplierBps = Number((payout * 10_000n) / stake);

        const inserted = await client.query<SpinRow>(
          `INSERT INTO slots_spins
             (id, user_id, machine, idempotency_key, request_hash, stake_minor, stops, free_spins,
              multiplier_bps, payout_minor, capped, fairness_seed_id, server_seed_hash,
              server_seed_reveal, client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING *`,
          [
            spinId,
            userId,
            machine.id,
            idempotencyKey,
            requestHash,
            stake.toString(),
            round.spins.flatMap((spin) => spin.stops),
            round.freeSpins,
            multiplierBps,
            payout.toString(),
            round.capped,
            fairness.id,
            fairness.server_seed_hash,
            serverSeed,
            body.clientSeed,
            fairness.nonce,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Slots spin insert returned no row');

        /* The margin is the machine's own edge on the stake, passed rather than derived from the
         * site's edge, so rakeback and referral shares follow what this game actually keeps. */
        const wager = await recordWager(
          client,
          config,
          userId,
          stake,
          'slots',
          spinId,
          ['wagered_minor'],
          (stake * BigInt(machine.houseEdgeBps)) / 10_000n,
        );
        return { row, wager };
      });

      announce(config, flexName(request.authUser), result.row, result.wager, app.log);
      const [balance, next] = await Promise.all([balanceOf(db, userId), currentCommitment(db, userId)]);
      return reply
        .code(201)
        .send({ spin: spinView(result.row), balanceMinor: balance, nextServerSeedHash: next });
    },
  );
}

/** Takes the stake off the wallet, refusing an overdraft, and writes the ledger line for it. */
async function debit(client: DbClient, userId: string, amount: bigint, spinId: string): Promise<void> {
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
     VALUES ($1, $2, $3, $4, 'slots_stake', $5)`,
    [randomUUID(), userId, (-amount).toString(), balanceAfter, spinId],
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

/** The commitment the player's next spin must be sent against. */
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
  row: SpinRow,
  wager: WagerOutcome | null,
  logger: { error: (context: unknown, message: string) => void },
): void {
  // A replayed request settled nothing new.
  if (!wager || !username) return;
  const stake = BigInt(row.stake_minor);
  const payout = BigInt(row.payout_minor);
  const machine = SLOTS_MACHINES[row.machine];
  if (payout > stake) {
    void announceWin(
      config,
      { username, amountMinor: payout, mode: machine.label, multiplier: row.multiplier_bps / 10_000, path: machine.path },
      logger,
    );
  }
  // The jackpot draws on every wager, a losing spin included.
  const jackpotWin = wager.jackpot.win;
  if (jackpotWin) {
    void announceWin(
      config,
      { username, amountMinor: jackpotWin.amountMinor, mode: 'Vault Jackpot', path: machine.path },
      logger,
    );
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
