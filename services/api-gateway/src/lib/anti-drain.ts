import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { DEPOSIT_KINDS, GAME_KINDS, PROMO_KINDS, staffPredicate } from './admin-stats.js';
import { appendAudit } from './audit.js';
import type { Database, DbClient } from './db.js';

/**
 * anti-drain.ts -- stopping one account, or a handful of them, from walking the house's cash out
 * the door faster than a human can notice.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A HOLD IS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A hold never takes anything from a player. The wallet was debited the moment they asked to
 * withdraw, so the money is already out of their balance and cannot be staked again. A hold only
 * decides whether the bot is TOLD to send it yet: a held withdrawal sits in the operator queue
 * (status `pending_approval`) until a human approves it, and it is then sent exactly as an
 * ordinary one is, or rejects it, and it is refunded to the wallet.
 *
 * That is also why the rules below can afford to be strict. A false positive costs an operator one
 * click and a player a short wait; a false negative costs whatever the house was holding.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE THREE LAYERS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. At the moment of the request (`evaluateWithdrawal`): the global switch, a hold on the
 *      player, the single-request ceiling, the player's net cash-out, and the house's hourly net
 *      outflow. Stateless: everything is recomputed from the ledger, so there is no counter to
 *      drift and nothing to reset.
 *   2. Every minute (`runAntiDrainMonitor`): a player whose net result on the games and
 *      promotions over an hour or a day is over the line gets a hold of their own, and anything
 *      they already have waiting for the bot is pulled back. This is the layer that catches an
 *      exploit, because an exploit shows up as winnings long before it shows up as a withdrawal.
 *   3. By hand, from the admin Payouts tab: hold all, hold one player, hold one withdrawal.
 *
 * Staff are never caught by layers 1 (the player and house rules) and 2: an operator testing a
 * crate with a test balance would otherwise be flagged as the biggest winner on the site.
 */

/* A held job is not deleted -- the API role has no DELETE on bot_jobs, and a row is evidence --
 * it is moved a century into the future, where the bot's claim query (`available_at <= now()`)
 * never reaches it. Anything more than ten years out is therefore, unambiguously, a held job. */
const HOLD_UNTIL_SQL = "now() + interval '100 years'";
const HELD_THRESHOLD_SQL = "now() + interval '10 years'";

/**
 * The tail of the `cash_payout` insert: when the job already exists AND is held, approving the
 * withdrawal brings it back to life instead of colliding with it and doing nothing, which would
 * leave an approved payout that never goes out. A live job is left exactly as it is.
 */
export const RELEASE_HELD_JOB_SQL = `ON CONFLICT (kind, reference_id) DO UPDATE
       SET available_at = EXCLUDED.available_at, updated_at = now()
     WHERE bot_jobs.status = 'queued' AND bot_jobs.available_at > ${HELD_THRESHOLD_SQL}`;

/* ═════════════════════════ the rules ═════════════════════════ */

export interface DrainRules {
  readonly enabled: boolean;
  readonly holdAll: boolean;
  readonly approvalThresholdMinor: bigint;
  readonly netCashoutMinor: bigint;
  readonly houseHourlyMinor: bigint;
}

export function rulesFrom(config: AppConfig): DrainRules {
  return {
    enabled: config.antiDrainEnabled,
    holdAll: config.cashPayoutsHold,
    approvalThresholdMinor: config.cashApprovalThresholdMinor,
    netCashoutMinor: config.antiDrainNetCashoutMinor,
    houseHourlyMinor: config.antiDrainHouseHourlyMinor,
  };
}

export interface WithdrawalFacts {
  readonly amountMinor: bigint;
  readonly isStaff: boolean;
  readonly userHoldReason: string | null;
  /** Every deposit the player ever made. */
  readonly depositedMinor: bigint;
  /** Every withdrawal still owed or paid, this request not included. */
  readonly withdrawnMinor: bigint;
  /** Cash the house sent out over the last hour less cash that came in, this request excluded. */
  readonly houseNetOutflowHourMinor: bigint;
}

