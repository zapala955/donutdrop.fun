import type { AppConfig } from '../config.js';
import { GAME_KINDS, PROMO_KINDS, staffPredicate } from './admin-stats.js';
import type { DbClient } from './db.js';

/**
 * staff-alerts.ts — the money half of the control bot's alert feed: a round won for a lot, a player
 * a long way up on the day, and an account anti-drain has just put a hold on.
 *
 * The bot asks for this every minute (routes/discord-control.ts) and posts what it has not posted
 * before to the staff channel, pinging the staff role. The dependency points the same way as the
 * counters next to it: a settlement never waits on Discord, and a Discord outage costs a message,
 * not a payout.
 *
 * Each list covers a window a good deal longer than the poll, so one missed or slow poll loses
 * nothing; the bot remembers what it has posted and says each thing once.
 */

/** How far back each poll looks. Several polls wide, so a late or failed one drops nothing. */
export const ALERT_WINDOW_MINUTES = 10;

/** The same figure the anti-drain monitor holds a player for: games and the promotions. */
const RESULT_KINDS: readonly string[] = [...GAME_KINDS, ...Object.keys(PROMO_KINDS)];

export interface BigWinAlert {
  readonly id: string;
  readonly game: string;
  readonly username: string;
  readonly wagerMinor: string;
  readonly payoutMinor: string;
  readonly at: string;
}

export interface ProfitAlert {
  readonly userId: string;
  readonly username: string;
  readonly netMinor: string;
}

export interface HoldAlert {
  readonly userId: string;
  readonly username: string;
  readonly reason: string;
  readonly at: string;
}

export interface MoneyAlerts {
  /** Where to post, when the admin panel names a channel; null leaves it to the bot's own setting. */
  readonly channelId: string | null;
  readonly roleId: string | null;
  readonly bigWinMinor: string;
  readonly dailyProfitMinor: string;
  readonly wins: readonly BigWinAlert[];
  readonly profits: readonly ProfitAlert[];
  readonly holds: readonly HoldAlert[];
}

/**
 * Every game's settled rounds in the window, one row per round as the wins board counts them
 * (routes/activity.ts `top-today`): a roulette spin is one row per player, a coinflip or a mines
 * duel one row for its winner. Crates and the upgrader are read from their rounds, not the ledger,
 * so an item won in custody mode is counted at its value the same as cash.
 */
const ROUNDS_SQL = `
  SELECT r.id, 'Cases'::text AS game, r.user_id, r.price_minor AS wager_minor,
         r.payout_minor, r.created_at AS at
    FROM case_rounds r WHERE r.created_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT r.id, 'Upgrader', r.user_id, r.stake_value_minor, r.payout_minor, r.created_at
    FROM upgrader_rounds r
   WHERE r.outcome = 'win' AND r.created_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT min(b.id::text)::uuid, 'Roulette', b.user_id, sum(b.stake_minor)::bigint,
         sum(COALESCE(b.payout_minor, 0))::bigint, r.settled_at
    FROM roulette_rounds r JOIN roulette_bets b ON b.round_id = r.id
   WHERE r.status = 'settled'
     -- closes_at carries the index; a round settles within a minute of closing.
     AND r.closes_at >= now() - make_interval(mins => $1 + 5)
     AND r.settled_at >= now() - make_interval(mins => $1)
   GROUP BY r.id, r.settled_at, b.user_id
  UNION ALL
  SELECT h.id, 'Blackjack', h.user_id,
         (h.stake_minor * CASE WHEN h.doubled THEN 2 ELSE 1 END)::bigint, h.payout_minor, h.settled_at
    FROM blackjack_hands h
   WHERE h.status = 'settled' AND h.settled_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT b.id, 'Crash', b.user_id, b.stake_minor, b.payout_minor, b.settled_at
    FROM crash_bets b
   WHERE b.status <> 'active' AND b.settled_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT g.id, 'Mines', g.user_id, g.stake_minor, g.payout_minor, g.settled_at
    FROM mines_games g
   WHERE g.status = 'settled' AND g.settled_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT g.id, 'Tower', g.user_id, g.stake_minor, g.payout_minor, g.settled_at
    FROM tower_games g
   WHERE g.status = 'settled' AND g.settled_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT g.id, 'Chicken', g.user_id, g.stake_minor, g.payout_minor, g.settled_at
    FROM chicken_games g
   WHERE g.status = 'settled' AND g.settled_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT b.id, 'Plinko', b.user_id, b.stake_minor, b.payout_minor, b.created_at
    FROM plinko_bets b WHERE b.created_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT g.id, 'Coinflip', g.winner_user_id, g.stake_minor, g.payout_minor, g.settled_at
    FROM coinflip_games g
   WHERE g.status = 'settled' AND g.winner_user_id IS NOT NULL
     AND g.settled_at >= now() - make_interval(mins => $1)
  UNION ALL
  SELECT g.id, 'Mines Duel', g.winner_user_id, g.stake_minor, g.payout_minor, g.settled_at
    FROM mines_duel_games g
   WHERE g.status = 'settled' AND g.outcome <> 'draw' AND g.winner_user_id IS NOT NULL
     AND g.settled_at >= now() - make_interval(mins => $1)`;

