import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager } from '../lib/cash-settlement.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { liveEvents } from '../lib/live-events.js';
import { maskedName } from '../lib/masked-name.js';
import {
  effectiveLeverage,
  epochPathAsync,
  openPosition,
  outcomeInTick,
  payoutAt,
  priceAt,
  STOCKS_BASE_PRICE,
  STOCKS_EDGE_BPS,
  STOCKS_EPOCH_TICKS,
  STOCKS_STEP_PPM,
  STOCKS_MIN_LEVERAGE,
  STOCKS_PACE_BLOCK_TICKS,
  STOCKS_PACES,
  STOCKS_SPIKE_CHANCE,
  STOCKS_SPIKE_FACTOR,
  STOCKS_TICK_MS,
  tickMoves,
  type EpochPath,
  type Outcome,
  type Position,
  type Side,
} from '../lib/stocks.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Stocks: the shared chart, and positions on it (lib/stocks.ts has the maths and the edge).
 *
 * ── what makes it safe ──
 * Time is the database's. The tick a request acts on is read from clock_timestamp() inside its own
 * transaction, and the chart only ever publishes ticks the database clock has reached, so no
 * browser can see a price before a request could act on it.
 *
 * A position ends one of three ways, each a guarded UPDATE ... WHERE status = 'open' on its locked
 * row, so it ends once: the player closes it, or the price touches its liquidation level, or its
 * cap level. The sweep checks every tick against every open position and records how far it got
 * (stocks_sweep); a close checks the ticks after that itself, so a liquidation the sweep has not
 * reached yet is still a liquidation, and a price that touched the level and came back cannot be
 * closed at the better price.
 *
 * ── what the browser is told ──
 * The current epoch's seed hash and the next one's, before either starts; past ticks only; the
 * seed of an epoch once it has ended.
 */

const MAX_OPEN_PER_PLAYER = 20;
/** Ticks of history the page asks for by default: two minutes. */
const HISTORY_TICKS = 1200;

const openSchema = z
  .object({
    side: z.enum(['long', 'short']),
    stakeMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
    leverage: z.number().int().min(STOCKS_MIN_LEVERAGE).max(1000),
  })
  .strict();

const closeSchema = z.object({ positionId: z.uuid() }).strict();

interface EpochRow {
  id: string;
  seq: string;
  starts_at: Date;
  tick_ms: number;
  ticks: number;
  step_ppm: number;
  start_level: number;
  server_seed_hash: string;
  server_seed_ciphertext: string;
  server_seed_reveal: string | null;
}

interface Epoch {
  readonly row: EpochRow;
  readonly seq: number;
  readonly start: number; // epoch ms
  readonly end: number; // epoch ms, exclusive
  readonly seed: string;
  readonly path: EpochPath;
}

interface PositionRow {
  id: string;
  user_id: string;
  side: Side;
  stake_minor: string;
  leverage: number;
  fee_ppm: number;
  step_ppm: number;
  max_payout_minor: string;
  open_level: number;
  liquidation_level: number;
  cap_level: number | null;
  open_price: string;
  entry_price: string;
  liquidation_price: string;
  cap_price: string | null;
  opened_epoch: string;
  opened_tick: number;
  status: 'open' | 'closed' | 'liquidated' | 'capped';
  close_level: number | null;
  close_price: string | null;
  closed_epoch: string | null;
  closed_tick: number | null;
  payout_minor: string | null;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  settled_at: Date | null;
}

/** A settled position as the strip on the stage shows it. */
interface FeedRow {
  id: string;
  player_id: string;
  player: string;
  side: Side;
  leverage: number;
  stake_minor: string;
  status: string;
  payout_minor: string | null;
  settled_at: Date;
}

/** A point on the chart: the epoch and the tick within it. Ordered by epoch, then tick. */
interface TickRef {
  readonly seq: number;
  readonly tick: number;
}
const before = (a: TickRef, b: TickRef) => a.seq < b.seq || (a.seq === b.seq && a.tick < b.tick);

