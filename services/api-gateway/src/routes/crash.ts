import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, recordWager, type WagerOutcome } from '../lib/cash-settlement.js';
import {
  CRASH_GROWTH_PER_SECOND,
  CRASH_HOUSE_EDGE_BPS,
  CRASH_MAX_MULTIPLIER_X100,
  CRASH_MIN_TARGET_X100,
  crashPoint,
  effectiveTarget,
  limitFor,
  multiplierAt,
  payoutAt,
  secondsToReach,
} from '../lib/crash.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { announceWin } from '../lib/discord-flex.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { liveEvents } from '../lib/live-events.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Crash: the shared round, its bets and its cash-outs.
 *
 * ── what makes it safe ──
 * Every decision is made against the database clock and the round's stored timestamps, never
 * against a timer in this process. A cash-out is judged by `clock_timestamp() < crashes_at` after
 * its bet row is locked; the settlement that marks bets lost takes the same row locks, so a bet can
 * be paid or lost but never both, and never twice (the ledger is unique on kind + reference too).
 *
 * The scheduler at the bottom only has to be roughly on time. If it stalls, the next request that
 * reads the round settles whatever is due, and a late settlement cannot change who won: auto
 * cash-outs are paid at their target whenever that target is at or below the crash point.
 *
 * ── what the browser is told ──
 * The committed seed hash and the start time, before the round. The crash point and the seed only
 * once the curve has passed it. `crashes_at` is never sent while the round is live.
 */

const betSchema = z
  .object({
    roundId: z.uuid(),
    stakeMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
    autoCashoutX100: z
      .number()
      .int()
      .min(CRASH_MIN_TARGET_X100)
      .max(CRASH_MAX_MULTIPLIER_X100)
      .nullable()
      .optional(),
  })
  .strict();

const cashoutSchema = z.object({ roundId: z.uuid() }).strict();

interface RoundRow {
  id: string;
  status: 'open' | 'settled';
  server_seed_hash: string;
  server_seed_ciphertext: string;
  server_seed_reveal: string | null;
  house_edge_bps: number;
  crash_point_x100: number;
  created_at: Date;
  started_at: Date;
  crashes_at: Date;
  settled_at: Date | null;
  total_staked_minor: string;
  total_payout_minor: string;
  bet_count: number;
}

/** A round read together with the database's clock, so every phase decision uses one clock. */
type ClockedRound = RoundRow & { db_now: Date };

interface BetRow {
  id: string;
  round_id: string;
  user_id: string;
  stake_minor: string;
  auto_cashout_x100: number | null;
  limit_x100: number;
  status: 'active' | 'cashed_out' | 'lost';
  cashout_x100: number | null;
  cashed_out_by: 'player' | 'auto' | null;
  payout_minor: string | null;
  idempotency_key: string;
  request_hash: string;
  created_at: Date;
  settled_at: Date | null;
}

interface PublicBetRow {
  id: string;
  player_id: string;
  player: string;
  stake_minor: string;
  status: BetRow['status'];
  cashout_x100: number | null;
  payout_minor: string | null;
}

/** A bet that was just paid, for the notifications sent after the transaction commits. */
interface Paid {
  userId: string;
  username: string | null;
  stakeMinor: bigint;
  payoutMinor: bigint;
  cashoutX100: number;
}

type Phase = 'betting' | 'running' | 'crashed';

function phaseOf(round: ClockedRound): Phase {
  const now = round.db_now.getTime();
  if (now < round.started_at.getTime()) return 'betting';
  if (now < round.crashes_at.getTime()) return 'running';
  return 'crashed';
}

function roundView(round: ClockedRound) {
  const phase = round.status === 'settled' ? 'crashed' : phaseOf(round);
  const busted = phase === 'crashed';
  return {
    id: round.id,
    phase,
    startedAt: round.started_at.toISOString(),
    serverSeedHash: round.server_seed_hash,
    // Only once the curve has passed it. Before that, this is the one secret the round keeps.
    crashPointX100: busted ? round.crash_point_x100 : null,
    crashedAt: busted ? round.crashes_at.toISOString() : null,
    serverSeed: round.server_seed_reveal,
  };
}