export interface ReviewDecision {
  readonly review: boolean;
  readonly reasons: readonly string[];
}

/** 340000000 -> "340M". Reasons are read by a person deciding whether to approve. */
export function compactMinor(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const sign = negative ? '-' : '';
  const units: readonly (readonly [bigint, string])[] = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (magnitude >= size) {
      const whole = magnitude / size;
      const tenth = ((magnitude % size) * 10n) / size;
      return `${sign}${whole}${tenth > 0n ? `.${tenth}` : ''}${suffix}`;
    }
  }
  return `${sign}${magnitude}`;
}

/**
 * Whether a withdrawal request goes to a human before the bot is told anything, and why.
 *
 * Pure. The manual controls (the global hold, a hold on the player, the single-request ceiling)
 * apply to everybody including staff -- an operator who has put the site on hold means all of it.
 * The automatic rules apply to players only.
 */
export function evaluateWithdrawal(facts: WithdrawalFacts, rules: DrainRules): ReviewDecision {
  const reasons: string[] = [];

  if (rules.holdAll) reasons.push('All payouts are on hold');
  if (facts.userHoldReason) reasons.push(`Player hold: ${facts.userHoldReason}`);
  if (facts.amountMinor > rules.approvalThresholdMinor) {
    reasons.push(
      `Request ${compactMinor(facts.amountMinor)} is over the ${compactMinor(rules.approvalThresholdMinor)} approval limit`,
    );
  }

  if (rules.enabled && !facts.isStaff) {
    if (rules.netCashoutMinor > 0n) {
      const net = facts.withdrawnMinor + facts.amountMinor - facts.depositedMinor;
      if (net > rules.netCashoutMinor) {
        reasons.push(
          `Net cash-out ${compactMinor(net)} (withdrawn less deposited) is over the ${compactMinor(rules.netCashoutMinor)} allowance`,
        );
      }
    }
    if (rules.houseHourlyMinor > 0n) {
      const flow = facts.houseNetOutflowHourMinor + facts.amountMinor;
      if (flow > rules.houseHourlyMinor) {
        reasons.push(
          `House net outflow ${compactMinor(flow)} in the last hour is over the ${compactMinor(rules.houseHourlyMinor)} limit`,
        );
      }
    }
  }

  return { review: reasons.length > 0, reasons };
}

/** The reason as stored: one string, short enough for the column. */
export function reasonText(reasons: readonly string[]): string {
  return reasons.join('; ').slice(0, 300);
}

/* ═════════════════════════ the facts ═════════════════════════ */

/**
 * What the rules need to know about a request, read inside the withdrawal's own transaction.
 *
 * The player's row is already locked by the caller, so their figures cannot move underneath the
 * decision. The house figure is a snapshot, and deliberately so: it is a velocity gauge, and a
 * request that lands a millisecond after another one is judged against a number that already
 * includes it, because the other transaction committed first or this one is judged without it and
 * the next request sees both. Either way the gauge catches up within one request.
 */
export async function loadWithdrawalFacts(
  client: DbClient,
  userId: string,
  amountMinor: bigint,
): Promise<WithdrawalFacts> {
  const player = await client.query<{
    payout_hold_reason: string | null;
    is_staff: boolean;
    deposited: string;
    withdrawn: string;
  }>(
    `SELECT u.payout_hold_reason,
            ${staffPredicate('u')} AS is_staff,
            COALESCE((SELECT SUM(t.amount_minor) FROM wallet_transactions t
                       WHERE t.user_id = u.id AND t.kind = ANY($2::text[])), 0)::text AS deposited,
            COALESCE((SELECT SUM(w.amount_minor) FROM cash_withdrawals w
                       WHERE w.user_id = u.id AND w.status NOT IN ('failed', 'rejected')), 0)::text AS withdrawn
       FROM users u WHERE u.id = $1`,
    [userId, [...DEPOSIT_KINDS]],
  );
  const row = player.rows[0];
  return {
    amountMinor,
    isStaff: row?.is_staff ?? false,
    userHoldReason: row?.payout_hold_reason ?? null,
    depositedMinor: BigInt(row?.deposited ?? '0'),
    withdrawnMinor: BigInt(row?.withdrawn ?? '0'),
    houseNetOutflowHourMinor: await houseNetOutflowLastHour(client),
  };
}

