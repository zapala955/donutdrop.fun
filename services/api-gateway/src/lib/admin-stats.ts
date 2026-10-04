import type { DbClient } from './db.js';

/**
 * admin-stats.ts — the console's numbers: what was staked, what the house kept, what it gave
 * back, and what that leaves.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ONE SOURCE: THE WALLET LEDGER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every game takes its stake and pays its winnings through wallet_transactions, each under its own
 * kind. Reading wagers from one table and payouts from twelve per-game tables would give figures
 * that cannot be reconciled with each other; reading both from the ledger gives figures that add up
 * by construction: per game, stakes minus refunds minus payouts IS what the house kept (GGR).
 *
 * On top of that come the costs the house pays players for playing — rakeback, referral shares,
 * creator royalties, races, quests, streaks, rain, sign-up bonuses, the jackpot, vault yield — and
 * the cash it buys items back for. Net profit is GGR less all of those. Deposits, withdrawals and
 * manual adjustments are reported beside it but are not profit: they move money in and out of
 * wallets, not between a player and the house.
 *
 * Cash basis: a crate or upgrade won as an inventory lot (custody mode) pays no cash until the item
 * is sold back, and shows up then under item buybacks. In cash-only play every prize is cash and the
 * per-game figures are exact.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * STAFF ARE NOT CUSTOMERS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Admin accounts, the developer test login (`dev:` identities, funded by admin adjustments) and
 * system accounts are excluded unless the caller asks for them. An operator testing a crate with a
 * test balance otherwise shows up as turnover, a winning player and a promo cost.
 */

export interface GameDefinition {
  readonly key: string;
  readonly label: string;
  /** Debits that open a round. */
  readonly stakes: readonly string[];
  /** Credits that pay a round out. */
  readonly payouts: readonly string[];
  /** Credits that hand a stake back whole because the round never ran or produced no winner. */
  readonly refunds: readonly string[];
}

export const GAMES: readonly GameDefinition[] = [
  { key: 'cases', label: 'Cases', stakes: ['case_open'], payouts: ['case_win'], refunds: [] },
  {
    key: 'battles',
    label: 'Case battles',
    stakes: ['battle_stake'],
    payouts: ['battle_win'],
    refunds: ['battle_refund'],
  },
  {
    key: 'upgrader',
    label: 'Upgrader',
    stakes: ['upgrade_stake'],
    payouts: ['upgrade_win'],
    refunds: [],
  },
  {
    key: 'roulette',
    label: 'Roulette',
    stakes: ['roulette_stake'],
    payouts: ['roulette_win'],
    refunds: [],
  },
  {
    key: 'blackjack',
    label: 'Blackjack',
    stakes: ['blackjack_stake', 'blackjack_double'],
    payouts: ['blackjack_payout'],
    refunds: [],
  },
  { key: 'crash', label: 'Crash', stakes: ['crash_stake'], payouts: ['crash_payout'], refunds: [] },
  { key: 'mines', label: 'Mines', stakes: ['mines_stake'], payouts: ['mines_payout'], refunds: [] },
  {
    key: 'plinko',
    label: 'Plinko',
    stakes: ['plinko_stake'],
    payouts: ['plinko_payout'],
    refunds: [],
  },
  {
    key: 'dice',
    label: 'Dice (retired)',
    stakes: ['dice_stake'],
    payouts: ['dice_payout'],
    refunds: [],
  },
  {
    key: 'minesduel',
    label: 'Mines duels',
    stakes: ['mines_duel_stake'],
    payouts: ['mines_duel_win'],
    refunds: ['mines_duel_refund'],
  },
  {
    key: 'coinflip',
    label: 'Coinflip',
    stakes: ['coinflip_stake'],
    payouts: ['coinflip_win'],
    refunds: ['coinflip_refund'],
  },
  {
    key: 'duels',
    label: 'Skill duels',
    stakes: ['duel_stake'],
    payouts: ['duel_win'],
    refunds: ['duel_refund'],
  },
  {
    key: 'sidebets',
    label: 'Side bets',
    stakes: ['sidebet_stake'],
    payouts: ['sidebet_win'],
    refunds: ['sidebet_refund'],
  },
  {
    key: 'slither',
    label: 'Slither (retired)',
    stakes: ['slither_stake'],
    payouts: ['slither_cashout'],
    refunds: ['slither_refund'],
  },
];

