import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { GAME_KINDS, staffPredicate } from './admin-stats.js';
import type { Database, DbClient } from './db.js';
import { AppError } from './errors.js';
import { liveEvents } from './live-events.js';
import { noticeSoon } from './notifications.js';
import { creditWallet } from './wallet.js';
import { assertWagerRequirementMet } from './wager-requirements.js';

/**
 * staking.ts — the house pool: players stake balance and share the house's game result.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEAL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * For every UTC day the house's net result on its games (what players staked minus what they were
 * paid, staff and media test twins left out, read from the ledger) is known exactly once the day
 * is over. The pool gets `stakingShareBps` of it — scaled by how full the pool is against
 * `stakingPoolCapMinor` — and splits that between the stakes that were in for the whole day, in
 * proportion to their size. A good day pays each stake its slice into the wallet; a bad day takes
 * its slice off the stake itself. It is the house's own variance, shared, and nothing about it is
 * guaranteed: a day can lose.
 *
 * Because the share is scaled by the fill, a staked unit earns the same whether the pool holds 1M
 * or 40B: per unit, the result is result * share / cap. A tiny pool therefore cannot hand its first
 * staker the share meant for the whole cap, and the cap is the most the house ever shares.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TIMING
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A day's result is visible while the day is running, so a stake only shares in WHOLE days: it
 * earns from the day after it was made, and after an unstake request it stays in the pool, sharing
 * profit and loss, until it unlocks (48 hours by default). Nobody can step in for a day they watched
 * go well, or step out of one they watched go badly. A day is settled ten minutes after it ends, so
 * a round whose transaction started a moment before midnight has committed by then.
 *
 * Money that still owes wagering (a bonus) cannot be staked: otherwise a sign-up bonus could sit in
 * the pool earning without ever being played. Each settled day is one row, written in the same
 * transaction that pays or charges every stake, so a day cannot be settled twice.
 */

const GAME_KINDS_SQL = GAME_KINDS.map((kind) => `'${kind}'`).join(', ');
const DAY_MS = 86_400_000;
/** A day is settled this long after it ends. */
export const SETTLE_DELAY_MS = 10 * 60_000;
/** Catching up after downtime, a pass settles at most this many days. */
export const MAX_DAYS_PER_PASS = 7;

export const utcDay = (at: Date) => at.toISOString().slice(0, 10);
export const nextDay = (day: string) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS));
const dayStart = (day: string) => new Date(`${day}T00:00:00Z`);

/** The pool's share of a day's result, in basis points, after scaling by the fill. For display. */
export function effectiveShareBps(shareBps: number, eligible: bigint, cap: bigint): number {
  if (eligible <= 0n || cap <= 0n || shareBps <= 0) return 0;
  if (eligible >= cap) return shareBps;
  return Number((BigInt(shareBps) * eligible) / cap);
}

/** What the whole pool makes or loses on a day: result * share * min(eligible, cap) / cap. */
export function poolResultFor(
  ggr: bigint,
  shareBps: number,
  eligible: bigint,
  cap: bigint,
): bigint {
  if (eligible <= 0n || cap <= 0n || shareBps <= 0) return 0n;
  const counted = eligible < cap ? eligible : cap;
  return (ggr * BigInt(shareBps) * counted) / (cap * 10_000n);
}

/** One stake's slice, rounded toward zero (the dust stays with the house), never a loss bigger
 * than the stake itself. */
export function lotResult(poolResult: bigint, principal: bigint, eligible: bigint): bigint {
  if (eligible <= 0n || principal <= 0n) return 0n;
  const slice = (poolResult * principal) / eligible;
  return slice < -principal ? -principal : slice;
}

export interface SettledDay {
  readonly day: string;
  readonly ggrMinor: bigint;
  readonly eligibleMinor: bigint;
  readonly poolResultMinor: bigint;
  readonly users: readonly string[];
}

