import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { maskedName } from '../lib/masked-name.js';
import { staffPredicate } from '../lib/admin-stats.js';
import { notDemoPredicate } from '../lib/media-test.js';
import { historyPageSql, ROUND_GAME_KEYS, roundGameName, statisticsSql } from '../lib/player-rounds.js';
import { parseWith } from '../lib/validation.js';
import { levelFor } from '../lib/vip.js';

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

  /**
   * The card behind a chat avatar: what a player has played, never what they have won or lost.
   *
   * Public, like the chat it opens from, and like the leaderboard it echoes: lifetime wagered (the
   * figure the VIP ladder runs on), the number of bets, the favourite game, the biggest win (profit
   * on one round) and the best multiplier. Deliberately absent: profit and loss, the balance,
   * deposits and withdrawals -- a card anyone can open must not say whether a player is up or down
   * -- and the name, which the page already has in its masked form and which this route would
   * otherwise hand out unmasked against a bare id.
   *
   * Cached per player for a minute: a busy chat clicks the same few heads over and over, and the
   * biggest-win scan reads every round the player has played.
   */
  const cardCache = new Map<string, { at: number; body: PlayerCard }>();
  app.get(
    '/v1/players/:id/card',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = parseWith(cardParams, request.params);
      const cached = cardCache.get(id);
      if (cached && Date.now() - cached.at < CARD_TTL_MS) return cached.body;
      const body = await playerCard(db, config, id);
      if (!body) throw new AppError(404, 'PLAYER_NOT_FOUND', 'That player was not found');
      if (cardCache.size >= CARD_CACHE_MAX) cardCache.delete(cardCache.keys().next().value!);
      cardCache.set(id, { at: Date.now(), body });
      return body;
    },
  );

  /**
   * One player's own numbers, every game. Private: these are not public in the way a leaderboard
   * rank is.
   *
   * It used to count the upgrader, crates and battles only, and took its "net profit / loss" off
   * the whole wallet ledger -- deposits, withdrawals and tips included -- which made it closer to
   * the balance than to a result. Wins and losses now come from the rounds themselves
   * (lib/player-rounds.ts), which reconcile to the ledger's stake and payout entries game by game;
   * rewards are counted beside them, not inside them.
   */
  app.get('/v1/statistics', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);

    const [games, rewards, favourites] = await Promise.all([
      db.query<StatisticsGameRow>(statisticsSql(), [userId]),
      db.query<{ total: string }>(
        `SELECT coalesce(sum(amount_minor), 0)::text AS total
           FROM wallet_transactions WHERE user_id = $1 AND kind = ANY($2::text[])`,
        [userId, REWARD_KINDS],
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
    return statisticsBody(games.rows, rewards.rows[0]?.total ?? '0', favourites.rows);
  });

  /**
   * The player's own rounds, every game, newest first: the history page. Pages by time -- `next` is
   * the cursor for the page after -- and filters to one game.
   */
  app.get('/v1/history', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const game = query.game ?? null;
    const params: unknown[] = [userId, query.before ?? 'infinity', query.limit];
    if (game) params.push(game);
    const result = await db.query<HistoryRow>(historyPageSql(game), params);
    return historyBody(result.rows, query.limit);
  });
}

/** Ledger entries that are rewards: money the site gave, not money a game paid. */
export const REWARD_KINDS = [
  'rakeback_claim',
  'streak_reward',
  'daily_code_reward',
  'rain_claim',
  'signup_bonus',
  'referral_bonus',
  'referral_revshare',
  'discord_join_reward',
  'discord_tag_reward',
  'creator_royalty',
];

/* A cursor exactly as historyPageSql writes it: UTC, to the microsecond, which a JS Date cannot
 * hold -- rounded to the millisecond, it could skip a round placed in the same millisecond. */
