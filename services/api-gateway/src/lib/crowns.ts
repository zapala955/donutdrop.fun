import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { staffPredicate } from './admin-stats.js';
import type { Database, DbClient } from './db.js';
import { maskedName } from './masked-name.js';
import { notDemoPredicate } from './media-test.js';
import { liveEvents } from './live-events.js';
import { noticeSoon } from './notifications.js';
import { creditWallet } from './wallet.js';
import { addWagerRequirement, requirementFor } from './wager-requirements.js';

/**
 * crowns.ts — who holds the best multiplier on each house game, and the bounties for reaching one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT A CROWN IS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The single best round on one house game inside a rolling window (30 days by default): the
 * highest payout / stake, at or above a minimum stake, by an active player who is not staff and
 * not a media test twin. A tie on the multiplier goes to the bigger stake; a full tie stays with
 * whoever got there first. It changes hands when a round beats it, and it FALLS when its own round
 * leaves the window, which is the point of the window: a crown cannot be banked and walked away
 * from, so somebody who has stopped playing loses it, and hears about it from the bell.
 *
 * Only games whose multiplier can move are crowned. Roulette and blackjack top out at a fixed
 * multiple (a crown there would only ever be the biggest stake), and the player-versus-player games
 * are left out because two friends could hand each other a record.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW IT IS KEPT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every game settles in its own table and its own transaction, and none of them is touched here: a
 * sweeper reads the rounds afterwards. Each pass looks only at rounds newer than the last pass
 * (minus an overlap, because a row's timestamp is its transaction's START and a slow transaction
 * can commit after a pass has looked past it), and reads the whole window only when it has to —
 * the first pass, and the pass after a crown fell, when the next best can be anything still in
 * the window. Reads happen outside any transaction; the write is a short transaction under the
 * game's own advisory lock that re-reads the current crown and gives up if it moved, so two
 * instances of the API can sweep at once and still crown each round once.
 *
 * Every reign is a row, ended or not (migration 081), so "your crown was taken" in the bell is a
 * read of a player's ended reigns, never a stored message that could disagree with them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * BOUNTIES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A prize, set by staff, for the FIRST round after it opens that reaches a multiplier on one game
 * at a minimum stake. The same sweeper finds it, in round order, and pays it once through the
 * ledger, keyed on the bounty's own id (wallet_transactions is unique on kind and reference), with
 * the wager requirement every reward on the site carries. Nobody is paid by the browser saying so.
 */

export const CROWN_GAMES = [
  'case',
  'upgrader',
  'crash',
  'mines',
  'tower',
  'chicken',
  'plinko',
  'slots',
  'dice',
] as const;
export type CrownGame = (typeof CROWN_GAMES)[number];

/** Where one game's finished rounds live, and which columns hold the stake, payout and time. */
interface RoundSource {
  readonly table: string;
  /** When the round settled. The window and the scan are both measured on it. */
  readonly at: string;
  readonly stake: string;
  readonly payout: string;
  /** Which rows are finished rounds, for the table alias `r`. */
  readonly settled: string;
}

/* The same tables, columns and "finished" conditions as the home page's biggest wins
 * (routes/activity.ts), so a crown is always a round that board would show too. */
export const ROUND_SOURCES: Readonly<Record<CrownGame, RoundSource>> = Object.freeze({
  case: {
    table: 'case_rounds',
    at: 'created_at',
    stake: 'price_minor',
    payout: 'payout_minor',
    settled: 'true',
  },
  upgrader: {
    table: 'upgrader_rounds',
    at: 'created_at',
    stake: 'stake_value_minor',
    payout: 'payout_minor',
    settled: "r.outcome = 'win'",
  },
  crash: {
    table: 'crash_bets',
    at: 'settled_at',
    stake: 'stake_minor',
    payout: 'payout_minor',
    settled: "r.status <> 'active'",
  },
  mines: {
    table: 'mines_games',
    at: 'settled_at',
    stake: 'stake_minor',
    payout: 'payout_minor',
    settled: "r.status = 'settled'",
  },
  tower: {
    table: 'tower_games',
    at: 'settled_at',
    stake: 'stake_minor',
    payout: 'payout_minor',
    settled: "r.status = 'settled'",
  },
  chicken: {
    table: 'chicken_games',
    at: 'settled_at',
    stake: 'stake_minor',
    payout: 'payout_minor',
    settled: "r.status = 'settled'",
  },
  plinko: {
    table: 'plinko_bets',
    at: 'created_at',
    stake: 'stake_minor',
    payout: 'payout_minor',
    settled: 'true',
  },
  slots: {
    table: 'slots_spins',
    at: 'created_at',
    stake: 'stake_minor',
    payout: 'payout_minor',
    settled: 'true',
  },
  dice: {
    table: 'dice_bets',
    at: 'created_at',
    stake: 'stake_minor',
    payout: 'payout_minor',
    settled: 'true',
  },
});