function asPosition(row: PositionRow): Position {
  return {
    side: row.side,
    stakeMinor: BigInt(row.stake_minor),
    leverage: row.leverage,
    openLevel: row.open_level,
    maxPayoutMinor: BigInt(row.max_payout_minor),
    feePpm: row.fee_ppm,
    liquidationLevel: row.liquidation_level,
    capLevel: row.cap_level,
  };
}

function positionView(row: PositionRow) {
  return {
    id: row.id,
    side: row.side,
    leverage: row.leverage,
    effectiveLeverage: effectiveLeverage(row.side, Math.abs(row.liquidation_level - row.open_level), row.step_ppm, row.fee_ppm),
    stakeMinor: row.stake_minor,
    feePpm: row.fee_ppm,
    stepPpm: row.step_ppm,
    maxPayoutMinor: row.max_payout_minor,
    openLevel: row.open_level,
    liquidationLevel: row.liquidation_level,
    capLevel: row.cap_level,
    openPrice: Number(row.open_price),
    entryPrice: Number(row.entry_price),
    liquidationPrice: Number(row.liquidation_price),
    capPrice: row.cap_price === null ? null : Number(row.cap_price),
    status: row.status,
    closeLevel: row.close_level,
    closePrice: row.close_price === null ? null : Number(row.close_price),
    payoutMinor: row.payout_minor,
    openedAt: row.created_at.toISOString(),
    settledAt: row.settled_at?.toISOString() ?? null,
  };
}

async function readCommitted<T>(db: Database, work: (client: DbClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && attempt < 2) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      // The chart is public; only the viewer's own positions need a session.
    }
  };
}