function idOrNull(value: bigint): string | null {
  return value > 0n ? value.toString() : null;
}

export async function moneyAlerts(client: DbClient, config: AppConfig): Promise<MoneyAlerts> {
  const bigWin = config.staffAlertBigWinMinor;
  const dailyProfit = config.staffAlertDailyProfitMinor;

  const wins =
    bigWin > 0n
      ? await client.query<{
          id: string;
          game: string;
          username: string;
          wager_minor: string;
          payout_minor: string;
          at: Date;
        }>(
          `SELECT w.id, w.game, u.minecraft_username AS username,
                  w.wager_minor::text AS wager_minor, w.payout_minor::text AS payout_minor, w.at
             FROM (${ROUNDS_SQL}) w
             JOIN users u ON u.id = w.user_id
            WHERE w.payout_minor - w.wager_minor >= $2::bigint
              AND NOT ${staffPredicate('u')}
            ORDER BY w.payout_minor - w.wager_minor DESC, w.at DESC
            LIMIT 20`,
          [ALERT_WINDOW_MINUTES, bigWin.toString()],
        )
      : { rows: [] };

  /* The anti-drain monitor's own query, with the alert's bar: whoever is that far up over a day,
   * on the games and the promotions together. Run the same way every minute already. */
  const profits =
    dailyProfit > 0n
      ? await client.query<{ user_id: string; username: string; net_minor: string }>(
          `SELECT t.user_id, u.minecraft_username AS username, SUM(t.amount_minor)::text AS net_minor
             FROM wallet_transactions t
             JOIN users u ON u.id = t.user_id
            WHERE t.created_at >= now() - interval '24 hours'
              AND t.kind = ANY($1::text[])
              AND NOT ${staffPredicate('u')}
            GROUP BY t.user_id, u.minecraft_username
           HAVING SUM(t.amount_minor) >= $2::numeric
            ORDER BY SUM(t.amount_minor) DESC
            LIMIT 10`,
          [RESULT_KINDS, dailyProfit.toString()],
        )
      : { rows: [] };

  /* Holds nobody placed by hand: anti-drain's. One an operator placed, they already know about. */
  const holds = await client.query<{
    id: string;
    username: string;
    reason: string;
    at: Date;
  }>(
    `SELECT u.id, u.minecraft_username AS username, u.payout_hold_reason AS reason,
            u.payout_hold_at AS at
       FROM users u
      WHERE u.payout_hold_reason IS NOT NULL AND u.payout_hold_by IS NULL
        AND u.payout_hold_at >= now() - make_interval(mins => $1)
      ORDER BY u.payout_hold_at DESC
      LIMIT 10`,
    [ALERT_WINDOW_MINUTES],
  );

  return {
    channelId: idOrNull(config.staffAlertChannelId),
    roleId: idOrNull(config.staffAlertRoleId),
    bigWinMinor: bigWin.toString(),
    dailyProfitMinor: dailyProfit.toString(),
    wins: wins.rows.map((row) => ({
      id: row.id,
      game: row.game,
      username: row.username,
      wagerMinor: row.wager_minor,
      payoutMinor: row.payout_minor,
      at: new Date(row.at).toISOString(),
    })),
    profits: profits.rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      netMinor: row.net_minor,
    })),
    holds: holds.rows.map((row) => ({
      userId: row.id,
      username: row.username,
      reason: row.reason,
      at: new Date(row.at).toISOString(),
    })),
  };
}