function historyView(round: RoundRow) {
  return {
    id: round.id,
    crashPointX100: round.crash_point_x100,
    startedAt: round.started_at.toISOString(),
    crashedAt: round.crashes_at.toISOString(),
    serverSeedHash: round.server_seed_hash,
    serverSeed: round.server_seed_reveal,
    houseEdgeBps: round.house_edge_bps,
    betCount: round.bet_count,
  };
}

function betView(row: BetRow) {
  return {
    id: row.id,
    roundId: row.round_id,
    stakeMinor: row.stake_minor,
    autoCashoutX100: row.auto_cashout_x100,
    limitX100: row.limit_x100,
    targetX100: effectiveTarget(row.auto_cashout_x100, row.limit_x100),
    status: row.status,
    cashoutX100: row.cashout_x100,
    cashedOutBy: row.cashed_out_by,
    payoutMinor: row.payout_minor,
    createdAt: row.created_at.toISOString(),
  };
}

function publicBetView(row: PublicBetRow, viewerId: string | null) {
  return {
    id: row.id,
    playerId: row.player_id,
    player: row.player,
    stakeMinor: row.stake_minor,
    status: row.status,
    cashoutX100: row.cashout_x100,
    payoutMinor: row.payout_minor,
    isViewer: viewerId === row.player_id,
  };
}

async function createRound(client: DbClient, config: AppConfig): Promise<ClockedRound> {
  const id = randomUUID();
  const seed = generateServerSeed();
  const { crashPointX100 } = crashPoint(seed, id, CRASH_HOUSE_EDGE_BPS);
  const inserted = await client.query<ClockedRound>(
    `INSERT INTO crash_rounds
       (id, server_seed_hash, server_seed_ciphertext, house_edge_bps, crash_point_x100,
        started_at, crashes_at)
     VALUES ($1, $2, $3, $4, $5,
             clock_timestamp() + make_interval(secs => $6::double precision),
             clock_timestamp() + make_interval(secs => $6::double precision + $7::double precision))
     RETURNING *, clock_timestamp() AS db_now`,
    [
      id,
      hashServerSeed(seed),
      encryptSecret(seed, config.dataEncryptionKey, `crash:${id}`),
      CRASH_HOUSE_EDGE_BPS,
      crashPointX100,
      config.crashBettingSeconds,
      secondsToReach(crashPointX100),
    ],
  );
  const round = inserted.rows[0];
  if (!round) throw new Error('Crash round insert returned no row');
  return round;
}

/**
 * Marks one bet cashed out and pays it. Null when the bet was no longer active -- another path got
 * there first -- in which case nothing is paid.
 */