/** Settles one UTC day, once. Returns null when it was already settled. */
export async function settleStakingDay(
  db: Database,
  config: AppConfig,
  day: string,
): Promise<SettledDay | null> {
  const from = dayStart(day);
  const until = dayStart(nextDay(day));
  /* Read outside the transaction: the day is over, and its ledger rows no longer change. */
  const result = await db.query<{ ggr: string }>(
    `SELECT COALESCE(-sum(t.amount_minor), 0)::text AS ggr
       FROM wallet_transactions t JOIN users u ON u.id = t.user_id
      WHERE t.kind IN (${GAME_KINDS_SQL})
        AND t.created_at >= $1 AND t.created_at < $2
        AND NOT ${staffPredicate('u')}`,
    [from, until],
  );
  const ggr = BigInt(result.rows[0]?.ggr ?? '0');
  const cap = config.stakingPoolCapMinor;
  const shareBps = config.stakingShareBps;

  return db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staking-settle', 0))");
    const done = await client.query('SELECT 1 FROM staking_days WHERE day = $1::date', [day]);
    if (done.rows[0]) return null;

    /* In for the whole day: earning by its start, and not unlocked before its end. */
    const lots = await client.query<{ id: string; user_id: string; principal_minor: string }>(
      `SELECT id, user_id, principal_minor::text AS principal_minor
         FROM staking_lots
        WHERE status <> 'closed' AND principal_minor > 0 AND earning_from <= $1::date
          AND (unlocks_at IS NULL OR unlocks_at >= $2)
        ORDER BY id
        FOR UPDATE`,
      [day, until],
    );
    const eligible = lots.rows.reduce((sum, lot) => sum + BigInt(lot.principal_minor), 0n);
    const poolResult = poolResultFor(ggr, shareBps, eligible, cap);
    await client.query(
      `INSERT INTO staking_days (day, ggr_minor, eligible_minor, share_bps, pool_result_minor)
       VALUES ($1::date, $2, $3, $4, $5)`,
      [
        day,
        ggr.toString(),
        eligible.toString(),
        effectiveShareBps(shareBps, eligible, cap),
        poolResult.toString(),
      ],
    );

    const users = new Set<string>();
    for (const lot of lots.rows) {
      const principal = BigInt(lot.principal_minor);
      const slice = lotResult(poolResult, principal, eligible);
      const id = randomUUID();
      await client.query(
        `INSERT INTO staking_lot_days (id, day, lot_id, user_id, principal_before_minor, result_minor)
         VALUES ($1, $2::date, $3, $4, $5, $6)`,
        [id, day, lot.id, lot.user_id, principal.toString(), slice.toString()],
      );
      if (slice > 0n) {
        /* Keyed on this stake-day's own id: the ledger is unique on kind and reference. */
        await creditWallet(client, lot.user_id, slice, 'staking_reward', id);
      } else if (slice < 0n) {
        await client.query(
          'UPDATE staking_lots SET principal_minor = principal_minor + $2 WHERE id = $1',
          [lot.id, slice.toString()],
        );
      }
      if (slice !== 0n) users.add(lot.user_id);
    }
    return {
      day,
      ggrMinor: ggr,
      eligibleMinor: eligible,
      poolResultMinor: poolResult,
      users: [...users],
    };
  });
}

/**
 * Pays a stake back once it has unlocked, if every day it shared in has been settled. Under the
 * settlement's own lock, so a release can never overtake the day that still owes it a result.
 */
async function releaseLot(
  db: Database,
  lotId: string,
): Promise<{ userId: string; amount: bigint } | null> {
  return db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staking-settle', 0))");
    const ready = await client.query<{ ok: boolean }>(
      `SELECT (l.earning_from > ((l.unlocks_at AT TIME ZONE 'UTC')::date - 1)
               OR COALESCE((SELECT max(day) FROM staking_days), '-infinity'::date)
                  >= ((l.unlocks_at AT TIME ZONE 'UTC')::date - 1)) AS ok
         FROM staking_lots l
        WHERE l.id = $1 AND l.status = 'unstaking' AND l.unlocks_at <= now()`,
      [lotId],
    );
    if (!ready.rows[0]?.ok) return null;
    const closed = await client.query<{ user_id: string; principal_minor: string }>(
      `UPDATE staking_lots
          SET status = 'closed', closed_at = now(), released_minor = principal_minor
        WHERE id = $1 AND status = 'unstaking'
        RETURNING user_id, principal_minor::text AS principal_minor`,
      [lotId],
    );
    const lot = closed.rows[0];
    if (!lot) return null;
    const amount = BigInt(lot.principal_minor);
    if (amount > 0n) await creditWallet(client, lot.user_id, amount, 'staking_release', lotId);
    return { userId: lot.user_id, amount };
  });
}