/** A pass re-reads this much behind where the last one stopped (see the header). */
export const SCAN_OVERLAP_MS = 5 * 60_000;
/** The smallest multiplier that is a win at all: 1.01x. A round that returned its stake is not one. */
const MIN_WIN_X100 = 101n;
/** Open bounties at once. A guard against a slipped finger, not an economic limit. */
export const MAX_OPEN_BOUNTIES = 20;

export interface CandidateRound {
  readonly round_id: string;
  readonly user_id: string;
  readonly stake_minor: string;
  readonly payout_minor: string;
  readonly multiplier_x100: string;
  readonly hit_at: Date;
}

interface ReignRow {
  readonly id: string;
  readonly user_id: string;
  readonly multiplier_x100: string;
  readonly stake_minor: string;
  readonly hit_at: Date;
}

/**
 * One round from one game, between two instants, at or above a stake and a multiplier: the best
 * one (for a crown) or the earliest one (for a bounty). The multiplier is integer hundredths, the
 * same arithmetic the reign row stores, so what the query ranks is exactly what gets compared.
 */
export function roundQuery(game: CrownGame, order: 'best' | 'first'): string {
  const { table, at, stake, payout, settled } = ROUND_SOURCES[game];
  const multiplier = `((r.${payout} * 100) / r.${stake})`;
  const rank =
    order === 'best'
      ? `${multiplier} DESC, r.${stake} DESC, r.${at} ASC, r.id ASC`
      : `r.${at} ASC, r.id ASC`;
  return `SELECT r.id AS round_id, r.user_id, r.${stake}::text AS stake_minor,
                 r.${payout}::text AS payout_minor, ${multiplier}::text AS multiplier_x100,
                 r.${at} AS hit_at
            FROM ${table} r JOIN users u ON u.id = r.user_id
           WHERE ${settled}
             AND r.${at} >= $1 AND r.${at} <= $2
             AND r.${stake} >= $3 AND r.${stake} > 0 AND r.${payout} > r.${stake}
             AND ${multiplier} >= $4
             AND u.status = 'active' AND ${notDemoPredicate('u')} AND NOT ${staffPredicate('u')}
           ORDER BY ${rank}
           LIMIT 1`;
}

/** Whether a round takes the crown from the current holder: a higher multiplier, or the same
 * multiplier on a bigger stake. An equal round leaves the crown where it is. */
export function beats(
  candidate: Pick<CandidateRound, 'multiplier_x100' | 'stake_minor'>,
  current: Pick<ReignRow, 'multiplier_x100' | 'stake_minor'> | null,
): boolean {
  if (!current) return true;
  const a = BigInt(candidate.multiplier_x100);
  const b = BigInt(current.multiplier_x100);
  if (a !== b) return a > b;
  return BigInt(candidate.stake_minor) > BigInt(current.stake_minor);
}

export interface CrownChange {
  readonly game: CrownGame;
  /** Who lost it and how, or null when the game had no crown. */
  readonly lost: { readonly userId: string; readonly reason: 'beaten' | 'expired' } | null;
  /** Who holds it now, or null when it fell and nothing in the window could take it. */
  readonly holderId: string | null;
}

