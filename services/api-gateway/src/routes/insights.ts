import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith } from '../lib/validation.js';

/**
 * Leaderboards and personal statistics.
 *
 * Read-only aggregates over tables that already exist. Nothing here maintains a counter, because
 * a leaderboard fed by its own running total is a leaderboard that can disagree with the rounds
 * that produced it, and the rounds are the record.
 *
 * Every board is windowed to the last 30 days. An all-time board on a platform this young is a
 * list of whoever showed up first, and it stops being a competition the moment the top is out of
 * reach — which is also the moment it stops being worth rendering.
 */

const WINDOW_DAYS = 30;
const boardSchema = z
  .object({
    board: z.enum(['wagered', 'multiplier', 'crates']).default('wagered'),
    limit: z.coerce.number().int().min(3).max(100).default(50),
  })
  .strict();

interface BoardRow {
  user_id: string;
  username: string;
  value: string;
  detail: string | null;
}

export async function registerInsightRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  /**
   * Public, because a leaderboard nobody can see before signing up is an advertisement for an
   * empty room. It exposes masked names and volumes, matching the public live feed without giving
   * a spectator a second route that reveals the Minecraft names behind those masks.
   */
  app.get('/v1/leaderboard', async (request) => {
    const query = parseWith(boardSchema, request.query ?? {});
    const viewerId = request.authUser?.id ?? null;

    const rows = await runBoard(db, query.board, query.limit);
    return {
      board: query.board,
      windowDays: WINDOW_DAYS,
      entries: rows.map((row, index) => ({
        rank: index + 1,
        playerId: row.user_id,
        username: row.username,
        isViewer: viewerId !== null && row.user_id === viewerId,
        value: row.value,
        detail: row.detail,
      })),
    };
  });

  /** One player's own numbers. Private: these are not public in the way a leaderboard rank is. */
  app.get('/v1/statistics', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);

    /* Four independent aggregates, run together rather than in sequence: none of them depends on
     * another's result and the page renders all four at once. */
    const [upgrader, cases, battles, ledger, favourites] = await Promise.all([
      db.query<{
        rounds: string;
        wins: string;
        staked: string;
        returned: string;
        best_multiple: string | null;
      }>(
        `SELECT count(*)::text AS rounds,
                count(*) FILTER (WHERE outcome = 'win')::text AS wins,
                coalesce(sum(stake_value_minor), 0)::text AS staked,
                coalesce(sum(target_value_minor) FILTER (WHERE outcome = 'win'), 0)::text AS returned,
                max(target_value_minor::numeric / nullif(stake_value_minor, 0))::text AS best_multiple
           FROM upgrader_rounds WHERE user_id = $1`,
        [userId],
      ),
      db.query<{ opened: string; spent: string }>(
        `SELECT count(*)::text AS opened, coalesce(sum(price_minor), 0)::text AS spent
           FROM case_rounds WHERE user_id = $1`,
        [userId],
      ),
      db.query<{ seats: string; staked: string; won: string }>(
        `SELECT count(*)::text AS seats,
                coalesce(sum(p.staked_minor), 0)::text AS staked,
                coalesce(sum(p.payout_minor), 0)::text AS won
           FROM battle_players p WHERE p.user_id = $1`,
        [userId],
      ),
      /* Profit and loss straight off the wallet ledger rather than reconstructed from rounds: the
       * ledger is the only place that already has every source of money in one shape, including
       * quests, streaks, rakeback and referrals. */
      db.query<{ credited: string; debited: string }>(
        `SELECT coalesce(sum(amount_minor) FILTER (WHERE amount_minor > 0), 0)::text AS credited,
                coalesce(sum(-amount_minor) FILTER (WHERE amount_minor < 0), 0)::text AS debited
           FROM wallet_transactions WHERE user_id = $1`,
        [userId],
      ),
      db.query<{ name: string; opens: string; spent: string }>(
        `SELECT c.name, count(*)::text AS opens, sum(cr.price_minor)::text AS spent
           FROM case_rounds cr JOIN cases c ON c.id = cr.case_id
          WHERE cr.user_id = $1
          GROUP BY c.name
          ORDER BY count(*) DESC, sum(cr.price_minor) DESC
          LIMIT 5`,
        [userId],
      ),
    ]);

    const up = upgrader.rows[0];
    const rounds = Number(up?.rounds ?? '0');
    const wins = Number(up?.wins ?? '0');

    const wagered =
      BigInt(up?.staked ?? '0') +
      BigInt(cases.rows[0]?.spent ?? '0') +
      BigInt(battles.rows[0]?.staked ?? '0');
    const credited = BigInt(ledger.rows[0]?.credited ?? '0');
    const debited = BigInt(ledger.rows[0]?.debited ?? '0');

    return {
      totals: {
        wageredMinor: wagered.toString(),
        creditedMinor: credited.toString(),
        debitedMinor: debited.toString(),
        // Signed: a losing player must see a negative number rather than a zero.
        netMinor: (credited - debited).toString(),
      },
      upgrader: {
        rounds,
        wins,
        losses: rounds - wins,
        // Null rather than zero at nought rounds: a 0% win rate and no rounds played are
        // different facts, and rendering the second as the first is a lie about a player's record.
        winRate: rounds > 0 ? wins / rounds : null,
        stakedMinor: up?.staked ?? '0',
        returnedMinor: up?.returned ?? '0',
        bestMultiple: up?.best_multiple ? Number(up.best_multiple) : null,
      },
      cases: {
        opened: Number(cases.rows[0]?.opened ?? '0'),
        spentMinor: cases.rows[0]?.spent ?? '0',
      },
      battles: {
        seats: Number(battles.rows[0]?.seats ?? '0'),
        stakedMinor: battles.rows[0]?.staked ?? '0',
        wonMinor: battles.rows[0]?.won ?? '0',
      },
      favouriteCases: favourites.rows.map((row) => ({
        name: row.name,
        opens: Number(row.opens),
        spentMinor: row.spent,
      })),
    };
  });
}