/** What the house pays players for playing. Each is a cost against GGR. */
export const PROMO_KINDS: Readonly<Record<string, string>> = Object.freeze({
  rakeback_claim: 'Rakeback',
  referral_revshare: 'Referral share',
  referral_bonus: 'Referral bonus',
  creator_royalty: 'Creator royalties',
  race_payout: 'Races',
  quest_reward: 'Quests',
  streak_reward: 'Streaks',
  faction_payout: 'Faction war',
  rain_claim: 'Rain',
  signup_bonus: 'Sign-up bonus',
  jackpot_win: 'Vault jackpot',
  vault_yield: 'Vault yield',
  discord_join_reward: 'Discord join',
  discord_tag_reward: 'Discord tag',
  discord_invite_reward: 'Discord invites',
});

export const ITEM_BUYBACK_KINDS = ['item_sale'] as const;
export const DEPOSIT_KINDS = ['cash_deposit', 'pay_login_deposit'] as const;
export const WITHDRAWAL_KINDS = ['cash_withdrawal', 'cash_withdrawal_refund'] as const;
export const ADJUSTMENT_KINDS = ['admin_adjustment'] as const;

export const STAKE_KINDS = GAMES.flatMap((game) => game.stakes);
export const REFUND_KINDS = GAMES.flatMap((game) => game.refunds);
export const GAME_KINDS = GAMES.flatMap((game) => [
  ...game.stakes,
  ...game.payouts,
  ...game.refunds,
]);

/**
 * The SQL that says an account is staff, for a `users` alias. Admins by role, the developer test
 * login by its `dev:` identity, and the system accounts (the catalogue seed) by `system:`.
 */
export function staffPredicate(alias: string): string {
  return (
    `(${alias}.role = 'admin' OR ${alias}.minecraft_identity LIKE 'dev:%'` +
    ` OR ${alias}.minecraft_identity LIKE 'system:%')`
  );
}

/** One kind's sum, row count and distinct accounts over some window. */
export interface KindAggregate {
  readonly amount: bigint;
  readonly rows: number;
  readonly users: number;
}

export interface Totals {
  wagered: bigint;
  bets: number;
  ggr: bigint;
  promo: bigint;
  itemBuybacks: bigint;
  net: bigint;
  deposits: bigint;
  withdrawals: bigint;
  adjustments: bigint;
}

const sumOf = (kinds: Map<string, KindAggregate>, names: readonly string[]): bigint =>
  names.reduce((total, name) => total + (kinds.get(name)?.amount ?? 0n), 0n);
const rowsOf = (kinds: Map<string, KindAggregate>, names: readonly string[]): number =>
  names.reduce((total, name) => total + (kinds.get(name)?.rows ?? 0), 0);

/**
 * Turns per-kind ledger sums into the figures the console shows. Pure, so the arithmetic is
 * testable without a database.
 *
 * Signs: stakes are negative ledger rows and payouts and refunds positive, so the house's take on
 * the games is the NEGATED sum of every game kind; promo and buybacks are positive credits to
 * players, i.e. costs.
 */
export function summarize(kinds: Map<string, KindAggregate>): Totals {
  const staked = -sumOf(kinds, STAKE_KINDS);
  const refunded = sumOf(kinds, REFUND_KINDS);
  const ggr = -sumOf(kinds, GAME_KINDS);
  const promo = sumOf(kinds, Object.keys(PROMO_KINDS));
  const itemBuybacks = sumOf(kinds, ITEM_BUYBACK_KINDS);
  return {
    wagered: staked - refunded,
    bets: Math.max(0, rowsOf(kinds, STAKE_KINDS) - rowsOf(kinds, REFUND_KINDS)),
    ggr,
    promo,
    itemBuybacks,
    net: ggr - promo - itemBuybacks,
    deposits: sumOf(kinds, DEPOSIT_KINDS),
    // Paid out of wallets: the debit, less anything refunded back after a failed payout.
    withdrawals: -sumOf(kinds, WITHDRAWAL_KINDS),
    adjustments: sumOf(kinds, ADJUSTMENT_KINDS),
  };
}

