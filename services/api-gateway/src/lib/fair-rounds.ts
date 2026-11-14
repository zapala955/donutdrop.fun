/**
 * The Provably Fair page's list of a player's rounds, every game with a seed (2026-11-14).
 *
 * The owner: "rewrite https://donutluxe.com/fairness and also it shows upgrader bets only for some
 * reason". It did: the page asked the upgrader's own history. This reads every seeded game, each
 * with what a player needs to check the round themselves: the hash committed before it, the seed
 * revealed after it, the client seed and nonce it was drawn with, and -- where a game takes a single
 * draw -- the exact message it hashed (HMAC-SHA256 keyed with the server seed) and the recorded
 * result, so the page can reproduce it in the browser.
 *
 * Only rounds whose seed has been revealed are listed. Stocks is not here: a position spans epochs
 * of a shared chart, whose seeds the page lists separately (GET /v1/stocks/epochs).
 */

export interface FairSource {
  readonly game: string | null;
  readonly key: string;
  readonly time: string;
  readonly id: string;
  readonly wager: string;
  readonly payout: string;
  readonly detail: string;
  readonly hash: string;
  readonly reveal: string;
  /** The client seed(s), as text; NULL where the game takes none (a shared round). */
  readonly client: string;
  readonly nonce: string;
  /** The exact message a single-draw game hashed, or NULL where it takes many draws. */
  readonly message: string;
  /** The recorded result, for the page to reproduce (jsonb), or NULL. */
  readonly facts: string;
  readonly from: string;
  readonly where: string;
  readonly group?: string;
}

const two = (expression: string) => `to_char(${expression}, 'FM999999990.00')`;
const draw = (alias: string) => `${alias}.client_seed || ':' || ${alias}.nonce`;
const perBet = (alias: string) => ({
  hash: `${alias}.server_seed_hash`,
  reveal: `${alias}.server_seed_reveal`,
  client: `${alias}.client_seed`,
  nonce: `${alias}.nonce`,
});