/**
 * The three boards.
 *
 * Written as three separate statements rather than one parameterised query: the tables, the
 * aggregate and the ordering all differ, and a single query branching on a column name would be
 * both slower to plan and easier to get wrong.
 */
async function runBoard(
  db: Database,
  board: 'wagered' | 'multiplier' | 'crates',
  limit: number,
): Promise<BoardRow[]> {
  const window = `now() - interval '${WINDOW_DAYS} days'`;

  if (board === 'multiplier') {
    /* Biggest multiplier is a property of one round, not a sum, so this ranks rounds and reports
     * who owns them. DISTINCT ON keeps one row per player — their best — so a single player
     * cannot occupy the whole board with ten good pulls. */
    const result = await db.query<BoardRow>(
      `SELECT user_id, username, value, detail FROM (
         SELECT DISTINCT ON (r.user_id)
                r.user_id,
                ${maskedName('u.minecraft_username')} AS username,
                round(r.target_value_minor::numeric / nullif(r.stake_value_minor, 0), 2)::text AS value,
                r.target_value_minor::text AS detail
           FROM upgrader_rounds r JOIN users u ON u.id = r.user_id
          WHERE r.outcome = 'win' AND r.created_at >= ${window} AND r.stake_value_minor > 0
          ORDER BY r.user_id, (r.target_value_minor::numeric / nullif(r.stake_value_minor, 0)) DESC
       ) best
       ORDER BY value::numeric DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  if (board === 'crates') {
    const result = await db.query<BoardRow>(
      `SELECT cr.user_id, ${maskedName('u.minecraft_username')} AS username,
              count(*)::text AS value,
              sum(cr.price_minor)::text AS detail
         FROM case_rounds cr JOIN users u ON u.id = cr.user_id
        WHERE cr.created_at >= ${window}
        GROUP BY cr.user_id, u.minecraft_username
        ORDER BY count(*) DESC, sum(cr.price_minor) DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /* Total wagered spans three games, so the three are unioned before being summed. A player who
   * only opens crates and a player who only pulls the upgrader are on the same board. */
  const result = await db.query<BoardRow>(
    `WITH volume AS (
       SELECT user_id, stake_value_minor AS amount, created_at FROM upgrader_rounds
       UNION ALL
       SELECT user_id, price_minor, created_at FROM case_rounds
       UNION ALL
       -- Bot seats stake nothing and have no user, so they are excluded rather than summed as
       -- zero against a null id.
       SELECT p.user_id, p.staked_minor, b.created_at
         FROM battle_players p JOIN battles b ON b.id = p.battle_id
        WHERE p.user_id IS NOT NULL
     )
     SELECT v.user_id, ${maskedName('u.minecraft_username')} AS username,
            sum(v.amount)::text AS value,
            count(*)::text AS detail
       FROM volume v JOIN users u ON u.id = v.user_id
      WHERE v.created_at >= ${window}
      GROUP BY v.user_id, u.minecraft_username
      ORDER BY sum(v.amount) DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
