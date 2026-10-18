import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Database } from '../lib/db.js';
import { levelFor } from '../lib/vip.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith } from '../lib/validation.js';

/**
 * The live feed.
 *
 * These kinds of event share one chronological stream:
 *
 *   case      a crate was opened — what it cost, what it paid.
 *   upgrade   an upgrader round settled — stake in, payout out.
 *   roulette  one row per player and spin — every chip aggregated into the real round total.
 *   blackjack a hand settled — everything on the table, and what came back.
 *   crash     a bet cashed out or busted.
 *   mines     a game cashed out or hit TNT.
 *   tower     a climb cashed out or hit TNT.
 *   chicken   a run across the rails cashed out or met a minecart.
 *   plinko    a ball landed in a slot.
 *   slots     a spin settled, its free spins included.
 *   dice      a roll landed over or under its line.
 *   minesduel a mines duel was decided, as one row for its winner.
 *   faction   a wager was credited to a team in the running faction war.
 *
 * Every settled round appears, win or lose. An earlier version filtered upgrader losses out,
 * which made the feed a highlight reel: a wall of wins with the failures quietly removed. On a
 * gambling site that is not a neutral omission — it misrepresents the odds to anyone watching it
 * to decide whether to play. Losses are the majority of rounds and they belong here.
 *
 * Each row carries what it cost and what it returned, so the multiple is derived from real
 * figures rather than implied by an item's name.
 *
 * Every identifier in these queries is a literal in the SQL text and every value arrives as a
 * bound parameter. There is no string interpolation anywhere in this file.
 */

const activityQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
  .strict();

const topTodayQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(20).default(7) })
  .strict();

/* Every open home page asks for today's top pulls after every settled round, and the answer only
 * changes when somebody pulls something big. A few seconds of reuse turns a query per viewer per
 * round into one every few seconds. */
const TOP_TODAY_TTL_MS = 10_000;

/* "Playing" means a round placed or settled this recently. Every lobby asks on load and every
 * half minute, so one answer is shared for a few seconds rather than counted per viewer. */
const PLAYING_WINDOW_MINUTES = 15;
const PLAYING_TTL_MS = 20_000;

/**
 * Usernames are masked to a first character and a run of asterisks.
 *
 * The feed is public and the rounds are not: showing who lost how much, to anyone who loads the
 * page, is a privacy problem dressed up as social proof.
 *
 * The length used to be preserved so rows stayed visually distinct. It is fixed now: a name's
 * length is a strong identifier among a few hundred regulars, and it was the detail that let a
 * watcher follow one player down the feed. See lib/masked-name.ts.
 */
const MASKED_NAME = maskedName('u.minecraft_username');