/**
 * Cash that actually left the house over the last hour, less cash that came in, staff excluded.
 *
 * "Actually left" means a request that a human has not been asked about: a withdrawal waiting in
 * the operator queue has not gone anywhere and counting it would trip the breaker on the very
 * requests the breaker is holding. Approving one moves it into the count, in its place by request
 * time.
 */
export async function houseNetOutflowLastHour(client: DbClient): Promise<bigint> {
  const result = await client.query<{ net: string }>(
    `SELECT (
        COALESCE((SELECT SUM(w.amount_minor) FROM cash_withdrawals w
                    JOIN users u ON u.id = w.user_id
                   WHERE w.created_at >= now() - interval '1 hour'
                     AND w.status NOT IN ('pending_approval', 'failed', 'rejected')
                     AND NOT ${staffPredicate('u')}), 0)
      - COALESCE((SELECT SUM(t.amount_minor) FROM wallet_transactions t
                    JOIN users u ON u.id = t.user_id
                   WHERE t.created_at >= now() - interval '1 hour'
                     AND t.kind = ANY($1::text[])
                     AND NOT ${staffPredicate('u')}), 0)
      )::text AS net`,
    [[...DEPOSIT_KINDS]],
  );
  return BigInt(result.rows[0]?.net ?? '0');
}

/* ═════════════════════════ holding and releasing ═════════════════════════ */

export type HoldResult = 'held' | 'not_found' | 'not_holdable';

/**
 * Pulls a payout back from the bot and puts it in the operator queue.
 *
 * Only a payout nobody has touched can be pulled back: status `queued`, paid from the teller's own
 * float (a vault-funded one has already moved money to the teller and is committed), and its job
 * still unclaimed. Both rows are locked before either is changed, so the bot claiming the job at
 * the same instant either got there first -- in which case the job is no longer `queued` and
 * nothing happens here -- or finds the row locked and skips it.
 */
export async function holdQueuedWithdrawal(
  client: DbClient,
  withdrawalId: string,
  reason: string,
): Promise<HoldResult> {
  const found = await client.query<{ status: string; funding: string }>(
    'SELECT status, funding FROM cash_withdrawals WHERE id = $1 FOR UPDATE',
    [withdrawalId],
  );
  const row = found.rows[0];
  if (!row) return 'not_found';
  if (row.status !== 'queued' || row.funding === 'vault') return 'not_holdable';

  const job = await client.query<{ id: string }>(
    `SELECT id FROM bot_jobs
      WHERE kind = 'cash_payout' AND reference_id = $1 AND status = 'queued'
      FOR UPDATE`,
    [withdrawalId],
  );
  const jobId = job.rows[0]?.id;
  if (!jobId) return 'not_holdable';

  /* last_error_code is cleared because the claim query makes a queued job that failed for lack of
   * funds block every NEWER money job behind it. A held job must not hold the whole queue hostage. */
  await client.query(
    `UPDATE bot_jobs
        SET available_at = ${HOLD_UNTIL_SQL}, last_error_code = NULL, updated_at = now()
      WHERE id = $1`,
    [jobId],
  );
  await client.query(
    `UPDATE cash_withdrawals
        SET status = 'pending_approval', review_reason = $2,
            approved_by = NULL, approved_at = NULL, updated_at = now()
      WHERE id = $1`,
    [withdrawalId, reason.slice(0, 300)],
  );
  return 'held';
}

export interface BulkHoldResult {
  readonly held: number;
  readonly skipped: number;
}

async function holdMany(
  client: DbClient,
  ids: readonly string[],
  reason: string,
): Promise<BulkHoldResult> {
  let held = 0;
  let skipped = 0;
  for (const id of ids) {
    if ((await holdQueuedWithdrawal(client, id, reason)) === 'held') held += 1;
    else skipped += 1;
  }
  return { held, skipped };
}