export interface GameSummary {
  readonly key: string;
  readonly label: string;
  readonly wagered: bigint;
  readonly bets: number;
  readonly players: number;
  readonly ggr: bigint;
}

export function summarizeGames(kinds: Map<string, KindAggregate>): GameSummary[] {
  return GAMES.map((game) => {
    const staked = -sumOf(kinds, game.stakes);
    const refunded = sumOf(kinds, game.refunds);
    const all = [...game.stakes, ...game.payouts, ...game.refunds];
    return {
      key: game.key,
      label: game.label,
      wagered: staked - refunded,
      bets: Math.max(0, rowsOf(kinds, game.stakes) - rowsOf(kinds, game.refunds)),
      /* A game's players are the accounts that staked on it. Blackjack's double is a second stake
       * by a player already counted, so the largest per-kind count is the right one. */
      players: Math.max(0, ...game.stakes.map((kind) => kinds.get(kind)?.users ?? 0)),
      ggr: -sumOf(kinds, all),
    };
  }).filter((game) => game.bets > 0 || game.wagered !== 0n || game.ggr !== 0n);
}

/* ═════════════════════════ the window ═════════════════════════ */

export const RANGE_DAYS = [1, 7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

export interface StatsWindow {
  readonly from: Date;
  readonly to: Date;
  readonly previousFrom: Date;
  readonly unit: 'hour' | 'day';
  readonly buckets: Date[];
}

/**
 * `days` whole UTC days ending today, today included; "1" is today so far, in hours. The previous
 * window is the same length immediately before, so a delta compares like with like — today until
 * now against yesterday until the same time.
 */
export function statsWindow(days: RangeDays, now: Date): StatsWindow {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(midnight - (days - 1) * 86_400_000);
  const to = now;
  const span = to.getTime() - from.getTime();
  const unit = days === 1 ? 'hour' : 'day';
  const step = unit === 'hour' ? 3_600_000 : 86_400_000;
  const buckets: Date[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += step) buckets.push(new Date(at));
  return { from, to, previousFrom: new Date(from.getTime() - span), unit, buckets };
}

/* ═════════════════════════ the queries ═════════════════════════ */

const toKindMap = (rows: { kind: string; amount: string; rows: string; users: string }[]) =>
  new Map(
    rows.map((row) => [
      row.kind,
      {
        amount: BigInt(row.amount),
        rows: Number(row.rows),
        users: Number(row.users),
      },
    ]),
  );

export interface StatsReport {
  window: StatsWindow;
  includeStaff: boolean;
  staffAccounts: number;
  totals: Totals & { players: number; newPlayers: number; depositors: number; expectedGgr: bigint };
  previous: Totals & { players: number; newPlayers: number };
  series: {
    at: Date;
    wagered: bigint;
    ggr: bigint;
    promo: bigint;
    net: bigint;
    deposits: bigint;
    withdrawals: bigint;
    players: number;
    newPlayers: number;
    bets: number;
  }[];
  games: GameSummary[];
  promo: { kind: string; label: string; amount: bigint }[];
  topPlayers: PlayerRow[];
  winners: PlayerRow[];
  losers: PlayerRow[];
}

export interface PlayerRow {
  id: string;
  name: string;
  wagered: bigint;
  bets: number;
  /** The player's own result on the games: what they got back less what they staked. */
  net: bigint;
}

/**
 * A row's bucket as Unix seconds, `$4` being the bucket's length in seconds. UTC hours and days
 * both start on a multiple of their length since the epoch, and seconds come back as plain text,
 * so no timestamp is parsed in whatever zone the API process happens to run in.
 */
const BUCKET = (column: string) =>
  `(floor(extract(epoch FROM ${column}) / $4::int) * $4::int)::bigint::text`;

export async function buildStatsReport(
  db: DbClient,
  options: { days: RangeDays; includeStaff: boolean; now?: Date },
): Promise<StatsReport> {
  const window = statsWindow(options.days, options.now ?? new Date());
  const notStaff = `($3::boolean OR NOT ${staffPredicate('u')})`;
  const kindQuery = `
    SELECT t.kind, sum(t.amount_minor)::text AS amount, count(*)::text AS rows,
           count(DISTINCT t.user_id)::text AS users
      FROM wallet_transactions t JOIN users u ON u.id = t.user_id
     WHERE t.created_at >= $1 AND t.created_at < $2 AND ${notStaff}
     GROUP BY t.kind`;
  const playersQuery = `
    SELECT count(DISTINCT t.user_id)::text AS players
      FROM wallet_transactions t JOIN users u ON u.id = t.user_id
     WHERE t.created_at >= $1 AND t.created_at < $2 AND ${notStaff}
       AND t.kind = ANY($4::text[])`;
  const signupQuery = `
    SELECT count(*)::text AS n FROM users u
     WHERE u.created_at >= $1 AND u.created_at < $2 AND ${notStaff}`;
  const range = [window.from, window.to, options.includeStaff];
  const step = window.unit === 'hour' ? 3600 : 86_400;
  const previousRange = [window.previousFrom, window.from, options.includeStaff];

  const [
    current,
    previous,
    players,
    previousPlayers,
    signups,
    previousSignups,
    depositors,
    series,
    seriesPlayers,
    seriesSignups,
    expected,
    staff,
    people,
  ] = await Promise.all([
    db.query<{ kind: string; amount: string; rows: string; users: string }>(kindQuery, range),
    db.query<{ kind: string; amount: string; rows: string; users: string }>(
      kindQuery,
      previousRange,
    ),
    db.query<{ players: string }>(playersQuery, [...range, STAKE_KINDS]),
    db.query<{ players: string }>(playersQuery, [...previousRange, STAKE_KINDS]),
    db.query<{ n: string }>(signupQuery, range),
    db.query<{ n: string }>(signupQuery, previousRange),
    db.query<{ players: string }>(playersQuery, [...range, [...DEPOSIT_KINDS]]),
    db.query<{ bucket: string; kind: string; amount: string; rows: string }>(
      `SELECT ${BUCKET('t.created_at')} AS bucket, t.kind,
              sum(t.amount_minor)::text AS amount, count(*)::text AS rows
         FROM wallet_transactions t JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= $1 AND t.created_at < $2 AND ${notStaff}
        GROUP BY 1, 2`,
      [...range, step],
    ),
    db.query<{ bucket: string; players: string }>(
      `SELECT ${BUCKET('t.created_at')} AS bucket,
              count(DISTINCT t.user_id)::text AS players
         FROM wallet_transactions t JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= $1 AND t.created_at < $2 AND ${notStaff}
          AND t.kind = ANY($5::text[])
        GROUP BY 1`,
      [...range, step, STAKE_KINDS],
    ),
    db.query<{ bucket: string; n: string }>(
      `SELECT ${BUCKET('u.created_at')} AS bucket, count(*)::text AS n
         FROM users u
        WHERE u.created_at >= $1 AND u.created_at < $2 AND ${notStaff}
        GROUP BY 1`,
      [...range, step],
    ),
    /* What the games' edges say the house should have kept: the margin each wager records. The gap
     * between this and the real GGR is variance — the house running hot or cold. */
    db.query<{ margin: string }>(
      `SELECT coalesce(sum(w.margin_minor), 0)::text AS margin
         FROM wager_events w JOIN users u ON u.id = w.user_id
        WHERE w.created_at >= $1 AND w.created_at < $2 AND ${notStaff}`,
      range,
    ),
    db.query<{ n: string }>(`SELECT count(*)::text AS n FROM users u WHERE ${staffPredicate('u')}`),
    db.query<{
      id: string;
      name: string;
      staked: string;
      refunded: string;
      net: string;
      bets: string;
    }>(
      `SELECT u.id, u.minecraft_username AS name,
              coalesce(-sum(t.amount_minor) FILTER (WHERE t.kind = ANY($4::text[])), 0)::text AS staked,
              coalesce(sum(t.amount_minor) FILTER (WHERE t.kind = ANY($5::text[])), 0)::text AS refunded,
              coalesce(sum(t.amount_minor) FILTER (WHERE t.kind = ANY($6::text[])), 0)::text AS net,
              count(*) FILTER (WHERE t.kind = ANY($4::text[]))::text AS bets
         FROM wallet_transactions t JOIN users u ON u.id = t.user_id
        WHERE t.created_at >= $1 AND t.created_at < $2 AND ${notStaff}
          AND t.kind = ANY($6::text[])
        GROUP BY u.id, u.minecraft_username`,
      [...range, STAKE_KINDS, REFUND_KINDS, GAME_KINDS],
    ),
  ]);

  const currentKinds = toKindMap(current.rows);
  const totals = summarize(currentKinds);
  const previousTotals = summarize(toKindMap(previous.rows));

  /* The series: every bucket in the window, empty ones included, so a quiet day is a zero on the
   * chart rather than a gap that joins its neighbours. */
  const key = (at: Date) => String(at.getTime() / 1000);
  const byBucket = new Map<string, Map<string, KindAggregate>>();
  for (const row of series.rows) {
    const bucket = row.bucket;
    if (!byBucket.has(bucket)) byBucket.set(bucket, new Map());
    byBucket
      .get(bucket)!
      .set(row.kind, { amount: BigInt(row.amount), rows: Number(row.rows), users: 0 });
  }
  const playersAt = new Map(seriesPlayers.rows.map((row) => [row.bucket, Number(row.players)]));
  const signupsAt = new Map(seriesSignups.rows.map((row) => [row.bucket, Number(row.n)]));

  const ranked = people.rows.map((row) => ({
    id: row.id,
    name: row.name,
    wagered: BigInt(row.staked) - BigInt(row.refunded),
    bets: Number(row.bets),
    net: BigInt(row.net),
  }));
  const byWagered = [...ranked].sort((a, b) =>
    b.wagered > a.wagered ? 1 : b.wagered < a.wagered ? -1 : 0,
  );
  const byNet = [...ranked].sort((a, b) => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0));

  return {
    window,
    includeStaff: options.includeStaff,
    staffAccounts: Number(staff.rows[0]?.n ?? 0),
    totals: {
      ...totals,
      players: Number(players.rows[0]?.players ?? 0),
      newPlayers: Number(signups.rows[0]?.n ?? 0),
      depositors: Number(depositors.rows[0]?.players ?? 0),
      expectedGgr: BigInt(expected.rows[0]?.margin ?? '0'),
    },
    previous: {
      ...previousTotals,
      players: Number(previousPlayers.rows[0]?.players ?? 0),
      newPlayers: Number(previousSignups.rows[0]?.n ?? 0),
    },
    series: window.buckets.map((at) => {
      const bucket = summarize(byBucket.get(key(at)) ?? new Map<string, KindAggregate>());
      return {
        at,
        wagered: bucket.wagered,
        ggr: bucket.ggr,
        promo: bucket.promo + bucket.itemBuybacks,
        net: bucket.net,
        deposits: bucket.deposits,
        withdrawals: bucket.withdrawals,
        players: playersAt.get(key(at)) ?? 0,
        newPlayers: signupsAt.get(key(at)) ?? 0,
        bets: bucket.bets,
      };
    }),
    games: summarizeGames(currentKinds),
    promo: Object.entries(PROMO_KINDS)
      .map(([kind, label]) => ({ kind, label, amount: currentKinds.get(kind)?.amount ?? 0n }))
      .concat([
        {
          kind: 'item_sale',
          label: 'Item buybacks',
          amount: currentKinds.get('item_sale')?.amount ?? 0n,
        },
      ])
      .filter((entry) => entry.amount !== 0n)
      .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)),
    topPlayers: byWagered.slice(0, 10),
    winners: byNet.filter((row) => row.net > 0n).slice(0, 5),
    losers: [...byNet]
      .reverse()
      .filter((row) => row.net < 0n)
      .slice(0, 5),
  };
}

/**
 * The report as JSON: amounts as decimal strings (the console's amount formatting takes minor units
 * as strings so nothing over 2^53 is rounded), instants as ISO text.
 */
export function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJson(entry)]));
  }
  return value;
}