export async function registerActivityRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  app.get('/v1/activity/recent', async (request) => {
    const query = parseWith(activityQuery, request.query);
    const result = await db.query(
      `SELECT activity.* FROM (
         SELECT r.id, 'case'::text AS kind, r.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                cs.name AS source_name,
                NULL::char(7) AS accent,
                r.price_minor AS wager_minor,
                COALESCE(r.payout_minor, '0')::bigint AS payout_minor,
                c.id AS catalog_item_id, c.minecraft_name, c.display_name, c.image_url,
                c.unit_value_minor, c.metadata,
                r.awarded_quantity AS quantity,
                ((r.awarded_weight::bigint * 1000000) / r.total_weight)::integer AS chance_ppm,
                NULL::smallint AS game_result
           FROM case_rounds r
           JOIN users u ON u.id = r.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = r.user_id
           JOIN cases cs ON cs.id = r.case_id
           JOIN catalog_items c ON c.id = r.awarded_catalog_item_id
         UNION ALL
         SELECT r.id, 'upgrade'::text AS kind, r.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Upgrader'::text AS source_name,
                NULL::char(7) AS accent,
                r.stake_value_minor AS wager_minor,
                COALESCE(r.payout_minor, '0')::bigint AS payout_minor,
                c.id AS catalog_item_id, c.minecraft_name, c.display_name, c.image_url,
                c.unit_value_minor, c.metadata,
                r.target_quantity AS quantity, r.chance_ppm,
                NULL::smallint AS game_result
           FROM upgrader_rounds r
           JOIN users u ON u.id = r.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = r.user_id
           JOIN catalog_items c ON c.id = r.target_catalog_item_id
         UNION ALL
         SELECT min(b.id::text)::uuid AS id,
                'roulette'::text AS kind, r.settled_at AS created_at,
                u.id AS player_id,
                max(${MASKED_NAME}) AS player,
                max(t.wagered_minor) AS wagered_minor,
                'Roulette'::text AS source_name,
                NULL::char(7) AS accent,
                sum(b.stake_minor)::bigint AS wager_minor,
                sum(COALESCE(b.payout_minor, '0'))::bigint AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                count(*)::integer AS quantity,
                0 AS chance_ppm,
                r.result AS game_result
           FROM roulette_bets b
           JOIN roulette_rounds r ON r.id = b.round_id AND r.status = 'settled'
           JOIN users u ON u.id = b.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = b.user_id
          GROUP BY r.id, r.settled_at, r.result, u.id
         UNION ALL
         /* A settled blackjack hand. A double put twice the stake on the table, and the feed shows
            what was actually risked, so the multiple reads true for a doubled hand too. */
         SELECT h.id, 'blackjack'::text AS kind, h.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Blackjack'::text AS source_name,
                NULL::char(7) AS accent,
                (h.stake_minor * CASE WHEN h.doubled THEN 2 ELSE 1 END)::bigint AS wager_minor,
                h.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM blackjack_hands h
           JOIN users u ON u.id = h.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = h.user_id
          WHERE h.status = 'settled'
         UNION ALL
         /* A crash bet, once it has cashed out or busted. Its moment is when it was decided, so a
            cash-out appears mid-round and a loss when the round busts. */
         SELECT b.id, 'crash'::text AS kind, b.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Crash'::text AS source_name,
                NULL::char(7) AS accent,
                b.stake_minor AS wager_minor,
                b.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM crash_bets b
           JOIN users u ON u.id = b.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = b.user_id
          WHERE b.status <> 'active'
         UNION ALL
         /* A finished mines game: the stake, and what it cashed out for (nothing, on TNT). */
         SELECT g.id, 'mines'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Mines'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM mines_games g
           JOIN users u ON u.id = g.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = g.user_id
          WHERE g.status = 'settled'
         UNION ALL
         /* A finished tower climb: the stake, and what it cashed out for (nothing, on TNT). */
         SELECT g.id, 'tower'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Tower'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM tower_games g
           JOIN users u ON u.id = g.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = g.user_id
          WHERE g.status = 'settled'
         UNION ALL
         /* A finished chicken run: the stake, and what it cashed out for (nothing, on a minecart). */
         SELECT g.id, 'chicken'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Chicken'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM chicken_games g
           JOIN users u ON u.id = g.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = g.user_id
          WHERE g.status = 'settled'
         UNION ALL
         /* A plinko ball: the stake, and what its slot paid. Every ball settles as it is placed.
            Balls arrive several a second, so this branch reads only the newest $1 of them off
            their index: the newest $1 of the whole feed cannot include an older ball. */
         SELECT b.id, 'plinko'::text AS kind, b.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Plinko'::text AS source_name,
                NULL::char(7) AS accent,
                b.stake_minor AS wager_minor,
                b.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM (SELECT * FROM plinko_bets ORDER BY created_at DESC LIMIT $1) b
           JOIN users u ON u.id = b.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = b.user_id
         UNION ALL
         /* A slots spin: the stake, and what the round paid, free spins included. Settled as it is
            placed and played on auto-spin, so read like Plinko: only the newest $1 of them. */
         SELECT s.id, 'slots'::text AS kind, s.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                CASE s.machine WHEN 'monument' THEN 'Ocean Monument' ELSE 'Slots' END AS source_name,
                NULL::char(7) AS accent,
                s.stake_minor AS wager_minor,
                s.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM (SELECT * FROM slots_spins ORDER BY created_at DESC LIMIT $1) s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = s.user_id
         UNION ALL
         /* A dice roll: the stake, and what it paid (nothing on a miss). Rolls come as fast as balls,
            so this branch reads only the newest $1 too. */
         SELECT b.id, 'dice'::text AS kind, b.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Dice'::text AS source_name,
                NULL::char(7) AS accent,
                b.stake_minor AS wager_minor,
                b.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM (SELECT * FROM dice_bets ORDER BY created_at DESC LIMIT $1) b
           JOIN users u ON u.id = b.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = b.user_id
         UNION ALL
         /* A landed coinflip, as one row for the winner: their stake against the pot they took.
            The loser's half is the same game, and two rows for one flip would read as two. */
         SELECT g.id, 'coinflip'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Coinflip'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM (SELECT * FROM coinflip_games WHERE status = 'settled'
                  ORDER BY settled_at DESC LIMIT $1) g
           JOIN users u ON u.id = g.winner_user_id
           LEFT JOIN user_wager_totals t ON t.user_id = g.winner_user_id
         UNION ALL
         /* A decided mines duel, as one row for the winner: their stake against the pot they took.
            The loser's half is the same duel, and two rows for one duel would read as two. A draw
            returned both stakes and is not a result worth a row. */
         SELECT g.id, 'minesduel'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Mines Duel'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM (SELECT * FROM mines_duel_games WHERE status = 'settled' AND outcome <> 'draw'
                  ORDER BY settled_at DESC LIMIT $1) g
           JOIN users u ON u.id = g.winner_user_id
           LEFT JOIN user_wager_totals t ON t.user_id = g.winner_user_id
         UNION ALL
         /* Team contributions. Not a round: there is no payout and no multiple, so those columns
            are null rather than zero. A zero would render as "0.00x" and read as a total loss. */
         SELECT fc.id, 'faction'::text AS kind, fc.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                f.name AS source_name,
                f.color AS accent,
                fc.amount_minor AS wager_minor,
                NULL::bigint AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM faction_contributions fc
           JOIN users u ON u.id = fc.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = fc.user_id
           JOIN factions f ON f.id = fc.faction_id
       ) activity
       -- Media test twins play with play money; their rounds are not the site's (lib/media-test.ts).
       WHERE NOT EXISTS (SELECT 1 FROM users d WHERE d.id = activity.player_id AND d.demo_of IS NOT NULL)
       ORDER BY activity.created_at DESC, activity.id DESC
       LIMIT $1`,
      [query.limit],
    );
    /* The lifetime total is turned into a TIER LABEL here and the raw figure is dropped.
     *
     * The feed masks usernames on purpose — who lost how much is not public. `player_id` is an
     * opaque internal UUID used by the same-origin avatar proxy; it does not put the Minecraft
     * username in the page or in a third-party request. "Gold II" remains a coarse bucket attached
     * to a name that is already a letter and some asterisks; the number behind it never leaves. */
    return {
      activities: result.rows.map((row) => {
        const { wagered_minor: wagered, ...rest } = row as Record<string, unknown> & {
          wagered_minor?: string | null;
        };
        if (!config.vipEnabled) return rest;
        const level = levelFor(BigInt(wagered ?? '0'));
        return { ...rest, vip: { tier: level.tier, label: level.label } };
      }),
    };
  });

  /**
   * The home page's "Biggest pulls today": the day's winning crate and upgrader pulls, biggest
   * payout first.
   *
   * It used to be picked out of the live feed's last forty rows in the browser, and that window is
   * minutes wide on a busy evening, so the day's best pulls fell out of it and the list looked as
   * though it had reset. This reads the whole day. The day is the UTC day, the one quests and the
   * daily reward already run on.
   *
   * A pull is a win: it paid more than it cost. Rows have the live feed's shape, so the page reads
   * them the same way, without the wager total the feed turns into a VIP label.
   */
  let topToday: { at: number; limit: number; rows: unknown[] } | null = null;
  /**
   * Today's biggest wins, for the home page: every game, the day's winning rounds (they returned
   * more than they cost), biggest profit first.
   *
   * Ranked by PROFIT, not payout. Ranked by payout, a large stake cashed out at 1.01x would sit
   * above a real hit; what a watcher means by "a big win" is how much somebody came away up, and
   * that is the figure the card prints. A round that returned less than it cost is a loss and is not
   * here; the live feed at the foot of the page shows every round, wins and losses alike.
   *
   * One row per round, as the feed shows them: a roulette spin is one row per player, a coinflip
   * or a mines duel one row for its winner. The day is the UTC day. Media test twins are left out,
   * as they are from the feed (lib/media-test.ts).
   */
  app.get('/v1/activity/top-today', async (request) => {
    const query = parseWith(topTodayQuery, request.query ?? {});
    if (topToday && topToday.limit === query.limit && Date.now() - topToday.at < TOP_TODAY_TTL_MS) {
      return { activities: topToday.rows };
    }
    const result = await db.query(
      `WITH day AS (SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS at)
       SELECT win.* FROM (
         SELECT r.id, 'case'::text AS kind, r.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                cs.name AS source_name,
                NULL::char(7) AS accent,
                r.price_minor AS wager_minor,
                r.payout_minor AS payout_minor,
                c.id AS catalog_item_id, c.minecraft_name, c.display_name, c.image_url,
                c.unit_value_minor, c.metadata,
                r.awarded_quantity AS quantity,
                ((r.awarded_weight::bigint * 1000000) / r.total_weight)::integer AS chance_ppm,
                NULL::smallint AS game_result
           FROM case_rounds r, day, cases cs, users u, catalog_items c
          WHERE cs.id = r.case_id AND u.id = r.user_id AND c.id = r.awarded_catalog_item_id
            AND r.created_at >= day.at
            AND r.payout_minor > r.price_minor
         UNION ALL
         SELECT r.id, 'upgrade'::text AS kind, r.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Upgrader'::text AS source_name,
                NULL::char(7) AS accent,
                r.stake_value_minor AS wager_minor,
                r.payout_minor AS payout_minor,
                c.id AS catalog_item_id, c.minecraft_name, c.display_name, c.image_url,
                c.unit_value_minor, c.metadata,
                r.target_quantity AS quantity, r.chance_ppm,
                NULL::smallint AS game_result
           FROM upgrader_rounds r, day, users u, catalog_items c
          WHERE u.id = r.user_id AND c.id = r.target_catalog_item_id
            AND r.created_at >= day.at
            AND r.outcome = 'win'
            AND r.payout_minor > r.stake_value_minor
         UNION ALL
         /* A roulette spin, one row per player: every chip they had on it, against what it paid. */
         SELECT min(b.id::text)::uuid AS id, 'roulette'::text AS kind, r.settled_at AS created_at,
                u.id AS player_id,
                max(${MASKED_NAME}) AS player,
                'Roulette'::text AS source_name,
                NULL::char(7) AS accent,
                sum(b.stake_minor)::bigint AS wager_minor,
                sum(COALESCE(b.payout_minor, '0'))::bigint AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                count(*)::integer AS quantity, 0 AS chance_ppm,
                r.result AS game_result
           FROM roulette_bets b, day, roulette_rounds r, users u
          WHERE r.id = b.round_id AND r.status = 'settled' AND u.id = b.user_id
            AND r.settled_at >= day.at
          GROUP BY r.id, r.settled_at, r.result, u.id
         HAVING sum(COALESCE(b.payout_minor, '0')) > sum(b.stake_minor)
         UNION ALL
         SELECT h.id, 'blackjack'::text AS kind, h.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Blackjack'::text AS source_name,
                NULL::char(7) AS accent,
                (h.stake_minor * CASE WHEN h.doubled THEN 2 ELSE 1 END)::bigint AS wager_minor,
                h.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM blackjack_hands h, day, users u
          WHERE u.id = h.user_id AND h.status = 'settled' AND h.settled_at >= day.at
            AND h.payout_minor > h.stake_minor * CASE WHEN h.doubled THEN 2 ELSE 1 END
         UNION ALL
         SELECT b.id, 'crash'::text AS kind, b.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Crash'::text AS source_name,
                NULL::char(7) AS accent,
                b.stake_minor AS wager_minor,
                b.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM crash_bets b, day, users u
          WHERE u.id = b.user_id AND b.status <> 'active' AND b.settled_at >= day.at
            AND b.payout_minor > b.stake_minor
         UNION ALL
         SELECT g.id, 'mines'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Mines'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM mines_games g, day, users u
          WHERE u.id = g.user_id AND g.status = 'settled' AND g.settled_at >= day.at
            AND g.payout_minor > g.stake_minor
         UNION ALL
         SELECT g.id, 'tower'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Tower'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM tower_games g, day, users u
          WHERE u.id = g.user_id AND g.status = 'settled' AND g.settled_at >= day.at
            AND g.payout_minor > g.stake_minor
         UNION ALL
         SELECT g.id, 'chicken'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Chicken'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM chicken_games g, day, users u
          WHERE u.id = g.user_id AND g.status = 'settled' AND g.settled_at >= day.at
            AND g.payout_minor > g.stake_minor
         UNION ALL
         SELECT b.id, 'plinko'::text AS kind, b.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Plinko'::text AS source_name,
                NULL::char(7) AS accent,
                b.stake_minor AS wager_minor,
                b.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM plinko_bets b, day, users u
          WHERE u.id = b.user_id AND b.created_at >= day.at
            AND b.payout_minor > b.stake_minor
         UNION ALL
         SELECT s.id, 'slots'::text AS kind, s.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                CASE s.machine WHEN 'monument' THEN 'Ocean Monument' ELSE 'Slots' END AS source_name,
                NULL::char(7) AS accent,
                s.stake_minor AS wager_minor,
                s.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM slots_spins s, day, users u
          WHERE u.id = s.user_id AND s.created_at >= day.at
            AND s.payout_minor > s.stake_minor
         UNION ALL
         SELECT b.id, 'dice'::text AS kind, b.created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Dice'::text AS source_name,
                NULL::char(7) AS accent,
                b.stake_minor AS wager_minor,
                b.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM dice_bets b, day, users u
          WHERE u.id = b.user_id AND b.created_at >= day.at
            AND b.payout_minor > b.stake_minor
         UNION ALL
         /* A coinflip or a mines duel, as one row for its winner: their stake against the pot. */
         SELECT g.id, 'coinflip'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Coinflip'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM coinflip_games g, day, users u
          WHERE u.id = g.winner_user_id AND g.status = 'settled' AND g.settled_at >= day.at
            AND g.payout_minor > g.stake_minor
         UNION ALL
         SELECT g.id, 'minesduel'::text AS kind, g.settled_at AS created_at, u.id AS player_id,
                ${MASKED_NAME} AS player,
                'Mines Duel'::text AS source_name,
                NULL::char(7) AS accent,
                g.stake_minor AS wager_minor,
                g.payout_minor AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity, 0 AS chance_ppm,
                NULL::smallint AS game_result
           FROM mines_duel_games g, day, users u
          WHERE u.id = g.winner_user_id AND g.status = 'settled' AND g.outcome <> 'draw'
            AND g.settled_at >= day.at
            AND g.payout_minor > g.stake_minor
       ) win
       WHERE NOT EXISTS (SELECT 1 FROM users d WHERE d.id = win.player_id AND d.demo_of IS NOT NULL)
       ORDER BY (win.payout_minor - win.wager_minor) DESC, win.created_at DESC
       LIMIT $1`,
      [query.limit],
    );
    topToday = { at: Date.now(), limit: query.limit, rows: result.rows };
    return { activities: result.rows };
  });

  /**
   * How many people are playing each game: the distinct players who placed or settled a round in
   * it within the last PLAYING_WINDOW_MINUTES. The lobby's game cards print it as "N playing".
   *
   * Counted, never estimated. A lobby that shows a busier table than the one somebody is about to
   * sit down at is advertising, and this page is where players decide whether to play at all. A
   * game nobody has touched in the window is simply absent, and the card says nothing.
   *
   * Keyed by route name, the one name the page already uses for a game. Both sides of a coinflip
   * or a mines duel are playing it. Case battles are paused and have no entry.
   */
  let playing: { at: number; games: Record<string, number> } | null = null;
  app.get('/v1/activity/playing', async () => {
    if (playing && Date.now() - playing.at < PLAYING_TTL_MS) {
      return { windowMinutes: PLAYING_WINDOW_MINUTES, games: playing.games };
    }
    const result = await db.query<{ game: string; players: number }>(
      `WITH since AS (SELECT now() - make_interval(mins => $1) AS at)
       SELECT seat.game, count(DISTINCT seat.user_id)::integer AS players FROM (
         SELECT 'crash'::text AS game, b.user_id FROM crash_bets b, since
          WHERE b.created_at > since.at OR b.settled_at > since.at
         UNION ALL
         SELECT 'mines', g.user_id FROM mines_games g, since
          WHERE g.created_at > since.at OR g.settled_at > since.at
         UNION ALL
         SELECT 'tower', g.user_id FROM tower_games g, since
          WHERE g.created_at > since.at OR g.settled_at > since.at
         UNION ALL
         SELECT 'chicken', g.user_id FROM chicken_games g, since
          WHERE g.created_at > since.at OR g.settled_at > since.at
         UNION ALL
         SELECT 'plinko', b.user_id FROM plinko_bets b, since WHERE b.created_at > since.at
         UNION ALL
         SELECT CASE s.machine WHEN 'monument' THEN 'monument' ELSE 'slots' END, s.user_id
           FROM slots_spins s, since WHERE s.created_at > since.at
         UNION ALL
         SELECT 'dice', b.user_id FROM dice_bets b, since WHERE b.created_at > since.at
         UNION ALL
         SELECT 'blackjack', h.user_id FROM blackjack_hands h, since
          WHERE h.created_at > since.at OR h.settled_at > since.at
         UNION ALL
         SELECT 'roulette', b.user_id FROM roulette_bets b, since WHERE b.created_at > since.at
         UNION ALL
         SELECT 'upgrader', r.user_id FROM upgrader_rounds r, since WHERE r.created_at > since.at
         UNION ALL
         SELECT 'crates', r.user_id FROM case_rounds r, since WHERE r.created_at > since.at
         UNION ALL
         SELECT 'coinflip', p.user_id FROM coinflip_games g, since,
                LATERAL (VALUES (g.host_user_id), (g.opponent_user_id)) p(user_id)
          WHERE p.user_id IS NOT NULL AND (g.created_at > since.at OR g.settled_at > since.at)
         UNION ALL
         SELECT 'mines-duel', p.user_id FROM mines_duel_games g, since,
                LATERAL (VALUES (g.host_user_id), (g.opponent_user_id)) p(user_id)
          WHERE p.user_id IS NOT NULL AND (g.created_at > since.at OR g.settled_at > since.at)
       ) seat
       GROUP BY seat.game`,
      [PLAYING_WINDOW_MINUTES],
    );
    const games: Record<string, number> = {};
    for (const row of result.rows) if (row.players > 0) games[row.game] = Number(row.players);
    playing = { at: Date.now(), games };
    return { windowMinutes: PLAYING_WINDOW_MINUTES, games };
  });
}