/** Everything of one player's that is waiting for the bot. */
export async function holdQueuedForUser(
  client: DbClient,
  userId: string,
  reason: string,
): Promise<BulkHoldResult> {
  const ids = await client.query<{ id: string }>(
    `SELECT id FROM cash_withdrawals
      WHERE user_id = $1 AND status = 'queued' AND funding <> 'vault'
      ORDER BY created_at`,
    [userId],
  );
  return holdMany(
    client,
    ids.rows.map((row) => row.id),
    reason,
  );
}

/** Everything anyone has waiting for the bot: the panic button, and the circuit breaker's. */
export async function holdAllQueued(client: DbClient, reason: string): Promise<BulkHoldResult> {
  const ids = await client.query<{ id: string }>(
    `SELECT id FROM cash_withdrawals
      WHERE status = 'queued' AND funding <> 'vault'
      ORDER BY created_at`,
  );
  return holdMany(
    client,
    ids.rows.map((row) => row.id),
    reason,
  );
}

/** Puts, or replaces, the hold on a player. Their wallet and their play are untouched. */
export async function setPayoutHold(
  client: DbClient,
  userId: string,
  reason: string,
  actorUserId: string | null,
): Promise<boolean> {
  const updated = await client.query(
    `UPDATE users
        SET payout_hold_reason = $2, payout_hold_at = now(), payout_hold_by = $3, updated_at = now()
      WHERE id = $1
      RETURNING id`,
    [userId, reason.slice(0, 300), actorUserId],
  );
  return updated.rows.length > 0;
}

/** Lifts a player's hold. Withdrawals already in the queue stay there until a human approves them. */
export async function clearPayoutHold(client: DbClient, userId: string): Promise<boolean> {
  const updated = await client.query(
    `UPDATE users
        SET payout_hold_reason = NULL, payout_hold_at = NULL, payout_hold_by = NULL,
            updated_at = now()
      WHERE id = $1 AND payout_hold_reason IS NOT NULL
      RETURNING id`,
    [userId],
  );
  return updated.rows.length > 0;
}

/* ═════════════════════════ the monitor ═════════════════════════ */

/* What counts as winning: the games themselves, and the promotions that pay players for playing.
 * An exploit can be a game bug or a promotion bug, and the monitor does not care which. */
const RESULT_KINDS: readonly string[] = [...GAME_KINDS, ...Object.keys(PROMO_KINDS)];

export interface FlaggedPlayer {
  readonly userId: string;
  readonly name: string;
  readonly net1hMinor: bigint;
  readonly net24hMinor: bigint;
  readonly pulledBack: number;
}

export interface MonitorOutcome {
  readonly flagged: readonly FlaggedPlayer[];
  /** Payouts pulled back from the bot because the house's hourly outflow is over its limit. */
  readonly breakerPulledBack: number;
}

/**
 * One pass. Idempotent: a player who already has a hold is not looked at again, and a pass that
 * finds nothing writes nothing.
 */
