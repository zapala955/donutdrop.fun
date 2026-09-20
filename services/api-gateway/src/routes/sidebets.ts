import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet } from '../lib/cash-settlement.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { impliedMultiplierBps, settlePool, type Bet } from '../lib/sidebet-engine.js';
import { parseWith } from '../lib/validation.js';

/**
 * Spectator side betting.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A SPECTATOR CANNOT BET ON A MATCH THEY ARE IN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This is the single rule the whole feature rests on. A player who can bet against their own snake
 * has a guaranteed profit available: back WIPEOUT, drive into a wall, collect. It is checked on the
 * server against the match's own participant records, not against anything the client says.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * MARKETS LOCK BEFORE THEY RESOLVE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Betting shuts a fixed interval after the market opens. Without that, a spectator watching a snake
 * about to hit a wall could place a bet on the outcome they can already see — which is not a
 * prediction market, it is a free withdrawal. The lock is enforced on the write path, so a client
 * holding an open market open in a stale tab cannot bet through it.
 */

/** How long a market takes bets before it shuts. */
const LOCK_AFTER_MS = 45_000;

const placeSchema = z
  .object({
    outcome: z.string().min(1).max(40),
    stakeMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  })
  .strict();

interface MarketRow {
  id: string;
  kind: string;
  subject_ref: string;
  outcome_a: string;
  outcome_b: string;
  rake_bps: number;
  status: string;
  opened_at: Date;
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* the board is readable logged out */
    }
  };
}

