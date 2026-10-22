import { SLOTS_MACHINES } from './slots.js';

/**
 * Every settled round one player has played, across every game, in one shape:
 *
 *   game     the game's key ('mines', 'blackjack', 'ore-rush' ...)
 *   id       the round's own id (a roulette round's id: one row per spin, however many chips)
 *   at       when the bet was placed
 *   wager    what the player put in
 *   payout   what came back to them, 0 for a loss
 *   detail   one short line about the round ("3 mines", "Cashed out at 2.10x")
 *
 * The history page pages through it and the statistics page groups it by game. It used to be the
 * upgrader alone on both pages, from when the upgrader was the whole site.
 *
 * The rounds tables are the record here, not the wallet ledger: the ledger also carries deposits,
 * withdrawals, tips and rewards, and does not say which game a payout came from in one shape.
 *
 * What counts, game by game (checked against production on 2026-10-21):
 *   - Only settled rounds. A blackjack hand, a mines/tower/chicken game or a crash bet still in play
 *     is not a result yet; cancelled battles, coinflips and mines duels were refunded and never ran.
 *   - Upgrader: a loss has a NULL payout. A win pays the target's value.
 *   - Blackjack: a doubled hand staked twice.
 *   - Coinflip and Mines Duel: both players' rounds. The winner is paid the pot less the rake; a
 *     mines duel draw refunds both stakes in full, so it pays back exactly the wager.
 *   - Battles: the player's own seat; bot seats belong to nobody.
 *   - Slots: one game per machine, keyed by the machine's id.
 * Skill duels and the retired Slither arena are not here: no skill duel has been played for money,
 * and Slither took five bets in September before it was removed.
 */

export interface RoundSource {
  /** The game key every row carries, or null when it comes from a column (slots: the machine). */
  readonly game: string | null;
  /** SQL for the game key. */
  readonly key: string;
  /** The column a round is ordered and paged by; covered by a (user, time DESC) index. */
  readonly time: string;
  readonly id: string;
  readonly wager: string;
  readonly payout: string;
  readonly detail: string;
  /** FROM ... with joins, and the WHERE that picks the player's settled rounds ($1 is the player). */
  readonly from: string;
  readonly where: string;
  /** For a game whose round is several rows (roulette chips): GROUP BY, and the select is aggregates. */
  readonly group?: string;
}

/** Two decimals, no padding: '2.10'. */
const two = (expression: string) => `to_char(${expression}, 'FM999999990.00')`;

