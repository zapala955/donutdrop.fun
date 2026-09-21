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
 * Three kinds of event share one chronological stream:
 *
 *   case     a crate was opened — what it cost, what it paid.
 *   upgrade  an upgrader round settled — stake in, payout out.
 *   faction  a wager was credited to a team in the running faction war.
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
                ((r.awarded_weight::bigint * 1000000) / r.total_weight)::integer AS chance_ppm
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
                r.target_quantity AS quantity, r.chance_ppm
           FROM upgrader_rounds r
           JOIN users u ON u.id = r.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = r.user_id
           JOIN catalog_items c ON c.id = r.target_catalog_item_id
         UNION ALL
         SELECT b.id, 'roulette'::text AS kind, r.settled_at AS created_at,
                u.id AS player_id,
                ${MASKED_NAME} AS player,
                t.wagered_minor AS wagered_minor,
                'Roulette'::text AS source_name,
                NULL::char(7) AS accent,
                b.stake_minor AS wager_minor,
                COALESCE(b.payout_minor, '0')::bigint AS payout_minor,
                NULL::uuid AS catalog_item_id, NULL::varchar AS minecraft_name,
                NULL::varchar AS display_name, NULL::text AS image_url,
                NULL::bigint AS unit_value_minor, NULL::jsonb AS metadata,
                1 AS quantity,
                CASE
                  WHEN b.selection LIKE 'straight:%' THEN 27027
                  WHEN b.selection LIKE 'dozen:%' THEN 324324
                  ELSE 486486
                END AS chance_ppm
           FROM roulette_bets b
           JOIN roulette_rounds r ON r.id = b.round_id AND r.status = 'settled'
           JOIN users u ON u.id = b.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = b.user_id
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
                1 AS quantity, 0 AS chance_ppm
           FROM faction_contributions fc
           JOIN users u ON u.id = fc.user_id
           LEFT JOIN user_wager_totals t ON t.user_id = fc.user_id
           JOIN factions f ON f.id = fc.faction_id
       ) activity
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
}