/** One game's pass. Returns what changed, or null. Exported for the tests. */
export async function sweepCrown(
  db: Database,
  config: AppConfig,
  game: CrownGame,
  now: Date,
): Promise<CrownChange | null> {
  const windowStart = new Date(now.getTime() - config.crownWindowDays * 86_400_000);
  const [state, current] = await Promise.all([
    db.query<{ scanned_until: Date }>(
      'SELECT scanned_until FROM crown_scan_state WHERE game = $1',
      [game],
    ),
    db.query<ReignRow>(
      `SELECT id, user_id, multiplier_x100::text AS multiplier_x100,
              stake_minor::text AS stake_minor, hit_at
         FROM crown_reigns WHERE game = $1 AND ended_at IS NULL`,
      [game],
    ),
  ]);
  const seen = current.rows[0] ?? null;
  const falls = seen !== null && new Date(seen.hit_at).getTime() < windowStart.getTime();
  const holder = falls ? null : seen;
  const scannedUntil = state.rows[0]?.scanned_until ? new Date(state.rows[0].scanned_until) : null;

  /* The whole window on the first pass and after a fall; otherwise only what is new. */
  const from =
    !scannedUntil || falls
      ? windowStart
      : new Date(Math.max(windowStart.getTime(), scannedUntil.getTime() - SCAN_OVERLAP_MS));
  const found = await db.query<CandidateRound>(roundQuery(game, 'best'), [
    from,
    now,
    config.crownMinStakeMinor.toString(),
    MIN_WIN_X100.toString(),
  ]);
  const candidate = found.rows[0] ?? null;
  const takes = candidate !== null && beats(candidate, holder) ? candidate : null;

  return db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`crowns:${game}`]);
    const live = await client.query<{ id: string }>(
      'SELECT id FROM crown_reigns WHERE game = $1 AND ended_at IS NULL FOR UPDATE',
      [game],
    );
    /* Somebody else moved the crown since the read above: leave it to the next pass, and leave the
     * scan where it was so that pass reads these rounds again. */
    if ((live.rows[0]?.id ?? null) !== (seen?.id ?? null)) return null;

    await client.query(
      `INSERT INTO crown_scan_state (game, scanned_until) VALUES ($1, $2)
       ON CONFLICT (game) DO UPDATE
         SET scanned_until = GREATEST(crown_scan_state.scanned_until, EXCLUDED.scanned_until)`,
      [game, now],
    );
    if (!falls && !takes) return null;

    const nextId = takes ? randomUUID() : null;
    if (seen) {
      await client.query(
        `UPDATE crown_reigns
            SET ended_at = now(), ended_reason = $2, ended_by = $3
          WHERE id = $1 AND ended_at IS NULL`,
        [seen.id, falls ? 'expired' : 'beaten', falls ? null : nextId],
      );
    }
    if (takes && nextId) {
      await client.query(
        `INSERT INTO crown_reigns
           (id, game, user_id, round_id, multiplier_x100, stake_minor, payout_minor, hit_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          nextId,
          game,
          takes.user_id,
          takes.round_id,
          takes.multiplier_x100,
          takes.stake_minor,
          takes.payout_minor,
          takes.hit_at,
        ],
      );
    }
    return {
      game,
      lost: seen
        ? { userId: seen.user_id, reason: falls ? ('expired' as const) : ('beaten' as const) }
        : null,
      holderId: takes?.user_id ?? null,
    };
  });
}

interface OpenBounty {
  readonly id: string;
  readonly game: CrownGame;
  readonly min_multiplier_x100: string;
  readonly min_stake_minor: string;
  readonly opens_at: Date;
  readonly closes_at: Date;
  readonly scanned_until: Date | null;
}

export interface BountyOutcome {
  readonly id: string;
  readonly status: 'won' | 'expired';
  readonly winnerId: string | null;
}

/** Looks for each open bounty's first qualifying round, pays the winner, and closes what ran out. */
export async function sweepBounties(
  db: Database,
  config: AppConfig,
  now: Date,
): Promise<BountyOutcome[]> {
  const open = await db.query<OpenBounty>(
    `SELECT id, game, min_multiplier_x100::text AS min_multiplier_x100,
            min_stake_minor::text AS min_stake_minor, opens_at, closes_at, scanned_until
       FROM crown_bounties
      WHERE status = 'open' AND opens_at <= $1
      ORDER BY opens_at, id`,
    [now],
  );
  const outcomes: BountyOutcome[] = [];
  for (const bounty of open.rows) {
    const opensAt = new Date(bounty.opens_at).getTime();
    const closesAt = new Date(bounty.closes_at).getTime();
    const from = bounty.scanned_until
      ? new Date(Math.max(opensAt, new Date(bounty.scanned_until).getTime() - SCAN_OVERLAP_MS))
      : new Date(opensAt);
    const until = new Date(Math.min(now.getTime(), closesAt));
    const hit = await db.query<CandidateRound>(roundQuery(bounty.game, 'first'), [
      from,
      until,
      bounty.min_stake_minor,
      bounty.min_multiplier_x100,
    ]);
    const winner = hit.rows[0] ?? null;

    if (winner) {
      const paid = await db.transaction(async (client) => {
        const won = await client.query<{ prize_minor: string }>(
          `UPDATE crown_bounties
              SET status = 'won', winner_user_id = $2, winning_round_id = $3,
                  winning_multiplier_x100 = $4, won_at = now(), scanned_until = $5
            WHERE id = $1 AND status = 'open'
            RETURNING prize_minor::text AS prize_minor`,
          [bounty.id, winner.user_id, winner.round_id, winner.multiplier_x100, until],
        );
        const prize = won.rows[0] ? BigInt(won.rows[0].prize_minor) : 0n;
        if (prize <= 0n) return false;
        await creditWallet(client, winner.user_id, prize, 'bounty_reward', bounty.id);
        await addWagerRequirement(
          client,
          winner.user_id,
          requirementFor(prize, config.signupBonusWagerMultiplier),
        );
        return true;
      });
      if (paid) outcomes.push({ id: bounty.id, status: 'won', winnerId: winner.user_id });
      continue;
    }

    if (now.getTime() >= closesAt) {
      const closed = await db.query(
        `UPDATE crown_bounties SET status = 'expired', scanned_until = $2
          WHERE id = $1 AND status = 'open'`,
        [bounty.id, until],
      );
      if (closed.rowCount) outcomes.push({ id: bounty.id, status: 'expired', winnerId: null });
      continue;
    }

    await db.query(
      `UPDATE crown_bounties SET scanned_until = GREATEST(COALESCE(scanned_until, $2), $2)
        WHERE id = $1 AND status = 'open'`,
      [bounty.id, until],
    );
  }
  return outcomes;
}

const DATABASE_NOW = 'SELECT now() AS now';

export interface SweepOutcome {
  readonly crowns: CrownChange[];
  readonly bounties: BountyOutcome[];
}

/** One whole pass: every crowned game, then every open bounty. Tells the pages what moved. */
export async function runCrownSweep(
  db: Database,
  config: AppConfig,
  now?: Date,
): Promise<SweepOutcome> {
  if (!config.crownsEnabled) return { crowns: [], bounties: [] };
  /* The database's clock, not this process's: the rounds were stamped by it. */
  let at = now;
  if (!at) {
    const clock = await db.query<{ now: Date }>(DATABASE_NOW);
    at = new Date(clock.rows.at(0)!.now);
  }

  const crowns: CrownChange[] = [];
  for (const game of CROWN_GAMES) {
    const change = await sweepCrown(db, config, game, at);
    if (change) crowns.push(change);
  }
  const bounties = await sweepBounties(db, config, at);

  for (const change of crowns) {
    /* Beating your own record is not news, and a crown nobody else took is told by the page. */
    if (change.lost && change.lost.userId !== change.holderId) noticeSoon(change.lost.userId);
  }
  for (const bounty of bounties) {
    if (bounty.winnerId) {
      liveEvents.publish('balance', [bounty.winnerId]);
      noticeSoon(bounty.winnerId);
    }
  }
  if (crowns.length || bounties.length) liveEvents.publish('crowns');
  return { crowns, bounties };
}

export function startCrownSweeper(app: FastifyInstance, db: Database, config: AppConfig): void {
  let running = false;
  const timer = setInterval(() => {
    if (running || !config.crownsEnabled) return;
    running = true;
    runCrownSweep(db, config)
      .then((outcome) => {
        for (const bounty of outcome.bounties) {
          if (bounty.status === 'won') {
            app.log.info({ bountyId: bounty.id, winnerId: bounty.winnerId }, 'crowns: bounty won');
          }
        }
      })
      .catch((error: unknown) => app.log.error({ error }, 'crown sweep failed'))
      .finally(() => {
        running = false;
      });
  }, config.crownSweepSeconds * 1_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface CrownEntry {
  readonly game: CrownGame;
  readonly holder: {
    readonly playerId: string;
    readonly name: string;
    readonly isViewer: boolean;
  } | null;
  readonly multiplierX100: string | null;
  readonly stakeMinor: string | null;
  readonly payoutMinor: string | null;
  readonly hitAt: string | null;
  readonly since: string | null;
  /** When the round leaves the window and the crown falls, unless something beats it first. */
  readonly expiresAt: string | null;
  /** The viewer's own best in the window, at the crown's minimum stake. Null signed out or none. */
  readonly yourBestX100: string | null;
}

export interface BountyEntry {
  readonly id: string;
  readonly game: CrownGame;
  readonly minMultiplierX100: string;
  readonly minStakeMinor: string;
  readonly prizeMinor: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly status: 'open' | 'won' | 'expired' | 'cancelled';
  readonly winner: {
    readonly playerId: string;
    readonly name: string;
    readonly isViewer: boolean;
  } | null;
  readonly winningMultiplierX100: string | null;
  readonly wonAt: string | null;
}

export interface CrownBoard {
  readonly enabled: boolean;
  readonly windowDays: number;
  readonly minStakeMinor: string;
  readonly crowns: readonly CrownEntry[];
  readonly bounties: readonly BountyEntry[];
  /** The latest crowns taken, newest first, for the feed under the board. */
  readonly recent: readonly {
    readonly game: CrownGame;
    readonly name: string;
    readonly playerId: string;
    readonly multiplierX100: string;
    readonly at: string;
  }[];
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

export async function readCrownBoard(
  client: DbClient,
  config: AppConfig,
  viewerId: string | null,
): Promise<CrownBoard> {
  if (!config.crownsEnabled) {
    return {
      enabled: false,
      windowDays: config.crownWindowDays,
      minStakeMinor: config.crownMinStakeMinor.toString(),
      crowns: [],
      bounties: [],
      recent: [],
    };
  }
  const windowDays = config.crownWindowDays;
  const [reigns, bounties, recent, mine] = await Promise.all([
    client.query<{
      game: CrownGame;
      user_id: string;
      name: string;
      multiplier_x100: string;
      stake_minor: string;
      payout_minor: string;
      hit_at: Date;
      started_at: Date;
    }>(
      `SELECT r.game, r.user_id, ${maskedName('u.minecraft_username')} AS name,
              r.multiplier_x100::text AS multiplier_x100, r.stake_minor::text AS stake_minor,
              r.payout_minor::text AS payout_minor, r.hit_at, r.started_at
         FROM crown_reigns r JOIN users u ON u.id = r.user_id
        WHERE r.ended_at IS NULL`,
    ),
    client.query<{
      id: string;
      game: CrownGame;
      min_multiplier_x100: string;
      min_stake_minor: string;
      prize_minor: string;
      opens_at: Date;
      closes_at: Date;
      status: BountyEntry['status'];
      winner_user_id: string | null;
      winner_name: string | null;
      winning_multiplier_x100: string | null;
      won_at: Date | null;
    }>(
      `SELECT b.id, b.game, b.min_multiplier_x100::text AS min_multiplier_x100,
              b.min_stake_minor::text AS min_stake_minor, b.prize_minor::text AS prize_minor,
              b.opens_at, b.closes_at, b.status, b.winner_user_id,
              CASE WHEN w.id IS NULL THEN NULL ELSE ${maskedName('w.minecraft_username')} END AS winner_name,
              b.winning_multiplier_x100::text AS winning_multiplier_x100, b.won_at
         FROM crown_bounties b LEFT JOIN users w ON w.id = b.winner_user_id
        WHERE (b.status = 'open' AND b.closes_at > now())
           OR (b.status IN ('won', 'expired') AND COALESCE(b.won_at, b.closes_at) >= now() - interval '7 days')
        ORDER BY (b.status = 'open') DESC, b.closes_at ASC, b.won_at DESC NULLS LAST
        LIMIT 30`,
    ),
    client.query<{
      game: CrownGame;
      user_id: string;
      name: string;
      multiplier_x100: string;
      started_at: Date;
    }>(
      `SELECT r.game, r.user_id, ${maskedName('u.minecraft_username')} AS name,
              r.multiplier_x100::text AS multiplier_x100, r.started_at
         FROM crown_reigns r JOIN users u ON u.id = r.user_id
        ORDER BY r.started_at DESC
        LIMIT 8`,
    ),
    viewerId
      ? viewerBests(client, config, viewerId)
      : Promise.resolve(new Map<CrownGame, string>()),
  ]);

  const byGame = new Map(reigns.rows.map((row) => [row.game, row]));
  const crowns = CROWN_GAMES.map((game): CrownEntry => {
    const row = byGame.get(game);
    return {
      game,
      holder: row
        ? { playerId: row.user_id, name: row.name, isViewer: row.user_id === viewerId }
        : null,
      multiplierX100: row?.multiplier_x100 ?? null,
      stakeMinor: row?.stake_minor ?? null,
      payoutMinor: row?.payout_minor ?? null,
      hitAt: iso(row?.hit_at),
      since: iso(row?.started_at),
      expiresAt: row
        ? new Date(new Date(row.hit_at).getTime() + windowDays * 86_400_000).toISOString()
        : null,
      yourBestX100: mine.get(game) ?? null,
    };
  });

  return {
    enabled: true,
    windowDays,
    minStakeMinor: config.crownMinStakeMinor.toString(),
    crowns,
    bounties: bounties.rows.map((row) => ({
      id: row.id,
      game: row.game,
      minMultiplierX100: row.min_multiplier_x100,
      minStakeMinor: row.min_stake_minor,
      prizeMinor: row.prize_minor,
      opensAt: iso(row.opens_at)!,
      closesAt: iso(row.closes_at)!,
      status: row.status,
      winner:
        row.winner_user_id && row.winner_name
          ? {
              playerId: row.winner_user_id,
              name: row.winner_name,
              isViewer: row.winner_user_id === viewerId,
            }
          : null,
      winningMultiplierX100: row.winning_multiplier_x100,
      wonAt: iso(row.won_at),
    })),
    recent: recent.rows.map((row) => ({
      game: row.game,
      name: row.name,
      playerId: row.user_id,
      multiplierX100: row.multiplier_x100,
      at: iso(row.started_at)!,
    })),
  };
}

/**
 * The viewer's best multiplier per game inside the window, at the crown's minimum stake: what they
 * would have to beat their own way to the crown. One statement; every branch reads the player's
 * own rows through its table's per-player index.
 */
async function viewerBests(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<Map<CrownGame, string>> {
  const branches = CROWN_GAMES.map((game) => {
    const { table, at, stake, payout, settled } = ROUND_SOURCES[game];
    return `SELECT '${game}'::text AS game, max((r.${payout} * 100) / r.${stake})::text AS best
              FROM ${table} r
             WHERE r.user_id = $1 AND ${settled}
               AND r.${at} >= now() - make_interval(days => $2)
               AND r.${stake} >= $3 AND r.${stake} > 0 AND r.${payout} > r.${stake}`;
  });
  const result = await client.query<{ game: CrownGame; best: string | null }>(
    branches.join('\nUNION ALL\n'),
    [userId, config.crownWindowDays, config.crownMinStakeMinor.toString()],
  );
  const bests = new Map<CrownGame, string>();
  for (const row of result.rows)
    if (row.best && BigInt(row.best) >= MIN_WIN_X100) bests.set(row.game, row.best);
  return bests;
}