export const ROUND_SOURCES: readonly RoundSource[] = [
  {
    game: 'upgrader',
    key: `'upgrader'`,
    time: 'r.created_at',
    id: 'r.id',
    wager: 'r.stake_value_minor',
    payout: 'coalesce(r.payout_minor, 0)',
    detail: `coalesce(c.display_name, c.minecraft_name) || ' · ' || ${two('r.chance_ppm / 10000.0')} || '%'`,
    from: 'upgrader_rounds r JOIN catalog_items c ON c.id = r.target_catalog_item_id',
    where: 'r.user_id = $1',
  },
  {
    game: 'cases',
    key: `'cases'`,
    time: 'r.created_at',
    id: 'r.id',
    wager: 'r.price_minor',
    payout: 'coalesce(r.payout_minor, 0)',
    detail: 'c.name',
    from: 'case_rounds r JOIN cases c ON c.id = r.case_id',
    where: 'r.user_id = $1',
  },
  {
    game: 'battles',
    key: `'battles'`,
    time: 'p.joined_at',
    id: 'b.id',
    wager: 'p.staked_minor',
    payout: 'coalesce(p.payout_minor, 0)',
    // 2 teams of 1 is "1v1", 3 teams of 1 is "1v1v1", 2 teams of 2 is "2v2".
    detail: `array_to_string(array_fill(b.team_size::text, ARRAY[b.team_count::int]), 'v')`,
    from: 'battle_players p JOIN battles b ON b.id = p.battle_id',
    where: `p.user_id = $1 AND b.status = 'settled'`,
  },
  {
    game: 'roulette',
    key: `'roulette'`,
    time: 'b.created_at',
    id: 'b.round_id',
    wager: 'sum(b.stake_minor)',
    payout: 'sum(coalesce(b.payout_minor, 0))',
    detail: `count(*) || CASE WHEN count(*) = 1 THEN ' bet' ELSE ' bets' END || ' · landed ' || rr.result`,
    from: 'roulette_bets b JOIN roulette_rounds rr ON rr.id = b.round_id',
    where: `b.user_id = $1 AND rr.status = 'settled'`,
    group: 'b.round_id, rr.result',
  },
  {
    game: 'blackjack',
    key: `'blackjack'`,
    time: 'h.created_at',
    id: 'h.id',
    wager: 'h.stake_minor * CASE WHEN h.doubled THEN 2 ELSE 1 END',
    payout: 'coalesce(h.payout_minor, 0)',
    detail: `CASE h.outcome WHEN 'blackjack' THEN 'Blackjack' WHEN 'win' THEN 'Won' WHEN 'push' THEN 'Push'
               WHEN 'tie' THEN 'Push' WHEN 'bust' THEN 'Bust' WHEN 'dealer_blackjack' THEN 'Dealer blackjack'
               ELSE 'Lost' END || CASE WHEN h.doubled THEN ' · doubled' ELSE '' END`,
    from: 'blackjack_hands h',
    where: `h.user_id = $1 AND h.status = 'settled'`,
  },
  {
    game: 'crash',
    key: `'crash'`,
    time: 'b.created_at',
    id: 'b.id',
    wager: 'b.stake_minor',
    payout: 'coalesce(b.payout_minor, 0)',
    detail: `CASE WHEN b.status = 'cashed_out' THEN 'Cashed out at ' || ${two('b.cashout_x100 / 100.0')} || 'x'
               ELSE 'Crashed at ' || ${two('cr.crash_point_x100 / 100.0')} || 'x' END`,
    from: 'crash_bets b JOIN crash_rounds cr ON cr.id = b.round_id',
    where: `b.user_id = $1 AND b.status IN ('cashed_out', 'lost')`,
  },
  {
    game: 'mines',
    key: `'mines'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: 'coalesce(g.payout_minor, 0)',
    detail: `g.mine_count || CASE WHEN g.mine_count = 1 THEN ' mine' ELSE ' mines' END`,
    from: 'mines_games g',
    where: `g.user_id = $1 AND g.status = 'settled'`,
  },
  {
    game: 'tower',
    key: `'tower'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: 'coalesce(g.payout_minor, 0)',
    detail: 'initcap(g.mode)',
    from: 'tower_games g',
    where: `g.user_id = $1 AND g.status = 'settled'`,
  },
  {
    game: 'chicken',
    key: `'chicken'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: 'coalesce(g.payout_minor, 0)',
    detail: `initcap(g.mode) || ' · ' || g.crossed || ' crossed'`,
    from: 'chicken_games g',
    where: `g.user_id = $1 AND g.status = 'settled'`,
  },
  {
    game: 'plinko',
    key: `'plinko'`,
    time: 'b.created_at',
    id: 'b.id',
    wager: 'b.stake_minor',
    payout: 'coalesce(b.payout_minor, 0)',
    detail: `initcap(b.risk) || ' · ' || b.row_count || ' rows'`,
    from: 'plinko_bets b',
    where: 'b.user_id = $1',
  },
  {
    game: 'dice',
    key: `'dice'`,
    time: 'b.created_at',
    id: 'b.id',
    wager: 'b.stake_minor',
    payout: 'coalesce(b.payout_minor, 0)',
    // Target and roll are kept in hundredths: 5000 is 50.00.
    detail: `initcap(b.direction) || ' ' || ${two('b.target / 100.0')} || ' · rolled ' || ${two('b.roll / 100.0')}`,
    from: 'dice_bets b',
    where: 'b.user_id = $1',
  },
  {
    game: null,
    key: 's.machine',
    time: 's.created_at',
    id: 's.id',
    wager: 's.stake_minor',
    payout: 'coalesce(s.payout_minor, 0)',
    // The machine is the game; a spin has nothing else worth a line.
    detail: `''`,
    from: 'slots_spins s',
    where: 's.user_id = $1',
  },
  {
    game: 'coinflip',
    key: `'coinflip'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: 'CASE WHEN g.winner_user_id = $1 THEN coalesce(g.payout_minor, 0) ELSE 0 END',
    detail: `'Landed ' || g.result`,
    from: 'coinflip_games g',
    where: `(g.host_user_id = $1 OR g.opponent_user_id = $1) AND g.status = 'settled'`,
  },
  {
    game: 'mines-duel',
    key: `'mines-duel'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: `CASE WHEN g.outcome = 'draw' THEN g.stake_minor
                  WHEN g.winner_user_id = $1 THEN coalesce(g.payout_minor, 0) ELSE 0 END`,
    detail: `CASE WHEN g.outcome = 'draw' THEN 'Draw'
                  WHEN g.host_user_id = $1 THEN g.host_score || '–' || g.opponent_score
                  ELSE g.opponent_score || '–' || g.host_score END`,
    from: 'mines_duel_games g',
    where: `(g.host_user_id = $1 OR g.opponent_user_id = $1) AND g.status = 'settled'`,
  },
];

/** Every game key a round can carry, in the order the games appear in the lobby. */
export const ROUND_GAMES: Readonly<Record<string, string>> = {
  crash: 'Crash',
  mines: 'Mines',
  tower: 'Tower',
  chicken: 'Chicken',
  plinko: 'Plinko',
  dice: 'Dice',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  upgrader: 'Upgrader',
  coinflip: 'Coinflip',
  'mines-duel': 'Mines Duel',
  battles: 'Case Battles',
  ...Object.fromEntries(Object.values(SLOTS_MACHINES).map((machine) => [machine.id, machine.name])),
  cases: 'Cases',
};

export const ROUND_GAME_KEYS = Object.keys(ROUND_GAMES) as [string, ...string[]];

/** A game's name for a key the database returned; a machine added since reads as its id. */
export function roundGameName(key: string): string {
  return ROUND_GAMES[key] ?? key;
}

interface PageOptions {
  /** Placeholder for "only rounds placed before this time", or null for all of them. */
  readonly before: string | null;
  /** Placeholder for the game filter, or null for every game. */
  readonly game: string | null;
  /** The game filter's value, to drop the sources that cannot match it at all. */
  readonly gameValue: string | null;
  /** Placeholder for the most rows one source may give, or null for no limit. */
  readonly limit: string | null;
}

function sourceSql(source: RoundSource, options: PageOptions): string {
  const at = source.group ? `min(${source.time})` : source.time;
  const conditions = [source.where];
  if (options.before) conditions.push(`${source.time} < ${options.before}`);
  if (options.game && source.game === null) conditions.push(`${source.key} = ${options.game}`);
  return (
    `SELECT ${source.key}::text AS game, ${source.id}::text AS id, ${at} AS at, ` +
    `(${source.wager})::bigint AS wager, (${source.payout})::bigint AS payout, (${source.detail})::text AS detail ` +
    `FROM ${source.from} WHERE ${conditions.join(' AND ')}` +
    (source.group ? ` GROUP BY ${source.group}` : '') +
    (options.limit ? ` ORDER BY ${at} DESC LIMIT ${options.limit}` : '')
  );
}

/**
 * The UNION of every source, as SQL. With a limit, each source is cut to that many of its newest
 * rows before the union, so a page reads at most `limit` rows from each table, off its index,
 * however long the player's history is.
 */
export function roundsUnion(options: PageOptions): string {
  const sources = ROUND_SOURCES.filter(
    (source) => options.gameValue === null || source.game === null || source.game === options.gameValue,
  );
  return sources.map((source) => `(${sourceSql(source, options)})`).join('\nUNION ALL\n');
}

/** Every round, for the statistics: no cursor, no filter, no limit. */
export function allRoundsSql(): string {
  return roundsUnion({ before: null, game: null, gameValue: null, limit: null });
}

/**
 * The statistics page: one row a game the player ($1) has played, most wagered first, with its win
 * count, totals, best multiplier and biggest win (the wager and payout of the round that made the
 * most). A win is a round that paid back more than it took.
 */
export function statisticsSql(): string {
  return `WITH rounds AS MATERIALIZED (${allRoundsSql()})
          SELECT game,
                 count(*)::int AS rounds,
                 (count(*) FILTER (WHERE payout > wager))::int AS wins,
                 sum(wager)::text AS wagered,
                 sum(payout)::text AS paid,
                 (max(payout::numeric / wager) FILTER (WHERE payout > wager AND wager > 0))::text AS best,
                 ((array_agg(wager ORDER BY payout - wager DESC) FILTER (WHERE payout > wager AND wager > 0))[1])::text AS top_wager,
                 ((array_agg(payout ORDER BY payout - wager DESC) FILTER (WHERE payout > wager AND wager > 0))[1])::text AS top_payout
            FROM rounds
           GROUP BY game
           ORDER BY sum(wager) DESC`;
}

/**
 * One page of history, newest first. Parameters: $1 the player, $2 the cursor (a timestamp, or
 * null for the newest), $3 the page size, and $4 the game key when filtered.
 */
export function historyPageSql(game: string | null): string {
  const union = roundsUnion({
    before: '$2::timestamptz',
    game: game === null ? null : '$4::text',
    gameValue: game,
    limit: '$3::int',
  });
  /* The first page passes 'infinity' as the cursor, so every source keeps one plain condition.
   * `at` goes out as text, UTC to the microsecond, because it comes back as the next page's cursor
   * and a JS Date would round it to the millisecond. */
  return `SELECT game, id,
                 to_char(rounds.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
                 wager::text AS wager, payout::text AS payout, detail
            FROM (${union}) rounds
           ORDER BY rounds.at DESC, rounds.id DESC
           LIMIT $3::int`;
}
