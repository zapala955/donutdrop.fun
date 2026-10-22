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
import { publishLiveSoon } from '../lib/live-events.js';
import {
  ICE_FISHING_CATCHES,
  ICE_FISHING_HOLES,
  ICE_FISHING_HOUSE_EDGE_BPS,
  ICE_FISHING_MAX_THIN,
  ICE_FISHING_MIN_THIN,
  catchAt,
  multiplierAfter,
  nextFishChanceBps,
  payoutAfter,
  thinHoles,
} from '../lib/ice-fishing.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Ice Fishing, one game across several requests, the way Mines plays: start, then drill holes until
 * the player pulls out or drills through thin ice.
 *
 * The thin ice is laid at the start from the player's committed fairness seed, which is spent then
 * (and a fresh one committed for next time), so the whole lake is fixed before the first hole. It
 * stays in the row and never reaches a browser until the game is over; the seed is revealed with it.
 *
 * Money moves twice: the stake when the game starts, the payout when it ends. The wager is recorded
 * once, at settlement, with the game's own edge as its margin.
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

const startSchema = z
  .object({
    stakeMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    thin: z.number().int().min(ICE_FISHING_MIN_THIN).max(ICE_FISHING_MAX_THIN),
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const drillSchema = z
  .object({
    hole: z.number().int().min(0).max(ICE_FISHING_HOLES - 1),
    /* How many fish the player was looking at when they chose. A second tap arriving with the old
     * count is refused, instead of drilling a hole nobody asked for. */
    drilledCount: z.number().int().min(0).max(ICE_FISHING_HOLES),
  })
  .strict();

const cashoutSchema = z
  .object({ drilledCount: z.number().int().min(1).max(ICE_FISHING_HOLES) })
  .strict();

const idSchema = z.object({ id: z.uuid() }).strict();
const historySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

/* Retries for a serialization conflict, rather than the default two, and spaced out.
 *
 * A settlement runs the wager hooks (jackpot, races, rakeback, the faction war) that every player's
 * game touches, so under load two players' settlements conflict and one has to go again. Retried
 * at once, the losers all come back in the same instant and collide again; a short, growing,
 * randomised wait lets them land one after another, and the player sees their hole drilled instead of
 * an error. */
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

interface GameRow {
  id: string;
  user_id: string;
  request_hash: string;
  stake_minor: string;
  thin_count: number;
  thin_holes: number[];
  drilled_holes: number[];
  max_payout_minor: string;
  status: 'active' | 'settled';
  outcome: 'cashout' | 'thin' | null;
  thin_hit: number | null;
  payout_minor: string | null;
  fairness_seed_id: string;
  server_seed_hash: string;
  server_seed_reveal: string | null;
  client_seed: string;
  nonce: number;
  created_at: Date;
  settled_at: Date | null;
}

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

function cappedPayout(row: GameRow, drilled: number): bigint {
  if (drilled === 0) return 0n;
  const payout = payoutAfter(BigInt(row.stake_minor), row.thin_count, drilled);
  const cap = BigInt(row.max_payout_minor);
  return payout > cap ? cap : payout;
}

/**
 * What the player may see. While the game is in play the thin ice is absent -- it is in the
 * database, and it never leaves it until the game is over. Each fish is named by the multiplier its
 * hole took the game to.
 */
function gameView(row: GameRow) {
  const settled = row.status === 'settled';
  const drilled = row.drilled_holes.length;
  const fish = ICE_FISHING_HOLES - row.thin_count;
  const more = !settled && drilled < fish;
  return {
    id: row.id,
    status: row.status,
    stakeMinor: row.stake_minor,
    thin: row.thin_count,
    drilled: row.drilled_holes,
    catches: row.drilled_holes.map((_, i) => catchAt(multiplierAfter(row.thin_count, i + 1)).id),
    multiplierBps: drilled > 0 ? multiplierAfter(row.thin_count, drilled) : null,
    cashoutMinor: cappedPayout(row, drilled).toString(),
    nextMultiplierBps: more ? multiplierAfter(row.thin_count, drilled + 1) : null,
    nextPayoutMinor: more ? cappedPayout(row, drilled + 1).toString() : null,
    nextFishChanceBps: more ? nextFishChanceBps(row.thin_count, drilled) : null,
    maxPayoutMinor: row.max_payout_minor,
    outcome: row.outcome,
    payoutMinor: row.payout_minor,
    thinHit: row.thin_hit,
    thinHoles: settled ? row.thin_holes : null,
    fairness: {
      serverSeedHash: row.server_seed_hash,
      clientSeed: row.client_seed,
      nonce: row.nonce,
      serverSeed: settled ? row.server_seed_reveal : null,
    },
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

interface Settlement {
  row: GameRow;
  payout: bigint;
  wager: WagerOutcome;
}

export async function registerIceFishingRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/ice-fishing/config', async () => ({
    enabled: config.iceFishingEnabled,
    minStakeMinor: config.iceFishingMinStakeMinor.toString(),
    maxStakeMinor: config.iceFishingMaxStakeMinor.toString(),
    maxPayoutMinor: config.iceFishingMaxPayoutMinor.toString(),
    houseEdgeBps: ICE_FISHING_HOUSE_EDGE_BPS,
    holes: ICE_FISHING_HOLES,
    minThin: ICE_FISHING_MIN_THIN,
    maxThin: ICE_FISHING_MAX_THIN,
    catches: ICE_FISHING_CATCHES.map(([fromBps, id, name]) => ({ fromBps, id, name })),
    algorithm: 'HMAC-SHA256-v1:fisher-yates',
  }));

  app.get('/v1/ice-fishing/games/active', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const result = await db.query<GameRow>(
      "SELECT * FROM ice_fishing_games WHERE user_id = $1 AND status = 'active'",
      [userId],
    );
    const row = result.rows[0];
    return { game: row ? gameView(row) : null };
  });

  app.get('/v1/ice-fishing/games', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const result = await db.query<GameRow>(
      `SELECT * FROM ice_fishing_games WHERE user_id = $1 AND status = 'settled'
        ORDER BY created_at DESC LIMIT $2`,
      [userId, query.limit],
    );
    return { games: result.rows.map(gameView) };
  });

  app.post(
    '/v1/ice-fishing/games',
    /* A one-hole game takes a couple of seconds, so a steady player starts dozens a minute. */
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);
      const body = parseWith(startSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      const stake = BigInt(body.stakeMinor);

      const row = await serializable(db, async (client) => {
        const existing = await client.query<GameRow>(
          'SELECT * FROM ice_fishing_games WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return existing.rows[0];
        }

        /* Closing the game stops new ones. It never strands one in play: drilling and pulling out
         * work whatever this says, because the stake is already down. */
        if (!config.iceFishingEnabled) {
          throw new AppError(503, 'ICE_FISHING_CLOSED', 'Ice Fishing is closed right now');
        }
        if (stake < config.iceFishingMinStakeMinor || stake > config.iceFishingMaxStakeMinor) {
          throw new AppError(
            400,
            'STAKE_OUT_OF_RANGE',
            `A game stakes between ${config.iceFishingMinStakeMinor.toString()} and ${config.iceFishingMaxStakeMinor.toString()}`,
          );
        }

        await assertGameEligible(client, userId);
        const active = await client.query(
          "SELECT 1 FROM ice_fishing_games WHERE user_id = $1 AND status = 'active'",
          [userId],
        );
        if (active.rowCount) conflict('GAME_IN_PLAY', 'Finish the game you are playing first');

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
            'Fetch the current server-seed commitment before starting',
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

        const gameId = randomUUID();
        await debit(client, userId, stake, gameId);

        /* The seed is spent now, not at settlement: it has laid this lake's ice, and the next game the
         * player starts must not be able to draw from it. It is revealed when the game ends. */
        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [fairness.id]);
        await insertFairnessSeed(client, config, userId);

        const inserted = await client.query<GameRow>(
          `INSERT INTO ice_fishing_games
             (id, user_id, idempotency_key, request_hash, stake_minor, thin_count, thin_holes,
              max_payout_minor, fairness_seed_id, server_seed_hash, client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            gameId,
            userId,
            idempotencyKey,
            requestHash,
            stake.toString(),
            body.thin,
            thinHoles(serverSeed, body.clientSeed, fairness.nonce, body.thin),
            config.iceFishingMaxPayoutMinor.toString(),
            fairness.id,
            fairness.server_seed_hash,
            body.clientSeed,
            fairness.nonce,
          ],
        );
        const game = inserted.rows[0];
        if (!game) throw new Error('Ice fishing game insert returned no row');
        return game;
      });

      publishLiveSoon('balance', [userId]);
      const balance = await balanceOf(db, userId);
      return reply.code(201).send({ game: gameView(row), balanceMinor: balance });
    },
  );

  app.post(
    '/v1/ice-fishing/games/:id/drill',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const params = parseWith(idSchema, request.params);
      const body = parseWith(drillSchema, request.body);

      const result = await serializable(db, async (client) => {
        const row = await lockGame(client, params.id, userId);
        // Asked again after the game ended: the answer is the finished game, not an error.
        if (row.status !== 'active') return { row, settled: null as Settlement | null };
        if (row.drilled_holes.length !== body.drilledCount) {
          conflict('STALE_ACTION', 'The game moved on before that arrived');
        }
        if (row.drilled_holes.includes(body.hole)) {
          conflict('HOLE_TAKEN', 'That hole is already drilled');
        }

        if (row.thin_holes.includes(body.hole)) {
          const settled = await settle(client, config, row, 'thin', body.hole);
          return { row: settled.row, settled };
        }

        const updated = await client.query<GameRow>(
          `UPDATE ice_fishing_games SET drilled_holes = array_append(drilled_holes, $2::smallint)
            WHERE id = $1 AND status = 'active'
            RETURNING *`,
          [row.id, body.hole],
        );
        const next = updated.rows[0];
        if (!next) throw new Error('Ice fishing drill returned no row');

        /* Nothing left worth risking: every fish is out, or the payout has reached the ceiling and a
         * further hole could only lose. Either way it pulls out on its own. */
        const drilled = next.drilled_holes.length;
        const allFish = drilled === ICE_FISHING_HOLES - next.thin_count;
        const capped =
          payoutAfter(BigInt(next.stake_minor), next.thin_count, drilled) >= BigInt(next.max_payout_minor);
        if (allFish || capped) {
          const settled = await settle(client, config, next, 'cashout', null);
          return { row: settled.row, settled };
        }
        return { row: next, settled: null as Settlement | null };
      });

      announce(config, flexName(request.authUser), result.settled, app.log);
      return { game: gameView(result.row), balanceMinor: await balanceOf(db, userId) };
    },
  );

  app.post(
    '/v1/ice-fishing/games/:id/cashout',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const params = parseWith(idSchema, request.params);
      const body = parseWith(cashoutSchema, request.body);

      const result = await serializable(db, async (client) => {
        const row = await lockGame(client, params.id, userId);
        // A second click lands here after the first settled it: return that result, pay nothing.
        if (row.status !== 'active') return { row, settled: null as Settlement | null };
        if (row.drilled_holes.length !== body.drilledCount) {
          conflict('STALE_ACTION', 'The game moved on before that arrived');
        }
        const settled = await settle(client, config, row, 'cashout', null);
        return { row: settled.row, settled };
      });

      announce(config, flexName(request.authUser), result.settled, app.log);
      return { game: gameView(result.row), balanceMinor: await balanceOf(db, userId) };
    },
  );
}

async function lockGame(client: DbClient, id: string, userId: string): Promise<GameRow> {
  const locked = await client.query<GameRow>(
    'SELECT * FROM ice_fishing_games WHERE id = $1 AND user_id = $2 FOR UPDATE',
    [id, userId],
  );
  const row = locked.rows[0];
  if (!row) throw new AppError(404, 'GAME_NOT_FOUND', 'No such game');
  return row;
}

/** Pays out, reveals the ice and the seed, and records the wager -- everything a finished game owes. */
async function settle(
  client: DbClient,
  config: AppConfig,
  row: GameRow,
  outcome: 'cashout' | 'thin',
  thinHit: number | null,
): Promise<Settlement> {
  const seed = await client.query<{ server_seed_ciphertext: string }>(
    'SELECT server_seed_ciphertext FROM fairness_seeds WHERE id = $1',
    [row.fairness_seed_id],
  );
  const ciphertext = seed.rows[0]?.server_seed_ciphertext;
  if (!ciphertext) throw new Error('Ice fishing game lost its fairness seed');
  const serverSeed = decryptSecret(
    ciphertext,
    config.dataEncryptionKey,
    `fairness:${row.user_id}:${row.fairness_seed_id}`,
  );
  if (hashServerSeed(serverSeed) !== row.server_seed_hash) {
    throw new Error('Stored fairness seed does not match its commitment');
  }

  const payout = outcome === 'cashout' ? cappedPayout(row, row.drilled_holes.length) : 0n;
  if (outcome === 'cashout' && row.drilled_holes.length === 0) {
    conflict('NOTHING_TO_CASH', 'Catch at least one fish before pulling out');
  }
  if (payout > 0n) await creditWallet(client, row.user_id, payout, 'ice_fishing_payout', row.id);
  const settled = await client.query<GameRow>(
    `UPDATE ice_fishing_games
        SET status = 'settled', outcome = $2, payout_minor = $3, thin_hit = $4,
            server_seed_reveal = $5, settled_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [row.id, outcome, payout.toString(), thinHit, serverSeed],
  );
  const saved = settled.rows[0];
  if (!saved) throw new Error('Ice fishing game was settled twice');
  /* The margin is the game's own edge on the stake, so rakeback and referral shares follow what
   * this game actually keeps. */
  const stake = BigInt(row.stake_minor);
  const wager = await recordWager(
    client,
    config,
    row.user_id,
    stake,
    'ice_fishing',
    row.id,
    ['wagered_minor'],
    (stake * BigInt(ICE_FISHING_HOUSE_EDGE_BPS)) / 10_000n,
  );
  return { row: saved, payout, wager };
}

/** Takes the stake off the wallet, refusing an overdraft, and writes the ledger line for it. */
async function debit(client: DbClient, userId: string, amount: bigint, gameId: string): Promise<void> {
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
     VALUES ($1, $2, $3, $4, 'ice_fishing_stake', $5)`,
    [randomUUID(), userId, (-amount).toString(), balanceAfter, gameId],
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

/* After the commit, never inside it, and never awaited: a slow webhook is not a slow payout. */
function announce(
  config: AppConfig,
  username: string | undefined,
  settled: Settlement | null,
  logger: { error: (context: unknown, message: string) => void },
): void {
  if (!settled) return;
  // A finished game is a new row in the live feed.
  publishLiveSoon('activity');
  if (!username) return;
  const stake = BigInt(settled.row.stake_minor);
  if (settled.payout > stake) {
    void announceWin(
      config,
      {
        username,
        amountMinor: settled.payout,
        mode: 'Ice Fishing',
        multiplier: Number(settled.payout) / Number(stake),
        path: '/ice-fishing',
      },
      logger,
    );
  }
  // The jackpot draws on every wager, a game lost to thin ice included.
  const jackpotWin = settled.wager.jackpot.win;
  if (jackpotWin) {
    void announceWin(
      config,
      { username, amountMinor: jackpotWin.amountMinor, mode: 'Vault Jackpot', path: '/ice-fishing' },
      logger,
    );
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