export interface StakingOutcome {
  readonly settled: SettledDay[];
  readonly released: { userId: string; amount: bigint }[];
}

const DATABASE_NOW = 'SELECT now() AS now';

/** One pass: settle every finished day that is owed, then pay back what has unlocked. */
export async function runStakingJobs(
  db: Database,
  config: AppConfig,
  now?: Date,
): Promise<StakingOutcome> {
  let at = now;
  if (!at) {
    const clock = await db.query<{ now: Date }>(DATABASE_NOW);
    at = new Date(clock.rows.at(0)!.now);
  }

  const settled: SettledDay[] = [];
  const bounds = await db.query<{ last: string | null; first: string | null }>(
    `SELECT (SELECT max(day)::text FROM staking_days) AS last,
            (SELECT min(earning_from)::text FROM staking_lots WHERE status <> 'closed') AS first`,
  );
  const last = bounds.rows[0]?.last ?? null;
  const first = bounds.rows[0]?.first ?? null;
  /* Nothing open: there is nothing to settle, so no empty day is written either. */
  if (first) {
    let day = last && nextDay(last) > first ? nextDay(last) : first;
    for (let n = 0; n < MAX_DAYS_PER_PASS; n += 1) {
      if (at.getTime() < dayStart(nextDay(day)).getTime() + SETTLE_DELAY_MS) break;
      const outcome = await settleStakingDay(db, config, day);
      if (outcome) settled.push(outcome);
      day = nextDay(day);
    }
  }

  const due = await db.query<{ id: string }>(
    `SELECT id FROM staking_lots
      WHERE status = 'unstaking' AND unlocks_at <= $1
      ORDER BY unlocks_at
      LIMIT 200`,
    [at],
  );
  const released: { userId: string; amount: bigint }[] = [];
  for (const lot of due.rows) {
    const paid = await releaseLot(db, lot.id);
    if (paid) released.push(paid);
  }

  const users = new Set<string>([
    ...settled.flatMap((day) => day.users),
    ...released.map((lot) => lot.userId),
  ]);
  if (users.size) {
    liveEvents.publish('balance', users);
    for (const userId of users) noticeSoon(userId);
  }
  return { settled, released };
}

/* Runs whether or not new stakes are open: switching staking off stops new money coming in, not the
 * settling and paying back of what is already in. */
export function startStakingJobs(app: FastifyInstance, db: Database, config: AppConfig): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runStakingJobs(db, config)
      .then((outcome) => {
        for (const day of outcome.settled) {
          app.log.info(
            {
              day: day.day,
              ggrMinor: day.ggrMinor.toString(),
              eligibleMinor: day.eligibleMinor.toString(),
              poolResultMinor: day.poolResultMinor.toString(),
            },
            'staking: day settled',
          );
        }
      })
      .catch((error: unknown) => app.log.error({ error }, 'staking jobs failed'))
      .finally(() => {
        running = false;
      });
  }, config.stakingSweepSeconds * 1_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

// ── moving money in and out ──────────────────────────────────────────────────