export async function runAntiDrainMonitor(
  db: Database,
  config: AppConfig,
): Promise<MonitorOutcome> {
  if (!config.antiDrainEnabled) return { flagged: [], breakerPulledBack: 0 };

  const flagged: FlaggedPlayer[] = [];
  const win1h = config.antiDrainWin1hMinor;
  const win24h = config.antiDrainWin24hMinor;

  if (win1h > 0n || win24h > 0n) {
    const candidates = await db.query<{
      user_id: string;
      name: string;
      net_1h: string;
      net_24h: string;
    }>(
      `SELECT t.user_id, u.minecraft_username AS name,
              COALESCE(SUM(t.amount_minor) FILTER (WHERE t.created_at >= now() - interval '1 hour'), 0)::text AS net_1h,
              SUM(t.amount_minor)::text AS net_24h
         FROM wallet_transactions t
         JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= now() - interval '24 hours'
          AND t.kind = ANY($1::text[])
          AND u.payout_hold_reason IS NULL
          AND u.status = 'active'
          AND NOT ${staffPredicate('u')}
        GROUP BY t.user_id, u.minecraft_username
       HAVING ($2::numeric > 0 AND COALESCE(SUM(t.amount_minor) FILTER (WHERE t.created_at >= now() - interval '1 hour'), 0) >= $2::numeric)
           OR ($3::numeric > 0 AND SUM(t.amount_minor) >= $3::numeric)
        ORDER BY SUM(t.amount_minor) DESC
        LIMIT 25`,
      [RESULT_KINDS, win1h.toString(), win24h.toString()],
    );

    for (const candidate of candidates.rows) {
      const net1h = BigInt(candidate.net_1h);
      const net24h = BigInt(candidate.net_24h);
      const tripped1h = win1h > 0n && net1h >= win1h;
      const reason = tripped1h
        ? `Auto: net winnings ${compactMinor(net1h)} in 1h (limit ${compactMinor(win1h)})`
        : `Auto: net winnings ${compactMinor(net24h)} in 24h (limit ${compactMinor(win24h)})`;

      const pulledBack = await db.transaction(async (client) => {
        /* The guard is in the UPDATE: two monitors, or a monitor and an operator, holding the same
         * player at once must leave one hold and one audit row, not two. */
        const placed = await client.query(
          `UPDATE users
              SET payout_hold_reason = $2, payout_hold_at = now(), payout_hold_by = NULL,
                  updated_at = now()
            WHERE id = $1 AND payout_hold_reason IS NULL AND status = 'active'
            RETURNING id`,
          [candidate.user_id, reason],
        );
        if (placed.rows.length === 0) return null;
        const pulled = await holdQueuedForUser(client, candidate.user_id, reason);
        await appendAudit(client, config, {
          actorUserId: null,
          action: 'anti_drain.auto_hold',
          targetType: 'user',
          targetId: candidate.user_id,
          details: {
            reason,
            net1hMinor: net1h.toString(),
            net24hMinor: net24h.toString(),
            pulledBack: pulled.held,
          },
        });
        return pulled.held;
      });
      if (pulledBack !== null) {
        flagged.push({
          userId: candidate.user_id,
          name: candidate.name,
          net1hMinor: net1h,
          net24hMinor: net24h,
          pulledBack,
        });
      }
    }
  }

  let breakerPulledBack = 0;
  if (config.antiDrainHouseHourlyMinor > 0n) {
    const flow = await houseNetOutflowLastHour(db);
    if (flow >= config.antiDrainHouseHourlyMinor) {
      const reason = `Circuit breaker: house net outflow ${compactMinor(flow)} in the last hour (limit ${compactMinor(config.antiDrainHouseHourlyMinor)})`;
      breakerPulledBack = await db.transaction(async (client) => {
        const pulled = await holdAllQueued(client, reason);
        if (pulled.held > 0) {
          await appendAudit(client, config, {
            actorUserId: null,
            action: 'anti_drain.circuit_breaker',
            targetType: 'cash_withdrawal',
            targetId: 'all',
            details: { reason, pulledBack: pulled.held, skipped: pulled.skipped },
          });
        }
        return pulled.held;
      });
    }
  }

  return { flagged, breakerPulledBack };
}

/** Runs the monitor every minute for the life of the app. A failed pass is logged, never fatal. */
export function startAntiDrainMonitor(app: FastifyInstance, db: Database, config: AppConfig): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runAntiDrainMonitor(db, config)
      .then((outcome) => {
        for (const player of outcome.flagged) {
          app.log.warn(
            { userId: player.userId, name: player.name, pulledBack: player.pulledBack },
            'anti-drain: payout hold placed on a player',
          );
        }
        if (outcome.breakerPulledBack > 0) {
          app.log.warn(
            { pulledBack: outcome.breakerPulledBack },
            'anti-drain: circuit breaker pulled queued payouts back for review',
          );
        }
      })
      .catch((error: unknown) => app.log.error({ error }, 'anti-drain monitor failed'))
      .finally(() => {
        running = false;
      });
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