export async function registerSideBetRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  function assertEnabled(): void {
    if (!config.sideBetsEnabled) {
      throw new AppError(404, 'SIDE_BETS_DISABLED', 'Side betting is not switched on');
    }
  }

  /** Locks every market past its betting window. Lazy, off the read, like the rain sweeper. */
  async function lockDueMarkets(): Promise<void> {
    await db.query(
      `UPDATE side_bet_markets
          SET status = 'locked', locked_at = now()
        WHERE status = 'open' AND opened_at <= now() - make_interval(secs => $1)`,
      [LOCK_AFTER_MS / 1000],
    );
  }

  async function poolFor(client: DbClient, marketId: string) {
    const rows = await client.query<{ outcome: string; total: string }>(
      `SELECT outcome, SUM(stake_minor)::text AS total
         FROM side_bets WHERE market_id = $1 GROUP BY outcome`,
      [marketId],
    );
    const byOutcome = new Map<string, bigint>();
    for (const row of rows.rows) byOutcome.set(row.outcome, BigInt(row.total));
    let pool = 0n;
    for (const value of byOutcome.values()) pool += value;
    return { byOutcome, pool };
  }

  /* ═════════════════════════ the board ═════════════════════════ */

  app.get('/v1/sidebets', { preHandler: softAuth }, async (request) => {
    assertEnabled();
    await lockDueMarkets();
    const viewerId = request.authUser?.id ?? null;

    const markets = await db.query<MarketRow>(
      `SELECT * FROM side_bet_markets
        WHERE status IN ('open', 'locked')
        ORDER BY opened_at DESC LIMIT 20`,
    );

    const board = [];
    for (const market of markets.rows) {
      const { byOutcome, pool } = await poolFor(db, market.id);
      const mine = viewerId
        ? await db.query<{ outcome: string; stake_minor: string }>(
            'SELECT outcome, stake_minor FROM side_bets WHERE market_id = $1 AND user_id = $2',
            [market.id, viewerId],
          )
        : { rows: [] as { outcome: string; stake_minor: string }[] };

      board.push({
        id: market.id,
        kind: market.kind,
        subjectRef: market.subject_ref,
        status: market.status,
        /* Closes at, not "seconds left": a client with a skewed clock computing its own countdown
         * from a duration is a client that shows a different number to everybody. */
        locksAt: new Date(market.opened_at.getTime() + LOCK_AFTER_MS).toISOString(),
        poolMinor: pool.toString(),
        outcomes: [market.outcome_a, market.outcome_b].map((outcome) => ({
          name: outcome,
          stakedMinor: (byOutcome.get(outcome) ?? 0n).toString(),
          /* Net of the cut already. The spectator sees what they would be paid, never a rate. */
          multiplierBps: impliedMultiplierBps(byOutcome.get(outcome) ?? 0n, pool, market.rake_bps),
        })),
        yourBet: mine.rows[0]
          ? { outcome: mine.rows[0].outcome, stakeMinor: mine.rows[0].stake_minor }
          : null,
      });
    }
    return {
      markets: board,
      minStakeMinor: config.sideBetMinStakeMinor.toString(),
      maxStakeMinor: config.sideBetMaxStakeMinor.toString(),
      presets: ['1000000', '10000000', '50000000'],
    };
  });

  /* ═════════════════════════ placing ═════════════════════════ */

  app.post(
    '/v1/sidebets/:id/bet',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
      const { id } = parseWith(z.object({ id: z.uuid() }), request.params);
      const body = parseWith(placeSchema, request.body);
      const stake = BigInt(body.stakeMinor);
      if (stake < config.sideBetMinStakeMinor || stake > config.sideBetMaxStakeMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_BAND', 'That stake is outside the side-bet limits');
      }

      return db.transaction(async (client) => {
        const locked = await client.query<MarketRow>(
          'SELECT * FROM side_bet_markets WHERE id = $1 FOR UPDATE',
          [id],
        );
        const market = locked.rows[0];
        if (!market) throw new AppError(404, 'NO_SUCH_MARKET', 'No such market');
        if (market.status !== 'open') {
          throw new AppError(409, 'MARKET_LOCKED', 'Betting is closed on that match');
        }
        /* Re-checked against the clock here as well as by the sweeper. The sweeper runs off a read
         * that may not have happened for a while; this is the one that cannot be raced. */
        if (Date.now() - market.opened_at.getTime() > LOCK_AFTER_MS) {
          throw new AppError(409, 'MARKET_LOCKED', 'Betting is closed on that match');
        }
        if (body.outcome !== market.outcome_a && body.outcome !== market.outcome_b) {
          throw new AppError(400, 'NO_SUCH_OUTCOME', 'That is not an outcome on this market');
        }

        /* The rule the whole feature rests on. Checked against the match's own records — a player
         * betting against their own snake has a guaranteed profit available. */
        if (await isParticipant(client, market, userId)) {
          throw new AppError(403, 'IN_THE_MATCH', 'You cannot bet on a match you are in');
        }

        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 AND balance_minor >= $2
            RETURNING balance_minor`,
          [userId, stake.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) {
          throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Not enough balance for that bet');
        }

        const betId = randomUUID();
        try {
          await client.query(
            `INSERT INTO side_bets (id, market_id, user_id, outcome, stake_minor)
             VALUES ($1, $2, $3, $4, $5)`,
            [betId, id, userId, body.outcome, stake.toString()],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new AppError(409, 'ALREADY_BET', 'You already have a bet on this match');
          }
          throw error;
        }
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'sidebet_stake', $5)`,
          [randomUUID(), userId, (-stake).toString(), balanceAfter, betId],
        );

        const { byOutcome, pool } = await poolFor(client, id);
        return {
          ok: true,
          betId,
          outcome: body.outcome,
          stakeMinor: stake.toString(),
          multiplierBps: impliedMultiplierBps(
            byOutcome.get(body.outcome) ?? 0n,
            pool,
            market.rake_bps,
          ),
        };
      });
    },
  );

  /**
   * Whether this account is playing in the match the market follows.
   *
   * Reads the match's own tables rather than anything the client supplies, and errs toward refusing:
   * a market whose subject cannot be resolved is treated as one the player might be in.
   */
  async function isParticipant(
    client: DbClient,
    market: MarketRow,
    userId: string,
  ): Promise<boolean> {
    if (market.kind === 'slither') {
      /* The arena is gone and `slither_sessions` went with it, so there is no longer a table that
       * could answer whether this account was in that session. Querying it would throw.
       *
       * Answering `true` refuses the bet, which is the correct direction and the one this function
       * already documents: a subject that cannot be resolved is treated as one the player might be
       * in. Nothing can open an arena market any more, so the only rows that reach here are settled
       * history — and a bet on a match that can never be played again should be refused whoever is
       * asking. */
      return true;
    }
    if (market.kind === 'duel') {
      const row = await client.query(
        `SELECT 1 FROM duel_lobbies
          WHERE code = $1 AND (host_user_id = $2 OR opponent_user_id = $2)`,
        [market.subject_ref, userId],
      );
      return (row.rowCount ?? 0) > 0;
    }
    return true;
  }
}