export async function stake(
  db: Database,
  config: AppConfig,
  userId: string,
  amount: bigint,
): Promise<{ lotId: string; earningFrom: string; balanceMinor: string }> {
  if (!config.stakingEnabled) {
    throw new AppError(404, 'STAKING_DISABLED', 'The house pool is not open');
  }
  if (amount < config.stakingMinStakeMinor) {
    throw new AppError(400, 'STAKE_TOO_SMALL', 'That is below the smallest stake', {
      minStakeMinor: config.stakingMinStakeMinor.toString(),
    });
  }
  const lotId = randomUUID();
  const done = await db.transaction(async (client) => {
    /* One stake at a time across the pool, so two can never both fit the last of the cap. */
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('staking-pool', 0))");
    await assertWagerRequirementMet(client, userId, 'staking');
    const totals = await client.query<{ mine: string; total: string }>(
      `SELECT COALESCE(sum(principal_minor) FILTER (WHERE user_id = $1), 0)::text AS mine,
              COALESCE(sum(principal_minor), 0)::text AS total
         FROM staking_lots WHERE status <> 'closed'`,
      [userId],
    );
    const mine = BigInt(totals.rows[0]?.mine ?? '0');
    const total = BigInt(totals.rows[0]?.total ?? '0');
    if (mine + amount > config.stakingMaxPerPlayerMinor) {
      throw new AppError(
        409,
        'STAKE_LIMIT',
        'That would put you over the most one player may stake',
        {
          roomMinor: (config.stakingMaxPerPlayerMinor > mine
            ? config.stakingMaxPerPlayerMinor - mine
            : 0n
          ).toString(),
        },
      );
    }
    if (total + amount > config.stakingPoolCapMinor) {
      throw new AppError(409, 'STAKING_POOL_FULL', 'The pool is full', {
        roomMinor: (config.stakingPoolCapMinor > total
          ? config.stakingPoolCapMinor - total
          : 0n
        ).toString(),
      });
    }
    const debited = await client.query<{ balance_minor: string }>(
      `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
        WHERE user_id = $1 AND balance_minor >= $2
        RETURNING balance_minor::text AS balance_minor`,
      [userId, amount.toString()],
    );
    const balanceAfter = debited.rows[0]?.balance_minor;
    if (balanceAfter === undefined) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Not enough balance for that stake');
    }
    const lot = await client.query<{ earning_from: string }>(
      `INSERT INTO staking_lots (id, user_id, original_minor, principal_minor, earning_from)
       VALUES ($1, $2, $3, $3, (now() AT TIME ZONE 'UTC')::date + 1)
       RETURNING earning_from::text AS earning_from`,
      [lotId, userId, amount.toString()],
    );
    await client.query(
      `INSERT INTO wallet_transactions
         (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
       VALUES ($1, $2, $3, $4, 'staking_stake', $5)`,
      [randomUUID(), userId, (-amount).toString(), balanceAfter, lotId],
    );
    return { earningFrom: lot.rows[0]!.earning_from, balanceMinor: balanceAfter };
  });
  liveEvents.publish('balance', [userId]);
  return { lotId, ...done };
}