async function cashOut(
  client: DbClient,
  bet: BetRow,
  multiplierX100: number,
  by: 'player' | 'auto',
): Promise<BetRow | null> {
  const payout = payoutAt(BigInt(bet.stake_minor), multiplierX100);
  const updated = await client.query<BetRow>(
    `UPDATE crash_bets
        SET status = 'cashed_out', cashout_x100 = $2, cashed_out_by = $3, payout_minor = $4,
            settled_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [bet.id, multiplierX100, by, payout.toString()],
  );
  const row = updated.rows[0];
  if (!row) return null;
  if (payout > 0n) await creditWallet(client, bet.user_id, payout, 'crash_payout', bet.id);
  return row;
}

async function usernames(client: DbClient, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const result = await client.query<{ id: string; minecraft_username: string }>(
    'SELECT id, minecraft_username FROM users WHERE id = ANY($1::uuid[])',
    [userIds],
  );
  return new Map(result.rows.map((row) => [row.id, row.minecraft_username]));
}

async function paidList(client: DbClient, rows: BetRow[]): Promise<Paid[]> {
  const names = await usernames(client, rows.map((row) => row.user_id));
  return rows.map((row) => ({
    userId: row.user_id,
    username: names.get(row.user_id) ?? null,
    stakeMinor: BigInt(row.stake_minor),
    payoutMinor: BigInt(row.payout_minor ?? '0'),
    cashoutX100: row.cashout_x100 ?? 100,
  }));
}

interface Settlement {
  roundId: string;
  paid: Paid[];
  userIds: string[];
}

/** Busts a round whose time has passed: pays every target at or below the crash point, loses the rest. */
async function settleRound(
  client: DbClient,
  config: AppConfig,
  round: ClockedRound,
): Promise<Settlement> {
  const seed = decryptSecret(round.server_seed_ciphertext, config.dataEncryptionKey, `crash:${round.id}`);
  if (hashServerSeed(seed) !== round.server_seed_hash) {
    throw new Error(`Crash seed commitment mismatch for ${round.id}`);
  }
  // The stored point is re-derived from the seed, so a row altered after the commitment is caught
  // here rather than settled.
  if (crashPoint(seed, round.id, round.house_edge_bps).crashPointX100 !== round.crash_point_x100) {
    throw new Error(`Crash point does not match its seed for ${round.id}`);
  }
  const bets = await client.query<BetRow>(
    'SELECT * FROM crash_bets WHERE round_id = $1 ORDER BY id FOR UPDATE',
    [round.id],
  );
  const winners: BetRow[] = [];
  let totalStaked = 0n;
  let totalPayout = 0n;
  for (const bet of bets.rows) {
    totalStaked += BigInt(bet.stake_minor);
    if (bet.status === 'active') {
      const target = effectiveTarget(bet.auto_cashout_x100, bet.limit_x100);
      if (target <= round.crash_point_x100) {
        const paid = await cashOut(client, bet, target, 'auto');
        if (paid) {
          winners.push(paid);
          totalPayout += BigInt(paid.payout_minor ?? '0');
        }
      } else {
        await client.query(
          `UPDATE crash_bets SET status = 'lost', payout_minor = 0, settled_at = now()
            WHERE id = $1 AND status = 'active'`,
          [bet.id],
        );
      }
    } else {
      totalPayout += BigInt(bet.payout_minor ?? '0');
    }
  }
  await client.query(
    `UPDATE crash_rounds
        SET status = 'settled', server_seed_reveal = $2, settled_at = now(),
            total_staked_minor = $3, total_payout_minor = $4, bet_count = $5
      WHERE id = $1 AND status = 'open'`,
    [round.id, seed, totalStaked.toString(), totalPayout.toString(), bets.rows.length],
  );
  return {
    roundId: round.id,
    paid: await paidList(client, winners),
    userIds: [...new Set(bets.rows.map((bet) => bet.user_id))],
  };
}

/**
 * Runs `work` at READ COMMITTED, retrying a deadlock.
 *
 * The app's own transactions are SERIALIZABLE, and that is wrong for the three paths here that only
 * move money through the wallet: the bust, the auto cash-outs and a player's cash-out. Their
 * correctness comes from explicit row locks, and a SERIALIZABLE snapshot is taken BEFORE a lock is
 * waited on -- so a bust that queued behind a bet still in flight would not see that bet once it
 * committed, and could leave it active in a settled round. At READ COMMITTED every statement sees
 * everything committed before it, and a row re-read after a lock wait is the row as it now is.
 *
 * Placing a bet stays SERIALIZABLE: it runs the wager hooks (the jackpot draw among them), which
 * were written for it.
 */
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

/** The open round as it stands, with the database's clock, read without a lock. */
async function readOpenRound(client: DbClient): Promise<ClockedRound | null> {
  const visible = await client.query<ClockedRound>(
    `SELECT *, clock_timestamp() AS db_now FROM crash_rounds
      WHERE status = 'open' ORDER BY created_at LIMIT 1`,
  );
  return visible.rows[0] ?? null;
}

/** There is no open round, or the open one's bust time has passed. */
function needsAdvance(round: ClockedRound | null): boolean {
  return !round || round.db_now.getTime() >= round.crashes_at.getTime();
}

/**
 * Busts the open round if its time has passed, and opens the next one. Null round only when crash
 * is closed and nothing is left to finish.
 *
 * `createNext` is false while crash is switched off: a round already running still busts and pays,
 * no new one opens.
 */
async function advance(
  db: Database,
  config: AppConfig,
  createNext: boolean,
): Promise<{ round: ClockedRound | null; settled: Settlement | null }> {
  return readCommitted(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('crash:shared-round', 8831))");
    /* FOR UPDATE waits for every bet still holding its share lock on the round, so by the time
     * this returns, every bet that got in before the close has committed -- and at READ COMMITTED
     * the settlement below sees all of them. */
    const selected = await client.query<RoundRow>(
      `SELECT * FROM crash_rounds WHERE status = 'open' ORDER BY created_at LIMIT 1 FOR UPDATE`,
    );
    const locked = selected.rows[0];
    if (!locked) {
      return { round: createNext ? await createRound(client, config) : null, settled: null };
    }
    // The clock is read after the lock is held, never before it.
    const clock = await client.query<{ db_now: Date }>('SELECT clock_timestamp() AS db_now');
    const round: ClockedRound = { ...locked, db_now: clock.rows[0]?.db_now ?? new Date() };
    if (round.db_now.getTime() < round.crashes_at.getTime()) return { round, settled: null };

    const settled = await settleRound(client, config, round);
    return { round: createNext ? await createRound(client, config) : null, settled };
  });
}

/** Pays every auto cash-out the curve has already passed. Run by the scheduler while a round is live. */
async function payDueTargets(client: DbClient, round: ClockedRound): Promise<Paid[]> {
  const clock = await client.query<{ elapsed: number; alive: boolean }>(
    `SELECT extract(epoch FROM clock_timestamp() - started_at)::float8 AS elapsed,
            clock_timestamp() < crashes_at AS alive
       FROM crash_rounds WHERE id = $1 AND status = 'open'`,
    [round.id],
  );
  const now = clock.rows[0];
  if (!now?.alive || now.elapsed <= 0) return [];
  const reached = Math.min(multiplierAt(now.elapsed), round.crash_point_x100);
  const due = await client.query<BetRow>(
    `SELECT * FROM crash_bets
      WHERE round_id = $1 AND status = 'active'
        AND least(coalesce(auto_cashout_x100, limit_x100), limit_x100) <= $2
      ORDER BY id
      FOR UPDATE`,
    [round.id, reached],
  );
  const paid: BetRow[] = [];
  for (const bet of due.rows) {
    const row = await cashOut(client, bet, effectiveTarget(bet.auto_cashout_x100, bet.limit_x100), 'auto');
    if (row) paid.push(row);
  }
  return paidList(client, paid);
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      // The round and its history are public; only the viewer's own bet needs a session.
    }
  };
}

type Logger = { error: (context: unknown, message: string) => void };

/* After the commit, never inside it, and never awaited: a slow webhook is not a slow payout. */
function announcePaid(config: AppConfig, paid: Paid[], logger: Logger): void {
  for (const bet of paid) {
    if (!bet.username || bet.payoutMinor <= bet.stakeMinor) continue;
    void announceWin(
      config,
      {
        username: bet.username,
        amountMinor: bet.payoutMinor,
        mode: 'Crash',
        multiplier: bet.cashoutX100 / 100,
        path: '/crash',
      },
      logger,
    );
  }
}

function announceJackpot(
  config: AppConfig,
  username: string | undefined,
  wager: WagerOutcome,
  logger: Logger,
): void {
  const win = wager.jackpot.win;
  if (!win || !username) return;
  void announceWin(
    config,
    { username, amountMinor: win.amountMinor, mode: 'Vault Jackpot', path: '/crash' },
    logger,
  );
}

function publishSettlement(settled: Settlement | null): void {
  if (!settled) return;
  liveEvents.publish('crash_bust');
  liveEvents.publish('activity');
  if (settled.userIds.length > 0) liveEvents.publish('balance', settled.userIds);
}

export async function registerCrashRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  function publicConfig() {
    return {
      enabled: config.crashEnabled,
      minStakeMinor: config.crashMinStakeMinor.toString(),
      maxStakeMinor: config.crashMaxStakeMinor.toString(),
      maxPayoutMinor: config.crashMaxPayoutMinor.toString(),
      bettingSeconds: config.crashBettingSeconds,
      houseEdgeBps: CRASH_HOUSE_EDGE_BPS,
      growthPerSecond: CRASH_GROWTH_PER_SECOND,
      minTargetX100: CRASH_MIN_TARGET_X100,
      maxMultiplierX100: CRASH_MAX_MULTIPLIER_X100,
    };
  }

  /* Its own limit. A browser re-reads the round on every bet and cash-out anybody makes, so a busy
   * round is dozens of reads a minute per viewer -- well inside what a single indexed read costs,
   * and well past the API-wide default, which would start refusing players mid-round. */
  app.get(
    '/v1/crash',
    { preHandler: softAuth, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
    const viewerId = request.authUser?.id ?? null;
    let round = await readOpenRound(db);
    let settled: Settlement | null = null;
    if (needsAdvance(round)) ({ round, settled } = await advance(db, config, config.crashEnabled));
    const client = db;
    const view = await (async () => {
      const [history, bets, previousBets, mine] = await Promise.all([
        client.query<RoundRow>(
          `SELECT * FROM crash_rounds WHERE status = 'settled'
            ORDER BY crashes_at DESC LIMIT 24`,
        ),
        round
          ? client.query<PublicBetRow>(
              `SELECT b.id, u.id AS player_id, ${maskedName('u.minecraft_username')} AS player,
                      b.stake_minor::text AS stake_minor, b.status, b.cashout_x100,
                      b.payout_minor::text AS payout_minor
                 FROM crash_bets b JOIN users u ON u.id = b.user_id
                WHERE b.round_id = $1
                ORDER BY b.stake_minor DESC, b.id
                LIMIT 100`,
              [round.id],
            )
          : Promise.resolve({ rows: [] as PublicBetRow[] }),
        client.query<PublicBetRow>(
          `SELECT b.id, u.id AS player_id, ${maskedName('u.minecraft_username')} AS player,
                  b.stake_minor::text AS stake_minor, b.status, b.cashout_x100,
                  b.payout_minor::text AS payout_minor
             FROM crash_bets b JOIN users u ON u.id = b.user_id
            WHERE b.round_id = (
              SELECT id FROM crash_rounds WHERE status = 'settled' ORDER BY crashes_at DESC LIMIT 1
            )
            ORDER BY b.stake_minor DESC, b.id
            LIMIT 100`,
        ),
        viewerId && round
          ? client.query<BetRow>('SELECT * FROM crash_bets WHERE round_id = $1 AND user_id = $2', [
              round.id,
              viewerId,
            ])
          : Promise.resolve({ rows: [] as BetRow[] }),
      ]);
      const clock = round?.db_now ?? (await client.query<{ db_now: Date }>('SELECT clock_timestamp() AS db_now')).rows[0]?.db_now;
      return {
        settled,
        body: {
          serverTime: (clock ?? new Date()).toISOString(),
          round: round ? roundView(round) : null,
          history: history.rows.map(historyView),
          bets: bets.rows.map((row) => publicBetView(row, viewerId)),
          previousBets: previousBets.rows.map((row) => publicBetView(row, viewerId)),
          yourBet: mine.rows[0] ? betView(mine.rows[0]) : null,
          config: publicConfig(),
        },
      };
    })();
    publishSettlement(view.settled);
    if (view.settled) announcePaid(config, view.settled.paid, app.log);
    return view.body;
    },
  );

  app.post(
    '/v1/crash/bets',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
      if (!config.crashEnabled) throw new AppError(409, 'CRASH_CLOSED', 'Crash is closed right now');
      const body = parseWith(betSchema, request.body);
      const stake = BigInt(body.stakeMinor);
      const autoCashout = body.autoCashoutX100 ?? null;
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));

      if (stake < config.crashMinStakeMinor || stake > config.crashMaxStakeMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_BAND', 'That bet is outside the crash limits');
      }
      const limit = limitFor(stake, config.crashMaxPayoutMinor);
      if (limit === null) {
        throw new AppError(400, 'STAKE_OUT_OF_BAND', 'That bet is outside the crash limits');
      }

      // A round that is overdue is busted in its own transaction first; the bet then only has to
      // find the round it named still open.
      const before = await readOpenRound(db);
      if (needsAdvance(before)) {
        const advanced = await advance(db, config, config.crashEnabled);
        publishSettlement(advanced.settled);
        if (advanced.settled) announcePaid(config, advanced.settled.paid, app.log);
      }

      /* Retried up to eight times rather than the default two. A whole table bets in the same last
       * second, and the wager hooks those bets share (jackpot, races, rakeback) conflict under
       * SERIALIZABLE; each retry runs after the conflicting bet has committed, so it succeeds, and
       * a player sees their bet land instead of an error they would have to retry by hand. */
      const placed = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8831))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const replayed = await client.query<BetRow>(
          'SELECT * FROM crash_bets WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (replayed.rows[0]) {
          if (replayed.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different bet');
          }
          return { bet: replayed.rows[0], balanceAfterMinor: null, replay: true, wager: null };
        }

        await assertGameEligible(client, userId);
        /* A share lock lets many players bet at once, but makes the bust wait until every accepted
         * bet has committed -- so a bet can never land in a round that has already been settled. */
        const active = await client.query<RoundRow>(
          `SELECT * FROM crash_rounds WHERE id = $1 AND status = 'open' FOR SHARE`,
          [body.roundId],
        );
        const round = active.rows[0];
        if (!round) conflict('ROUND_CHANGED', 'That round has already started');
        const open = await client.query<{ open: boolean }>(
          'SELECT clock_timestamp() < $1::timestamptz AS open',
          [round.started_at],
        );
        if (!open.rows[0]?.open) conflict('BETTING_CLOSED', 'Bets for this round are closed');

        // One bet per player per round. The per-player lock makes that a decision, not a race
        // between two requests carrying different idempotency keys; the unique key is the backstop.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8831))', [
          `crash-bet:${userId}`,
        ]);
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM crash_bets WHERE round_id = $1 AND user_id = $2',
          [round.id, userId],
        );
        if (existing.rows[0]) conflict('ALREADY_BET', 'You already have a bet in this round');

        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 AND balance_minor >= $2 RETURNING balance_minor`,
          [userId, stake.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) {
          throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for that bet');
        }

        const id = randomUUID();
        const inserted = await client.query<BetRow>(
          `INSERT INTO crash_bets
             (id, round_id, user_id, stake_minor, auto_cashout_x100, limit_x100,
              idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [id, round.id, userId, stake.toString(), autoCashout, limit, idempotencyKey, requestHash],
        );
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'crash_stake', $5)`,
          [randomUUID(), userId, (-stake).toString(), balanceAfter, id],
        );
        /* The round's totals are written once, by the settlement. Counting here would UPDATE a
         * row every concurrent bet holds a share lock on, and two such bets deadlock. */
        const wager = await recordWager(client, config, userId, stake, 'crash', id, ['wagered_minor']);
        const bet = inserted.rows[0];
        if (!bet) throw new Error('Crash bet insert returned no row');
        return { bet, balanceAfterMinor: balanceAfter, replay: false, wager };
      }, 8);
      liveEvents.publish('crash');
      liveEvents.publish('balance', [userId]);
      if (placed.wager) {
        announceJackpot(config, request.authUser?.minecraftUsername, placed.wager, app.log);
      }
      return reply.code(placed.replay ? 200 : 201).send({
        bet: betView(placed.bet),
        balanceAfterMinor: placed.balanceAfterMinor,
        replay: placed.replay,
      });
    },
  );

  app.post(
    '/v1/crash/cashout',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
      const body = parseWith(cashoutSchema, request.body);

      const result = await readCommitted(db, async (client) => {
        // The bet is locked first and the clock read after, so a cash-out that waited on the
        // settlement is judged on the moment it actually ran.
        const locked = await client.query<BetRow>(
          'SELECT * FROM crash_bets WHERE round_id = $1 AND user_id = $2 FOR UPDATE',
          [body.roundId, userId],
        );
        const bet = locked.rows[0];
        if (!bet) throw new AppError(404, 'NO_BET', 'You have no bet in this round');
        // Asked twice, answered twice: the second request gets the first one's result.
        if (bet.status === 'cashed_out') return { bet, paid: null };
        if (bet.status === 'lost') conflict('ROUND_CRASHED', 'Too late — the round crashed');

        const timing = await client.query<RoundRow & { elapsed: number; started: boolean; alive: boolean }>(
          `SELECT *, extract(epoch FROM clock_timestamp() - started_at)::float8 AS elapsed,
                  clock_timestamp() >= started_at AS started,
                  clock_timestamp() < crashes_at AS alive
             FROM crash_rounds WHERE id = $1`,
          [bet.round_id],
        );
        const round = timing.rows[0];
        if (!round || round.status !== 'open') conflict('ROUND_CRASHED', 'Too late — the round crashed');
        if (!round.started) conflict('ROUND_NOT_STARTED', 'The round has not started yet');
        if (!round.alive) conflict('ROUND_CRASHED', 'Too late — the round crashed');

        const target = effectiveTarget(bet.auto_cashout_x100, bet.limit_x100);
        const reached = multiplierAt(round.elapsed);
        // A target the curve already passed was won at the target, whether or not the scheduler
        // had got to it yet. Otherwise the player is paid where the curve is now, which is always
        // below the crash point.
        const [multiplier, by] =
          target <= reached
            ? [target, 'auto' as const]
            : [Math.max(100, Math.min(reached, round.crash_point_x100 - 1)), 'player' as const];
        const row = await cashOut(client, bet, multiplier, by);
        if (!row) conflict('ROUND_CRASHED', 'Too late — the round crashed');
        const [paid] = await paidList(client, [row]);
        return { bet: row, paid: paid ?? null };
      });
      liveEvents.publish('crash');
      liveEvents.publish('balance', [userId]);
      if (result.paid) announcePaid(config, [result.paid], app.log);
      const balance = await db.query<{ balance_minor: string }>(
        'SELECT balance_minor FROM user_wallets WHERE user_id = $1',
        [userId],
      );
      return { bet: betView(result.bet), balanceAfterMinor: balance.rows[0]?.balance_minor ?? null };
    },
  );

  /* ── the scheduler ──
   * Opens rounds, pays auto cash-outs as the curve passes them, and busts each round on time,
   * whether or not anybody has the page open. It ticks every 100ms and wakes on the exact
   * millisecond a round is due to bust, so the bust reaches browsers as soon as it happens.
   * Correctness never depends on it: see the note at the top of this file. */
  if (typeof app.addHook === 'function') {
    let running = false;
    let closed = false;
    let lastRoundId: string | null | undefined;
    let lastPhase: Phase | null = null;
    let bustTimer: NodeJS.Timeout | null = null;

    /* A wake that lands while a tick is still running tries again a few milliseconds later rather
     * than being dropped and left to the next 100ms interval. */
    const armBust = (delay: number) => {
      bustTimer = setTimeout(() => {
        bustTimer = null;
        if (running) armBust(5);
        else void tick();
      }, delay);
      bustTimer.unref?.();
    };

    const tick = async () => {
      if (running || closed) return;
      running = true;
      try {
        const seen = await readOpenRound(db);
        const { round, settled } = needsAdvance(seen)
          ? await advance(db, config, config.crashEnabled)
          : { round: seen, settled: null };
        const paid =
          round && phaseOf(round) === 'running'
            ? await readCommitted(db, async (client) => {
                await client.query(
                  "SELECT pg_advisory_xact_lock(hashtextextended('crash:shared-round', 8831))",
                );
                return payDueTargets(client, round);
              })
            : [];

        publishSettlement(settled);
        if (settled) announcePaid(config, settled.paid, app.log);
        if (paid.length > 0) {
          liveEvents.publish('balance', paid.map((bet) => bet.userId));
          announcePaid(config, paid, app.log);
        }
        const phase = round ? phaseOf(round) : null;
        const changed =
          (lastRoundId !== undefined && (round?.id ?? null) !== lastRoundId) ||
          (round?.id === lastRoundId && phase !== lastPhase);
        if (changed || settled || paid.length > 0) liveEvents.publish('crash');
        lastRoundId = round?.id ?? null;
        lastPhase = phase;

        // Wake exactly on the bust rather than up to one tick after it.
        if (round && phase === 'running' && !bustTimer) {
          const wait = round.crashes_at.getTime() - round.db_now.getTime();
          if (wait < 150) armBust(Math.max(0, wait) + 2);
        }
      } catch (error) {
        app.log.error({ err: error }, 'Crash round tick failed');
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), 100);
    timer.unref?.();
    app.addHook('onClose', async () => {
      closed = true;
      clearInterval(timer);
      if (bustTimer) clearTimeout(bustTimer);
    });
  }
}