export async function registerStocksRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  /* Requests in flight, per player. Opening waits on a per-player lock, and a request waiting on a
   * lock holds a database connection while it waits: twenty-two at once from one player emptied the
   * pool in testing and stalled the sweep and every other request. So the queue lives here, not in
   * the database -- one open at a time per player, a few closes -- and the rest are told to wait. */
  const inFlight = new Map<string, number>();
  async function oneAtATime<T>(key: string, limit: number, work: () => Promise<T>): Promise<T> {
    const running = inFlight.get(key) ?? 0;
    if (running >= limit) throw new AppError(429, 'STOCKS_TOO_FAST', 'Wait for your last order to finish');
    inFlight.set(key, running + 1);
    try {
      return await work();
    } finally {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left > 0) inFlight.set(key, left);
      else inFlight.delete(key);
    }
  }

  /** How many moves a tick makes (lib/stocks.ts, paceOf and tickPlan), published with the rules. */
  const paceRules = {
    blockTicks: STOCKS_PACE_BLOCK_TICKS,
    paces: STOCKS_PACES.map(([chance, moves]) => ({ chance, moves })),
    spikeChance: STOCKS_SPIKE_CHANCE,
    spikeFactor: STOCKS_SPIKE_FACTOR,
  };

  /* ── the epochs ──
   * Kept in memory once built: an epoch's path is some twelve million moves, and every request and
   * every sweep reads it. It is built a few milliseconds at a time (epochPathAsync), once however
   * many ask for it at the same moment, and the sweep builds the next one before it starts. The
   * newest few are kept. */
  const epochs = new Map<number, Epoch>();
  const building = new Map<string, Promise<Epoch>>();

  async function build(row: EpochRow): Promise<Epoch> {
    const seq = Number(row.seq);
    const cached = epochs.get(seq);
    if (cached && cached.row.id === row.id) return cached;
    const pending = building.get(row.id);
    if (pending) return pending;
    const job = (async () => {
      const seed = decryptSecret(row.server_seed_ciphertext, config.dataEncryptionKey, `stocks:${row.id}`);
      if (hashServerSeed(seed) !== row.server_seed_hash) throw new Error('Stocks epoch seed does not match its hash');
      const start = row.starts_at.getTime();
      const epoch: Epoch = {
        row,
        seq,
        start,
        end: start + row.ticks * row.tick_ms,
        seed,
        path: await epochPathAsync(seed, row.id, row.start_level, row.ticks, row.step_ppm),
      };
      epochs.set(seq, epoch);
      for (const key of [...epochs.keys()].sort((a, b) => a - b).slice(0, Math.max(0, epochs.size - 8))) {
        epochs.delete(key);
      }
      return epoch;
    })();
    building.set(row.id, job);
    try {
      return await job;
    } finally {
      building.delete(row.id);
    }
  }

  async function epochBySeq(client: DbClient | Database, seq: number): Promise<Epoch | null> {
    const cached = epochs.get(seq);
    if (cached) return cached;
    const result = await client.query<EpochRow>('SELECT * FROM stocks_epochs WHERE seq = $1', [seq]);
    return result.rows[0] ? build(result.rows[0]) : null;
  }

  /** The epoch covering `at`, if there is one. */
  async function epochAt(client: DbClient | Database, at: Date): Promise<Epoch | null> {
    for (const epoch of epochs.values()) if (epoch.start <= at.getTime() && at.getTime() < epoch.end) return epoch;
    const result = await client.query<EpochRow>(
      `SELECT * FROM stocks_epochs
        WHERE starts_at <= $1 AND starts_at + make_interval(secs => ticks * tick_ms / 1000.0) > $1
        ORDER BY seq DESC LIMIT 1`,
      [at],
    );
    return result.rows[0] ? build(result.rows[0]) : null;
  }

  function insertEpoch(client: DbClient, seq: number, startsAt: Date, startLevel: number) {
    const id = randomUUID();
    const seed = generateServerSeed();
    return client.query(
      `INSERT INTO stocks_epochs
         (id, seq, starts_at, tick_ms, ticks, step_ppm, start_level, server_seed_hash, server_seed_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [
        id,
        seq,
        startsAt,
        STOCKS_TICK_MS,
        STOCKS_EPOCH_TICKS,
        STOCKS_STEP_PPM,
        startLevel,
        hashServerSeed(seed),
        encryptSecret(seed, config.dataEncryptionKey, `stocks:${id}`),
      ],
    );
  }

  /**
   * Makes sure an epoch covers now and the next one is already committed. Chains them end to end;
   * after downtime long enough that the chain fell behind, starts again from now at the last level
   * (the chart stood still while nothing was running, and so did every position on it).
   */
  async function ensureEpochs(): Promise<void> {
    await readCommitted(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('stocks:epochs', 9311))");
      const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = clock.rows[0]!.now.getTime();
      let latest = (await client.query<EpochRow>('SELECT * FROM stocks_epochs ORDER BY seq DESC LIMIT 1')).rows[0];
      if (!latest) {
        await insertEpoch(client, 0, new Date(Math.floor(now / 1000) * 1000), 0);
        latest = (await client.query<EpochRow>('SELECT * FROM stocks_epochs ORDER BY seq DESC LIMIT 1')).rows[0]!;
      }
      for (let guard = 0; guard < 3; guard += 1) {
        // Keep one epoch ahead: the next hash is out before the current epoch ends. Read from the
        // row: building an epoch's path only to learn when it starts would be twelve million moves.
        if (latest.starts_at.getTime() > now) return;
        const last = await build(latest);
        const endLevel = last.path.close[last.path.close.length - 1]!;
        const startsAt = last.end >= now - last.row.tick_ms ? new Date(last.end) : new Date(Math.ceil(now / STOCKS_TICK_MS) * STOCKS_TICK_MS);
        await insertEpoch(client, last.seq + 1, startsAt, endLevel);
        latest = (await client.query<EpochRow>('SELECT * FROM stocks_epochs ORDER BY seq DESC LIMIT 1')).rows[0]!;
      }
    });
  }

  /** Where the chart is at the database's `now`: the epoch and tick, and the level there. */
  async function locate(client: DbClient | Database, now: Date): Promise<{ epoch: Epoch; ref: TickRef; level: number }> {
    const epoch = await epochAt(client, now);
    if (!epoch) throw new AppError(503, 'STOCKS_WARMING_UP', 'The market is opening, try again in a moment');
    const tick = Math.min(epoch.row.ticks - 1, Math.floor((now.getTime() - epoch.start) / epoch.row.tick_ms));
    return { epoch, ref: { seq: epoch.seq, tick }, level: epoch.path.close[tick]! };
  }

  /**
   * The first tick after `from` and up to `to` (both included bounds as noted) that ends the
   * position on its own, if any.
   */
  async function firstOutcome(
    client: DbClient | Database,
    position: Position,
    from: TickRef, // exclusive
    to: TickRef, // inclusive
  ): Promise<{ outcome: Outcome; ref: TickRef; level: number } | null> {
    for (let seq = from.seq; seq <= to.seq; seq += 1) {
      const epoch = await epochBySeq(client, seq);
      if (!epoch) continue; // a gap after downtime: no ticks happened
      const first = seq === from.seq ? from.tick + 1 : 0;
      const last = seq === to.seq ? to.tick : epoch.row.ticks - 1;
      const { close, low, high } = epoch.path;
      for (let tick = first; tick <= last; tick += 1) {
        const outcome = outcomeInTick(position, low[tick]!, high[tick]!, () =>
          tickMoves(epoch.seed, epoch.row.id, tick, tick === 0 ? epoch.row.start_level : close[tick - 1]!, epoch.row.step_ppm),
        );
        if (outcome) {
          const level = outcome === 'liquidated' ? position.liquidationLevel : position.capLevel!;
          return { outcome, ref: { seq, tick }, level };
        }
      }
    }
    return null;
  }

  /** Ends a locked, open position. Null when another path got there first. */
  async function settle(
    client: DbClient,
    row: PositionRow,
    status: 'closed' | Outcome,
    ref: TickRef,
    level: number,
  ): Promise<PositionRow | null> {
    const position = asPosition(row);
    const payout =
      status === 'liquidated' ? 0n : status === 'capped' ? position.maxPayoutMinor : payoutAt(position, level, row.step_ppm);
    const updated = await client.query<PositionRow>(
      `UPDATE stocks_positions
          SET status = $2, close_level = $3, close_price = $4, closed_epoch = $5, closed_tick = $6,
              payout_minor = $7, settled_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING *`,
      [row.id, status, level, priceAt(level, row.step_ppm).toFixed(10), ref.seq, ref.tick, payout.toString()],
    );
    const settled = updated.rows[0] ?? null;
    if (settled && payout > 0n) await creditWallet(client, row.user_id, payout, 'stocks_payout', row.id);
    return settled;
  }

  async function sweepWatermark(client: DbClient | Database): Promise<TickRef | null> {
    const result = await client.query<{ epoch: string; tick: number }>('SELECT epoch, tick FROM stocks_sweep WHERE id = 1');
    const row = result.rows[0];
    return row ? { seq: Number(row.epoch), tick: row.tick } : null;
  }

  function publicConfig() {
    return {
      enabled: config.stocksEnabled,
      edgeBps: STOCKS_EDGE_BPS,
      minStakeMinor: config.stocksMinStakeMinor.toString(),
      maxStakeMinor: config.stocksMaxStakeMinor.toString(),
      maxPayoutMinor: config.stocksMaxPayoutMinor.toString(),
      minLeverage: STOCKS_MIN_LEVERAGE,
      maxLeverage: config.stocksMaxLeverage,
      tickMs: STOCKS_TICK_MS,
      stepPpm: STOCKS_STEP_PPM,
      pace: paceRules,
      basePrice: STOCKS_BASE_PRICE,
    };
  }

  /** The close, low and high of the `count` ticks up to and including `to`, oldest first. */
  async function history(client: DbClient | Database, to: TickRef, count: number) {
    const levels: number[] = [];
    const lows: number[] = [];
    const highs: number[] = [];
    let ref = to;
    while (levels.length < count) {
      const epoch = await epochBySeq(client, ref.seq);
      if (!epoch) break;
      for (let tick = ref.tick; tick >= 0 && levels.length < count; tick -= 1) {
        levels.push(epoch.path.close[tick]!);
        lows.push(epoch.path.low[tick]!);
        highs.push(epoch.path.high[tick]!);
      }
      if (ref.seq === 0) break;
      const previous = await epochBySeq(client, ref.seq - 1);
      if (!previous) break;
      ref = { seq: previous.seq, tick: previous.row.ticks - 1 };
    }
    return { close: levels.reverse(), low: lows.reverse(), high: highs.reverse() };
  }

  /** Settled positions as the strip on the stage shows them: the newest twelve, or the ones named. */
  async function feedRows(ids?: readonly string[]) {
    const select = `SELECT p.id, u.id AS player_id, ${maskedName('u.minecraft_username')} AS player, p.side, p.leverage,
                            p.stake_minor, p.status, p.payout_minor, p.settled_at
                       FROM stocks_positions p JOIN users u ON u.id = p.user_id`;
    const result = ids
      ? await db.query<FeedRow>(`${select} WHERE p.id = ANY($1::uuid[]) AND p.settled_at IS NOT NULL ORDER BY p.settled_at DESC`, [ids])
      : await db.query<FeedRow>(`${select} WHERE p.settled_at IS NOT NULL ORDER BY p.settled_at DESC LIMIT 12`);
    return result.rows.map((row) => ({
      id: row.id,
      playerId: row.player_id,
      player: row.player,
      side: row.side,
      leverage: row.leverage,
      stakeMinor: row.stake_minor,
      status: row.status,
      payoutMinor: row.payout_minor,
      settledAt: row.settled_at.toISOString(),
    }));
  }

  app.get(
    '/v1/stocks',
    { preHandler: softAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const viewerId = request.authUser?.id ?? null;
      const query = parseWith(z.object({ span: z.coerce.number().int().min(10).max(6000).optional() }).strict(), request.query ?? {});
      await ensureEpochs();
      const clock = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = clock.rows[0]!.now;
      const here = await locate(db, now);
      const next = await epochBySeq(db, here.epoch.seq + 1).catch(() => null);
      const [mine, feed] = await Promise.all([
        viewerId
          ? db.query<PositionRow>(
              `(SELECT * FROM stocks_positions WHERE user_id = $1 AND status = 'open' ORDER BY created_at DESC)
               UNION ALL
               (SELECT * FROM stocks_positions WHERE user_id = $1 AND status <> 'open' ORDER BY settled_at DESC LIMIT 15)`,
            [viewerId],
          )
          : Promise.resolve({ rows: [] as PositionRow[] }),
        feedRows(),
      ]);
      return {
        ...publicConfig(),
        serverNow: now.toISOString(),
        now: { seq: here.ref.seq, tick: here.ref.tick, level: here.level },
        epoch: {
          id: here.epoch.row.id,
          seq: here.epoch.seq,
          startsAt: here.epoch.row.starts_at.toISOString(),
          ticks: here.epoch.row.ticks,
          serverSeedHash: here.epoch.row.server_seed_hash,
        },
        nextEpoch: next ? { seq: next.seq, startsAt: next.row.starts_at.toISOString(), serverSeedHash: next.row.server_seed_hash } : null,
        history: await history(db, here.ref, query.span ?? HISTORY_TICKS),
        positions: mine.rows.map(positionView),
        feed,
      };
    },
  );

  /** Past epochs with their seeds, for anyone checking the chart (lib/stocks.ts has the recipe). */
  app.get('/v1/stocks/epochs', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => {
    const result = await db.query<EpochRow>(
      'SELECT * FROM stocks_epochs WHERE server_seed_reveal IS NOT NULL ORDER BY seq DESC LIMIT 30',
    );
    return {
      epochs: result.rows.map((row) => ({
        id: row.id,
        seq: Number(row.seq),
        startsAt: row.starts_at.toISOString(),
        tickMs: row.tick_ms,
        ticks: row.ticks,
        stepPpm: row.step_ppm,
        pace: paceRules,
        startLevel: row.start_level,
        serverSeedHash: row.server_seed_hash,
        serverSeed: row.server_seed_reveal,
      })),
    };
  });

  app.post(
    '/v1/stocks/positions',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
      if (!config.stocksEnabled) throw new AppError(409, 'STOCKS_CLOSED', 'Stocks is closed right now');
      const body = parseWith(openSchema, request.body);
      const stake = BigInt(body.stakeMinor);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      if (stake < config.stocksMinStakeMinor || stake > config.stocksMaxStakeMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_BAND', 'That stake is outside the Stocks limits');
      }
      if (stake >= config.stocksMaxPayoutMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_BAND', 'That stake is outside the Stocks limits');
      }
      if (body.leverage > config.stocksMaxLeverage) {
        throw new AppError(400, 'LEVERAGE_TOO_HIGH', `The most leverage is ${config.stocksMaxLeverage}x`);
      }
      await ensureEpochs();

      const placed = await oneAtATime(`open:${userId}`, 1, () => db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 9311))', [`${userId}:${idempotencyKey}`]);
        const replayed = await client.query<PositionRow>(
          'SELECT * FROM stocks_positions WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (replayed.rows[0]) {
          if (replayed.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different position');
          }
          return { row: replayed.rows[0], balanceAfterMinor: null, replay: true };
        }
        await assertGameEligible(client, userId);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 9311))', [`stocks-open:${userId}`]);
        const count = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM stocks_positions WHERE user_id = $1 AND status = 'open'",
          [userId],
        );
        if ((count.rows[0]?.n ?? 0) >= MAX_OPEN_PER_PLAYER) {
          conflict('TOO_MANY_POSITIONS', `You can hold ${MAX_OPEN_PER_PLAYER} positions at once`);
        }

        // The price is the one the database clock is at, read inside this transaction.
        const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        const here = await locate(client, clock.rows[0]!.now);
        let opened;
        try {
          opened = openPosition({
            side: body.side,
            stakeMinor: stake,
            leverage: body.leverage,
            openLevel: here.level,
            maxPayoutMinor: config.stocksMaxPayoutMinor,
          }, here.epoch.row.step_ppm);
        } catch {
          throw new AppError(400, 'POSITION_REFUSED', 'That position does not fit the market');
        }

        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 AND balance_minor >= $2 RETURNING balance_minor`,
          [userId, stake.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for that position');

        const id = randomUUID();
        const inserted = await client.query<PositionRow>(
          `INSERT INTO stocks_positions
             (id, user_id, idempotency_key, request_hash, side, stake_minor, leverage, fee_ppm,
              max_payout_minor, open_level, liquidation_level, cap_level, open_price, entry_price,
              liquidation_price, cap_price, opened_epoch, opened_tick, step_ppm)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING *`,
          [
            id,
            userId,
            idempotencyKey,
            requestHash,
            body.side,
            stake.toString(),
            body.leverage,
            opened.feePpm,
            opened.maxPayoutMinor.toString(),
            opened.openLevel,
            opened.liquidationLevel,
            opened.capLevel,
            opened.openPrice.toFixed(10),
            opened.entryPrice.toFixed(10),
            opened.liquidationPrice.toFixed(10),
            opened.capPrice === null ? null : opened.capPrice.toFixed(10),
            here.ref.seq,
            here.ref.tick,
            here.epoch.row.step_ppm,
          ],
        );
        await client.query(
          `INSERT INTO wallet_transactions (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'stocks_stake', $5)`,
          [randomUUID(), userId, (-stake).toString(), balanceAfter, id],
        );
        /* The stake is the wager; the margin is the game's own edge on it, so rakeback and the
         * referral share follow what Stocks actually keeps. */
        await recordWager(
          client,
          config,
          userId,
          stake,
          'stocks',
          id,
          ['wagered_minor'],
          (stake * BigInt(STOCKS_EDGE_BPS)) / 10_000n,
        );
        return { row: inserted.rows[0]!, balanceAfterMinor: balanceAfter, replay: false };
      }, 8));
      liveEvents.publish('stocks', [userId]);
      liveEvents.publish('balance', [userId]);
      return reply.code(placed.replay ? 200 : 201).send({
        position: positionView(placed.row),
        balanceAfterMinor: placed.balanceAfterMinor,
        replay: placed.replay,
      });
    },
  );

  /* Closing always works, Stocks open or not: switching the game off must never trap a stake. */
  app.post(
    '/v1/stocks/close',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
      const body = parseWith(closeSchema, request.body);
      await ensureEpochs();
      const result = await oneAtATime(`close:${userId}`, 3, () => readCommitted(db, async (client) => {
        const locked = await client.query<PositionRow>(
          'SELECT * FROM stocks_positions WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [body.positionId, userId],
        );
        const row = locked.rows[0];
        if (!row) throw new AppError(404, 'NO_POSITION', 'That position is not yours');
        if (row.status !== 'open') return row; // asked twice, answered twice
        // The clock is read after the lock, so a close that waited is judged when it actually ran.
        const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        const here = await locate(client, clock.rows[0]!.now);
        const opened: TickRef = { seq: Number(row.opened_epoch), tick: row.opened_tick };
        const swept = await sweepWatermark(client);
        const from = swept && before(opened, swept) ? swept : opened;
        const ended = before(from, here.ref) ? await firstOutcome(client, asPosition(row), from, here.ref) : null;
        const settled = ended
          ? await settle(client, row, ended.outcome, ended.ref, ended.level)
          : await settle(client, row, 'closed', here.ref, here.level);
        return settled ?? row;
      }));
      const balance = await db.query<{ balance_minor: string }>('SELECT balance_minor FROM user_wallets WHERE user_id = $1', [userId]);
      liveEvents.publish('stocks', [userId]);
      liveEvents.publish('balance', [userId]);
      liveEvents.publish('activity');
      liveEvents.publishData('stocks_feed', { rows: await feedRows([result.id]) });
      return { position: positionView(result), balanceAfterMinor: balance.rows[0]?.balance_minor ?? null };
    },
  );

  /* ── the sweep ──
   * Four times a second: keeps the epochs ahead, publishes the ticks the database clock has reached,
   * ends every position a tick has liquidated or capped, records how far it checked, and reveals
   * the seeds of epochs that have ended. Correctness never depends on its timing: a close checks
   * whatever it has not reached (see the top of the file). */
  if (typeof app.addHook === 'function') {
    let running = false;
    let closed = false;
    let lastSent: TickRef | null = null;
    let lastEnsure = 0;
    /* The database clock, as an offset from this process's. Measured at every sweep, and measured low
     * on purpose: the clock is read inside the query and compared with the time the answer arrived,
     * so the estimate below can only run behind the database, never ahead of it. */
    let clockOffset: number | null = null;
    let broadcasting = false;

    /* The chart, tick by tick (the owner: "it looks so laggy"). Every 50ms, from memory: the ticks
     * the database clock has reached, 15ms behind it for margin. A browser therefore never holds a
     * price a request could not already act on. */
    const broadcast = async () => {
      if (broadcasting || closed || clockOffset === null) return;
      broadcasting = true;
      try {
        const here = await locate(db, new Date(Date.now() + clockOffset - 15));
        if (!lastSent || before(lastSent, here.ref)) {
          // Every tick since the last push, across an epoch's end too, so a browser never has to reload.
          const missed = !lastSent
            ? 1
            : lastSent.seq === here.ref.seq
              ? here.ref.tick - lastSent.tick
              : lastSent.seq + 1 === here.ref.seq
                ? here.ref.tick + 1 + Math.max(0, here.epoch.row.ticks - 1 - lastSent.tick)
                : 1;
          const fresh = await history(db, here.ref, Math.min(40, missed));
          liveEvents.publishData('stocks_tick', { seq: here.ref.seq, tick: here.ref.tick, levels: fresh.close, lows: fresh.low, highs: fresh.high });
          lastSent = here.ref;
        }
      } catch {
        // The sweep logs anything wrong with the market; a missed broadcast is caught up on the next.
      } finally {
        broadcasting = false;
      }
    };

    const sweep = async () => {
      if (running || closed) return;
      running = true;
      try {
        if (Date.now() - lastEnsure > 5_000) {
          await ensureEpochs();
          lastEnsure = Date.now();
        }
        const clock = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        clockOffset = clock.rows[0]!.now.getTime() - Date.now();
        const here = await locate(db, clock.rows[0]!.now);
        if (!epochs.has(here.ref.seq + 1)) void epochBySeq(db, here.ref.seq + 1).catch(() => null);

        // Liquidations and caps.
        let watermark = await sweepWatermark(db);
        if (!watermark) {
          await db.query('INSERT INTO stocks_sweep (id, epoch, tick) VALUES (1, $1, $2) ON CONFLICT DO NOTHING', [here.ref.seq, here.ref.tick]);
          watermark = here.ref;
        }
        if (before(watermark, here.ref)) {
          const open = await db.query<PositionRow>("SELECT * FROM stocks_positions WHERE status = 'open'");
          const ended: string[] = [];
          const endedIds: string[] = [];
          for (const row of open.rows) {
            const opened: TickRef = { seq: Number(row.opened_epoch), tick: row.opened_tick };
            const from = before(opened, watermark) ? watermark : opened;
            if (!before(from, here.ref)) continue;
            const hit = await firstOutcome(db, asPosition(row), from, here.ref);
            if (!hit) continue;
            const settled = await readCommitted(db, async (client) => {
              const locked = await client.query<PositionRow>('SELECT * FROM stocks_positions WHERE id = $1 FOR UPDATE', [row.id]);
              const current = locked.rows[0];
              return current && current.status === 'open' ? settle(client, current, hit.outcome, hit.ref, hit.level) : null;
            });
            if (settled) {
              ended.push(settled.user_id);
              endedIds.push(settled.id);
            }
          }
          await db.query('UPDATE stocks_sweep SET epoch = $1, tick = $2, updated_at = now() WHERE id = 1', [here.ref.seq, here.ref.tick]);
          if (ended.length > 0) {
            liveEvents.publish('stocks', ended);
            liveEvents.publish('balance', ended);
            liveEvents.publish('activity');
            liveEvents.publishData('stocks_feed', { rows: await feedRows(endedIds) });
          }
        }

        // Seeds of epochs that have ended.
        const reveal = await db.query<EpochRow>(
          'SELECT * FROM stocks_epochs WHERE seq < $1 AND server_seed_reveal IS NULL ORDER BY seq LIMIT 5',
          [here.ref.seq],
        );
        for (const row of reveal.rows) {
          const seed = decryptSecret(row.server_seed_ciphertext, config.dataEncryptionKey, `stocks:${row.id}`);
          await db.query('UPDATE stocks_epochs SET server_seed_reveal = $2 WHERE id = $1 AND server_seed_reveal IS NULL', [row.id, seed]);
        }
      } catch (error) {
        app.log.error({ err: error }, 'Stocks sweep failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void sweep(), 250);
    timer.unref?.();
    const ticker = setInterval(() => void broadcast(), 50);
    ticker.unref?.();
    app.addHook('onClose', async () => {
      closed = true;
      clearInterval(timer);
      clearInterval(ticker);
    });
  }
}