/* ═════════════════════════ opening and settling ═════════════════════════
 *
 * Exported as plain functions rather than routes, because a market is opened and resolved by the
 * match it follows — never by a request. There is no endpoint that can settle one, which is what
 * stops a market being settled to an outcome somebody asked for.
 */

/** Opens a market on a match. Silently does nothing when one already exists or the feature is off. */
export async function openSideBetMarket(
  db: Database,
  config: AppConfig,
  market: {
    readonly kind: 'duel';
    readonly subjectRef: string;
    readonly outcomeA: string;
    readonly outcomeB: string;
  },
): Promise<string | null> {
  if (!config.sideBetsEnabled) return null;
  const id = randomUUID();
  const inserted = await db.query(
    `INSERT INTO side_bet_markets
       (id, kind, subject_ref, outcome_a, outcome_b, rake_bps, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open')
     ON CONFLICT (kind, subject_ref) DO NOTHING`,
    [id, market.kind, market.subjectRef, market.outcomeA, market.outcomeB, config.sideBetRakeBps],
  );
  return inserted.rowCount ? id : null;
}

/**
 * Settles a market from the result of the match it follows.
 *
 * `winningOutcome` of null voids it: every stake comes back at face value and the house takes
 * nothing, because it did not produce a result anybody can be paid on.
 */
export async function settleSideBetMarket(
  db: Database,
  kind: 'duel',
  subjectRef: string,
  winningOutcome: string | null,
): Promise<void> {
  await db.transaction(async (client) => {
    const locked = await client.query<MarketRow>(
      `SELECT * FROM side_bet_markets
        WHERE kind = $1 AND subject_ref = $2 AND status IN ('open', 'locked')
        FOR UPDATE`,
      [kind, subjectRef],
    );
    const market = locked.rows[0];
    if (!market) return;

    const rows = await client.query<{
      id: string;
      user_id: string;
      outcome: string;
      stake_minor: string;
    }>('SELECT id, user_id, outcome, stake_minor FROM side_bets WHERE market_id = $1', [market.id]);
    const bets: Bet[] = rows.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      outcome: row.outcome,
      stakeMinor: BigInt(row.stake_minor),
    }));

    const result = settlePool(bets, winningOutcome, market.rake_bps);
    const claimed = await client.query(
      `UPDATE side_bet_markets
          SET status = $2, settled_at = now(), winning_outcome = $3,
              pool_minor = $4, rake_minor = $5, payout_minor = $6
        WHERE id = $1 AND status IN ('open', 'locked')`,
      [
        market.id,
        result.voided ? 'voided' : 'settled',
        result.voided ? null : winningOutcome,
        result.poolMinor.toString(),
        result.rakeMinor.toString(),
        result.payoutMinor.toString(),
      ],
    );
    if (claimed.rowCount === 0) return; // somebody else settled it first

    for (const bet of bets) {
      const payout = result.payouts.get(bet.id) ?? 0n;
      await client.query(
        'UPDATE side_bets SET payout_minor = $2, settled_at = now() WHERE id = $1',
        [bet.id, payout.toString()],
      );
      if (payout > 0n) {
        await creditWallet(
          client,
          bet.userId,
          payout,
          result.voided ? 'sidebet_refund' : 'sidebet_win',
          bet.id,
        );
      }
    }
  });
}