export const FAIR_SOURCES: readonly FairSource[] = [
  {
    game: 'dice',
    key: `'dice'`,
    time: 'b.created_at',
    id: 'b.id',
    wager: 'b.stake_minor',
    payout: 'coalesce(b.payout_minor, 0)',
    detail: `initcap(b.direction) || ' ' || ${two('b.target / 100.0')} || ' · rolled ' || ${two('b.roll / 100.0')}`,
    ...perBet('b'),
    message: draw('b'),
    facts: `jsonb_build_object('roll', b.roll)`,
    from: 'dice_bets b',
    where: 'b.user_id = $1',
  },
  {
    game: 'limbo',
    key: `'limbo'`,
    time: 'b.created_at',
    id: 'b.id',
    wager: 'b.stake_minor',
    payout: 'coalesce(b.payout_minor, 0)',
    detail: `'Target ' || ${two('b.target_x100 / 100.0')} || 'x · drew ' || ${two('greatest(b.result_x100, 100) / 100.0')} || 'x'`,
    ...perBet('b'),
    message: draw('b'),
    facts: `jsonb_build_object('resultX100', b.result_x100)`,
    from: 'limbo_bets b',
    where: 'b.user_id = $1',
  },
  {
    game: 'upgrader',
    key: `'upgrader'`,
    time: 'r.created_at',
    id: 'r.id',
    wager: 'r.stake_value_minor',
    payout: 'coalesce(r.payout_minor, 0)',
    detail: `coalesce(c.display_name, c.minecraft_name) || ' · ' || ${two('r.chance_ppm / 10000.0')} || '%'`,
    ...perBet('r'),
    message: draw('r'),
    facts: `jsonb_build_object('rollPpm', r.roll_ppm, 'chancePpm', r.chance_ppm, 'outcome', r.outcome)`,
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
    ...perBet('r'),
    message: draw('r'),
    facts: 'NULL::jsonb',
    from: 'case_rounds r JOIN cases c ON c.id = r.case_id',
    where: 'r.user_id = $1',
  },
  {
    game: 'plinko',
    key: `'plinko'`,
    time: 'b.created_at',
    id: 'b.id',
    wager: 'b.stake_minor',
    payout: 'coalesce(b.payout_minor, 0)',
    detail: `initcap(b.risk) || ' · ' || b.row_count || ' rows'`,
    ...perBet('b'),
    message: draw('b'),
    facts: 'NULL::jsonb',
    from: 'plinko_bets b',
    where: 'b.user_id = $1',
  },
  {
    game: 'fishing',
    key: `'fishing'`,
    time: 'f.created_at',
    id: 'f.id',
    wager: 'f.stake_minor',
    payout: 'coalesce(f.payout_minor, 0)',
    detail: `coalesce(initcap(replace(f.catch, '_', ' ')), initcap(f.status))`,
    ...perBet('f'),
    message: draw('f'),
    facts: 'NULL::jsonb',
    from: 'fishing_casts f',
    where: 'f.user_id = $1 AND f.settled_at IS NOT NULL',
  },
  {
    game: 'derby',
    key: `'derby'`,
    time: 'd.created_at',
    id: 'd.id',
    wager: 'd.stake_minor',
    payout: 'coalesce(d.payout_minor, 0)',
    detail: `'Backed ' || initcap(replace(d.pick, '_', ' ')) || ' · ' || initcap(replace(d.winner, '_', ' ')) || ' won'`,
    ...perBet('d'),
    message: draw('d'),
    facts: 'NULL::jsonb',
    from: 'derby_races d',
    where: 'd.user_id = $1',
  },
  {
    game: 'mines',
    key: `'mines'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: 'coalesce(g.payout_minor, 0)',
    detail: `g.mine_count || CASE WHEN g.mine_count = 1 THEN ' mine' ELSE ' mines' END`,
    ...perBet('g'),
    message: 'NULL::text',
    facts: 'NULL::jsonb',
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
    ...perBet('g'),
    message: 'NULL::text',
    facts: 'NULL::jsonb',
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
    ...perBet('g'),
    message: 'NULL::text',
    facts: 'NULL::jsonb',
    from: 'chicken_games g',
    where: `g.user_id = $1 AND g.status = 'settled'`,
  },
  {
    game: 'ice-fishing',
    key: `'ice-fishing'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: 'coalesce(g.payout_minor, 0)',
    detail: `g.thin_count || ' thin · ' || coalesce(initcap(g.outcome), 'Settled')`,
    ...perBet('g'),
    message: 'NULL::text',
    facts: 'NULL::jsonb',
    from: 'ice_fishing_games g',
    where: 'g.user_id = $1 AND g.settled_at IS NOT NULL',
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
               ELSE 'Lost' END`,
    ...perBet('h'),
    message: 'NULL::text',
    facts: 'NULL::jsonb',
    from: 'blackjack_hands h',
    where: `h.user_id = $1 AND h.status = 'settled'`,
  },
  {
    game: null,
    key: 's.machine',
    time: 's.created_at',
    id: 's.id',
    wager: 's.stake_minor',
    payout: 'coalesce(s.payout_minor, 0)',
    detail: `''`,
    ...perBet('s'),
    message: 'NULL::text',
    facts: 'NULL::jsonb',
    from: 'slots_spins s',
    where: 's.user_id = $1',
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
    hash: 'cr.server_seed_hash',
    reveal: 'cr.server_seed_reveal',
    client: 'NULL::text',
    nonce: 'NULL::integer',
    // One draw for the whole round, from the round's own id (lib/crash.ts crashPoint).
    message: `cr.id::text || ':0'`,
    facts: `jsonb_build_object('crashX100', cr.crash_point_x100, 'edgeBps', cr.house_edge_bps)`,
    from: 'crash_bets b JOIN crash_rounds cr ON cr.id = b.round_id',
    where: `b.user_id = $1 AND b.status IN ('cashed_out', 'lost')`,
  },
  {
    game: 'roulette',
    key: `'roulette'`,
    time: 'min(b.created_at)',
    id: 'b.round_id',
    wager: 'sum(b.stake_minor)',
    payout: 'sum(coalesce(b.payout_minor, 0))',
    detail: `count(*) || CASE WHEN count(*) = 1 THEN ' bet' ELSE ' bets' END || ' · landed ' || rr.result`,
    hash: 'rr.server_seed_hash',
    reveal: 'rr.server_seed_reveal',
    client: 'NULL::text',
    nonce: 'NULL::integer',
    message: `rr.id::text || ':0'`,
    facts: `jsonb_build_object('pocket', rr.result)`,
    from: 'roulette_bets b JOIN roulette_rounds rr ON rr.id = b.round_id',
    where: `b.user_id = $1 AND rr.status = 'settled'`,
    group: 'b.round_id, rr.id, rr.result, rr.server_seed_hash, rr.server_seed_reveal',
  },
  {
    game: 'coinflip',
    key: `'coinflip'`,
    time: 'g.created_at',
    id: 'g.id',
    wager: 'g.stake_minor',
    payout: 'CASE WHEN g.winner_user_id = $1 THEN coalesce(g.payout_minor, 0) ELSE 0 END',
    detail: `'Landed ' || g.result`,
    hash: 'g.server_seed_hash',
    reveal: 'g.server_seed_reveal',
    client: `g.host_client_seed || ' · ' || g.opponent_client_seed`,
    nonce: 'NULL::integer',
    message: `'coinflip:' || g.host_client_seed || ':' || g.opponent_client_seed`,
    facts: `jsonb_build_object('result', g.result)`,
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
    hash: 'g.server_seed_hash',
    reveal: 'g.server_seed_reveal',
    client: `g.host_client_seed || ' · ' || g.opponent_client_seed`,
    nonce: 'NULL::integer',
    message: 'NULL::text',
    facts: 'NULL::jsonb',
    from: 'mines_duel_games g',
    where: `(g.host_user_id = $1 OR g.opponent_user_id = $1) AND g.status = 'settled'`,
  },
  {
    game: 'battles',
    key: `'battles'`,
    time: 'p.joined_at',
    id: 'b.id',
    wager: 'p.staked_minor',
    payout: 'coalesce(p.payout_minor, 0)',
    detail: `array_to_string(array_fill(b.team_size::text, ARRAY[b.team_count::int]), 'v')`,
    hash: 'b.server_seed_hash',
    reveal: 'b.server_seed_reveal',
    client: 'p.client_seed',
    nonce: 'b.nonce',
    message: 'NULL::text',
    facts: 'NULL::jsonb',
    from: 'battle_players p JOIN battles b ON b.id = p.battle_id',
    where: `p.user_id = $1 AND b.status = 'settled'`,
  },
];

/** Names for the games the history does not list (player-rounds.ts ROUND_GAMES). */
export const FAIR_GAME_NAMES: Readonly<Record<string, string>> = {
  fishing: 'Fishing',
  'ice-fishing': 'Ice Fishing',
  derby: 'Mob Derby',
  slots: 'Slots',
};

/** Every source's game key that can be filtered on (slots by machine are filtered as 'slots'). */
export const FAIR_GAME_KEYS = [...FAIR_SOURCES.map((source) => source.game ?? 'slots')] as [string, ...string[]];

function sourceSql(source: FairSource): string {
  const conditions = [source.where, `${source.reveal} IS NOT NULL`, `${source.time.replace(/^min\((.*)\)$/, '$1')} < $2::timestamptz`];
  return (
    `SELECT ${source.key}::text AS game, ${source.id}::text AS id, ${source.time} AS at, ` +
    `(${source.wager})::bigint AS wager, (${source.payout})::bigint AS payout, (${source.detail})::text AS detail, ` +
    `${source.hash}::text AS server_seed_hash, ${source.reveal}::text AS server_seed_reveal, ` +
    `(${source.client})::text AS client_seed, (${source.nonce})::integer AS nonce, ` +
    `(${source.message})::text AS message, (${source.facts})::jsonb AS facts ` +
    `FROM ${source.from} WHERE ${conditions.join(' AND ')}` +
    (source.group ? ` GROUP BY ${source.group}` : '') +
    ` ORDER BY ${source.time} DESC LIMIT $3::int`
  );
}

/**
 * One page of a player's seeded rounds, newest first. Parameters: $1 the player, $2 the cursor
 * (a timestamp; 'infinity' for the newest), $3 the page size. `game`, when given, keeps that one
 * game's source (slots: every machine).
 */
export function fairRoundsSql(game: string | null): string {
  const sources = FAIR_SOURCES.filter((source) => game === null || (source.game ?? 'slots') === game);
  const union = sources.map((source) => `(${sourceSql(source)})`).join('\nUNION ALL\n');
  return `SELECT game, id, to_char(rounds.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
                 wager::text AS wager, payout::text AS payout, detail, server_seed_hash, server_seed_reveal,
                 client_seed, nonce, message, facts
            FROM (${union}) rounds
           ORDER BY rounds.at DESC, rounds.id DESC
           LIMIT $3::int`;
}