const historySchema = z
  .object({
    game: z.enum(ROUND_GAME_KEYS).optional(),
    before: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export interface StatisticsGameRow {
  game: string;
  rounds: number;
  wins: number;
  wagered: string;
  paid: string;
  best: string | null;
  top_wager: string | null;
  top_payout: string | null;
}

/** Two decimals, rounded down: a multiplier is never shown as more than it was. */
const floor2 = (value: number) => Math.floor(value * 100) / 100;

export function statisticsBody(
  rows: readonly StatisticsGameRow[],
  rewardsMinor: string,
  favouriteCases: readonly { name: string; opens: string; spent: string }[],
) {
  let wagered = 0n;
  let paid = 0n;
  let rounds = 0;
  let wins = 0;
  let best: number | null = null;
  let biggest: { game: string; wager: bigint; payout: bigint } | null = null;
  let favourite: StatisticsGameRow | null = null;
  for (const row of rows) {
    wagered += BigInt(row.wagered);
    paid += BigInt(row.paid);
    rounds += row.rounds;
    wins += row.wins;
    if (row.best !== null && (best === null || Number(row.best) > best)) best = Number(row.best);
    if (row.top_wager !== null && row.top_payout !== null) {
      const wager = BigInt(row.top_wager);
      const payout = BigInt(row.top_payout);
      if (!biggest || payout - wager > biggest.payout - biggest.wager) biggest = { game: row.game, wager, payout };
    }
    if (!favourite || row.rounds > favourite.rounds) favourite = row;
  }
  return {
    totals: {
      rounds,
      wins,
      // Null rather than zero at nought rounds: no rounds played is not a 0% record.
      winRate: rounds > 0 ? wins / rounds : null,
      wageredMinor: wagered.toString(),
      paidMinor: paid.toString(),
      // Signed: a losing player sees a negative number, never a zero.
      netMinor: (paid - wagered).toString(),
      rewardsMinor,
    },
    favouriteGame: favourite ? { game: favourite.game, name: roundGameName(favourite.game) } : null,
    bestMultiplier: best === null ? null : floor2(best),
    biggestWin: biggest
      ? {
          game: biggest.game,
          name: roundGameName(biggest.game),
          wagerMinor: biggest.wager.toString(),
          payoutMinor: biggest.payout.toString(),
          multiplier: floor2(Number(biggest.payout) / Number(biggest.wager)),
        }
      : null,
    games: rows.map((row) => ({
      game: row.game,
      name: roundGameName(row.game),
      rounds: row.rounds,
      wins: row.wins,
      wageredMinor: row.wagered,
      paidMinor: row.paid,
      netMinor: (BigInt(row.paid) - BigInt(row.wagered)).toString(),
      bestMultiplier: row.best === null ? null : floor2(Number(row.best)),
    })),
    favouriteCases: favouriteCases.map((row) => ({
      name: row.name,
      opens: Number(row.opens),
      spentMinor: row.spent,
    })),
  };
}

export interface HistoryRow {
  game: string;
  id: string;
  at: string;
  wager: string;
  payout: string;
  detail: string | null;
}

export function historyBody(rows: readonly HistoryRow[], limit: number) {
  return {
    rounds: rows.map((row) => ({
      game: row.game,
      name: roundGameName(row.game),
      id: row.id,
      at: row.at,
      wagerMinor: row.wager,
      payoutMinor: row.payout,
      multiplier: BigInt(row.wager) > 0n ? floor2(Number(row.payout) / Number(row.wager)) : null,
      detail: row.detail || null,
    })),
    // A full page may have more behind it; a short one is the end.
    next: rows.length === limit ? rows[rows.length - 1]!.at : null,
    games: ROUND_GAME_KEYS.map((game) => ({ game, name: roundGameName(game) })),
  };
}

/**
 * The three boards. Staff are not on any of them -- admins, the developer login, system accounts and
 * media test twins (staffPredicate, the same rule the admin figures use): a board is a contest for
 * players, and an admin testing a game is not one.
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
            AND ${notDemoPredicate('u')} AND NOT ${staffPredicate('u')}
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
        WHERE cr.created_at >= ${window} AND ${notDemoPredicate('u')} AND NOT ${staffPredicate('u')}
        GROUP BY cr.user_id, u.minecraft_username
        ORDER BY count(*) DESC, sum(cr.price_minor) DESC
        LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /* Total wagered, every game: read from wager_events, the one row recordWager writes for every
   * bet on the site (crates and battle seats as 'case'), which is what VIP, rakeback and the races
   * already count. It used to union three game tables by hand -- the upgrader, crates and battles
   * -- so Crash, Mines, Tower, Chicken, Plinko, Dice, Blackjack, Roulette, Coinflip and Mines Duel
   * never reached the board: two thirds of the volume, and most of the players on it. */
  const result = await db.query<BoardRow>(
    `SELECT w.user_id, ${maskedName('u.minecraft_username')} AS username,
            sum(w.amount_minor)::text AS value,
            count(*)::text AS detail
       FROM wager_events w JOIN users u ON u.id = w.user_id
      WHERE w.created_at >= ${window} AND ${notDemoPredicate('u')} AND NOT ${staffPredicate('u')}
      GROUP BY w.user_id, u.minecraft_username
      ORDER BY sum(w.amount_minor) DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

const cardParams = z.object({ id: z.uuid() }).strict();
const CARD_TTL_MS = 60_000;
const CARD_CACHE_MAX = 1_000;

/** wager_events.source as a player reads it. */
const GAME_NAMES: Readonly<Record<string, string>> = {
  upgrader: 'Upgrader',
  case: 'Cases',
  piggy_bank: 'Piggy Bank',
  skill_duel: 'Duels',
  slither_arena: 'Slither',
  roulette: 'Roulette',
  blackjack: 'Blackjack',
  crash: 'Crash',
  mines: 'Mines',
  plinko: 'Plinko',
  coinflip: 'Coinflip',
  dice: 'Dice',
  fishing: 'Fishing',
  ice_fishing: 'Ice Fishing',
  derby: 'Mob Derby',
  mines_duel: 'Mines Duel',
  tower: 'Tower',
  chicken: 'Chicken',
  slots: 'Slots',
};

export interface PlayerCard {
  playerId: string;
  joinedAt: string;
  staff: boolean;
  vip: { level: number; tier: string; label: string; isHighRoller: boolean } | null;
  wageredMinor: string;
  bets: number;
  favouriteGame: string | null;
  biggestWin: { game: string; wagerMinor: string; payoutMinor: string; multiplier: number } | null;
  bestMultiplier: number | null;
}

async function playerCard(db: Database, config: AppConfig, userId: string): Promise<PlayerCard | null> {
  const user = await db.query<{ created_at: Date; role: string; wagered_minor: string | null }>(
    `SELECT u.created_at, u.role, t.wagered_minor
       FROM users u LEFT JOIN user_wager_totals t ON t.user_id = u.id
      WHERE u.id = $1 AND ${notDemoPredicate('u')}`,
    [userId],
  );
  const row = user.rows[0];
  if (!row) return null;

  const [bets, rounds] = await Promise.all([
    db.query<{ bets: string; favourite: string | null }>(
      `SELECT count(*)::text AS bets,
              (SELECT source FROM wager_events WHERE user_id = $1
                GROUP BY source ORDER BY count(*) DESC, max(created_at) DESC LIMIT 1) AS favourite
         FROM wager_events WHERE user_id = $1`,
      [userId],
    ),
    /* Every settled round the player has played, one row per round as the wins board counts them:
     * a roulette spin is one row however many chips it carried, and a coinflip or a mines duel
     * counts for its winner. Each branch reads the player's own rows through the table's
     * per-player index. */
    db.query<{ game: string | null; wager: string | null; payout: string | null; best: string | null }>(
      `WITH rounds AS (
         SELECT 'Cases'::text AS game, price_minor AS wager, payout_minor AS payout
           FROM case_rounds WHERE user_id = $1
         UNION ALL
         SELECT 'Upgrader', stake_value_minor, payout_minor
           FROM upgrader_rounds WHERE user_id = $1 AND outcome = 'win'
         UNION ALL
         SELECT 'Roulette', sum(stake_minor)::bigint, sum(COALESCE(payout_minor, 0))::bigint
           FROM roulette_bets WHERE user_id = $1 GROUP BY round_id
         UNION ALL
         SELECT 'Blackjack', (stake_minor * CASE WHEN doubled THEN 2 ELSE 1 END)::bigint, payout_minor
           FROM blackjack_hands WHERE user_id = $1 AND status = 'settled'
         UNION ALL
         SELECT 'Crash', stake_minor, payout_minor FROM crash_bets WHERE user_id = $1 AND status <> 'active'
         UNION ALL
         SELECT 'Mines', stake_minor, payout_minor FROM mines_games WHERE user_id = $1 AND status = 'settled'
         UNION ALL
         SELECT 'Tower', stake_minor, payout_minor FROM tower_games WHERE user_id = $1 AND status = 'settled'
         UNION ALL
         SELECT 'Chicken', stake_minor, payout_minor FROM chicken_games WHERE user_id = $1 AND status = 'settled'
         UNION ALL
         SELECT 'Plinko', stake_minor, payout_minor FROM plinko_bets WHERE user_id = $1
         UNION ALL
         SELECT 'Slots', stake_minor, payout_minor FROM slots_spins WHERE user_id = $1
         UNION ALL
         SELECT 'Dice', stake_minor, payout_minor FROM dice_bets WHERE user_id = $1
         UNION ALL
         SELECT 'Fishing', stake_minor, payout_minor FROM fishing_casts WHERE user_id = $1 AND status <> 'open'
         UNION ALL
         SELECT 'Ice Fishing', stake_minor, payout_minor FROM ice_fishing_games WHERE user_id = $1 AND status = 'settled'
         UNION ALL
         SELECT 'Mob Derby', stake_minor, payout_minor FROM derby_races WHERE user_id = $1
         UNION ALL
         SELECT 'Coinflip', stake_minor, payout_minor FROM coinflip_games
          WHERE (host_user_id = $1 OR opponent_user_id = $1) AND winner_user_id = $1 AND status = 'settled'
         UNION ALL
         SELECT 'Mines Duel', stake_minor, payout_minor FROM mines_duel_games
          WHERE (host_user_id = $1 OR opponent_user_id = $1) AND winner_user_id = $1
            AND status = 'settled' AND outcome <> 'draw'
         UNION ALL
         SELECT 'Case Battles', staked_minor, payout_minor FROM battle_players WHERE user_id = $1
       ),
            wins AS (SELECT * FROM rounds WHERE payout > wager AND wager > 0)
       SELECT top.game, top.wager::text AS wager, top.payout::text AS payout,
              (SELECT max(payout::numeric / wager) FROM wins)::text AS best
         FROM (SELECT 1) one
         LEFT JOIN LATERAL (
           SELECT game, wager, payout FROM wins ORDER BY payout - wager DESC LIMIT 1
         ) top ON true`,
      [userId],
    ),
  ]);

  const wagered = BigInt(row.wagered_minor ?? '0');
  const level = levelFor(wagered);
  const top = rounds.rows[0];
  const favourite = bets.rows[0]?.favourite ?? null;
  return {
    playerId: userId,
    joinedAt: new Date(row.created_at).toISOString(),
    staff: row.role === 'admin',
    vip: config.vipEnabled
      ? { level: level.level, tier: level.tier, label: level.label, isHighRoller: level.tier === 'high_roller' }
      : null,
    wageredMinor: wagered.toString(),
    bets: Number(bets.rows[0]?.bets ?? '0'),
    favouriteGame: favourite ? (GAME_NAMES[favourite] ?? null) : null,
    biggestWin:
      top?.game && top.wager && top.payout
        ? {
            game: top.game,
            wagerMinor: top.wager,
            payoutMinor: top.payout,
            multiplier: Math.floor((Number(top.payout) / Number(top.wager)) * 100) / 100,
          }
        : null,
    bestMultiplier: top?.best ? Math.floor(Number(top.best) * 100) / 100 : null,
  };
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