/** Starts a stake's cool-down. It keeps sharing results until it unlocks, then is paid back. */
export async function requestUnstake(
  db: Database,
  config: AppConfig,
  userId: string,
  lotId: string,
): Promise<{ unlocksAt: string }> {
  const result = await db.query<{ unlocks_at: Date }>(
    `UPDATE staking_lots
        SET status = 'unstaking', unstake_requested_at = now(),
            unlocks_at = now() + make_interval(hours => $3)
      WHERE id = $1 AND user_id = $2 AND status = 'active'
      RETURNING unlocks_at`,
    [lotId, userId, config.stakingUnstakeHours],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, 'STAKE_NOT_ACTIVE', 'That stake is not active');
  return { unlocksAt: new Date(row.unlocks_at).toISOString() };
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface StakingView {
  readonly enabled: boolean;
  readonly shareBps: number;
  readonly poolCapMinor: string;
  readonly minStakeMinor: string;
  readonly maxPerPlayerMinor: string;
  readonly unstakeHours: number;
  readonly pool: {
    readonly stakedMinor: string;
    readonly earningMinor: string;
    readonly stakers: number;
  };
  /** The settled days, newest first: what every 1B in the pool made or lost that day. */
  readonly days: readonly {
    readonly day: string;
    readonly eligibleMinor: string;
    readonly per1bMinor: string | null;
  }[];
  readonly you: {
    readonly lots: readonly {
      readonly id: string;
      readonly originalMinor: string;
      readonly principalMinor: string;
      readonly stakedAt: string;
      readonly earningFrom: string;
      readonly status: 'active' | 'unstaking' | 'closed';
      readonly unlocksAt: string | null;
    }[];
    readonly earnedMinor: string;
    readonly lostMinor: string;
  } | null;
}

const ONE_BILLION = 1_000_000_000n;

export async function readStaking(
  client: DbClient,
  config: AppConfig,
  viewerId: string | null,
): Promise<StakingView> {
  const [pool, days, lots, totals] = await Promise.all([
    client.query<{ staked: string; earning: string; stakers: string }>(
      `SELECT COALESCE(sum(principal_minor), 0)::text AS staked,
              COALESCE(sum(principal_minor) FILTER (
                WHERE earning_from <= (now() AT TIME ZONE 'UTC')::date
                  AND (unlocks_at IS NULL
                       OR unlocks_at >= ((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC')
              ), 0)::text AS earning,
              count(DISTINCT user_id)::text AS stakers
         FROM staking_lots WHERE status <> 'closed'`,
    ),
    client.query<{ day: string; eligible_minor: string; pool_result_minor: string }>(
      `SELECT day::text AS day, eligible_minor::text AS eligible_minor,
              pool_result_minor::text AS pool_result_minor
         FROM staking_days ORDER BY day DESC LIMIT 14`,
    ),
    viewerId
      ? client.query<{
          id: string;
          original_minor: string;
          principal_minor: string;
          staked_at: Date;
          earning_from: string;
          status: 'active' | 'unstaking' | 'closed';
          unlocks_at: Date | null;
        }>(
          `SELECT id, original_minor::text AS original_minor, principal_minor::text AS principal_minor,
                  staked_at, earning_from::text AS earning_from, status, unlocks_at
             FROM staking_lots
            WHERE user_id = $1 AND (status <> 'closed' OR closed_at > now() - interval '14 days')
            ORDER BY staked_at DESC
            LIMIT 20`,
          [viewerId],
        )
      : Promise.resolve({ rows: [] }),
    viewerId
      ? client.query<{ earned: string; lost: string }>(
          `SELECT COALESCE(sum(result_minor) FILTER (WHERE result_minor > 0), 0)::text AS earned,
                  COALESCE(-sum(result_minor) FILTER (WHERE result_minor < 0), 0)::text AS lost
             FROM staking_lot_days WHERE user_id = $1`,
          [viewerId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const row = pool.rows[0];
  return {
    enabled: config.stakingEnabled,
    shareBps: config.stakingShareBps,
    poolCapMinor: config.stakingPoolCapMinor.toString(),
    minStakeMinor: config.stakingMinStakeMinor.toString(),
    maxPerPlayerMinor: config.stakingMaxPerPlayerMinor.toString(),
    unstakeHours: config.stakingUnstakeHours,
    pool: {
      stakedMinor: row?.staked ?? '0',
      earningMinor: row?.earning ?? '0',
      stakers: Number(row?.stakers ?? '0'),
    },
    days: days.rows.map((day) => {
      const eligible = BigInt(day.eligible_minor);
      return {
        day: day.day,
        eligibleMinor: day.eligible_minor,
        per1bMinor:
          eligible > 0n
            ? ((BigInt(day.pool_result_minor) * ONE_BILLION) / eligible).toString()
            : null,
      };
    }),
    you: viewerId
      ? {
          lots: lots.rows.map((lot) => ({
            id: lot.id,
            originalMinor: lot.original_minor,
            principalMinor: lot.principal_minor,
            stakedAt: new Date(lot.staked_at).toISOString(),
            earningFrom: lot.earning_from,
            status: lot.status,
            unlocksAt: lot.unlocks_at ? new Date(lot.unlocks_at).toISOString() : null,
          })),
          earnedMinor: totals.rows[0]?.earned ?? '0',
          lostMinor: totals.rows[0]?.lost ?? '0',
        }
      : null,
  };
}
