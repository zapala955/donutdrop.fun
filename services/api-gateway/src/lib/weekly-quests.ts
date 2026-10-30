import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { DEPOSIT_KINDS, WITHDRAWAL_KINDS, staffPredicate } from './admin-stats.js';
import type { Database, DbClient } from './db.js';
import { liveEvents } from './live-events.js';
import { maskedName } from './masked-name.js';
import { notDemoPredicate } from './media-test.js';
import { noticeSoon } from './notifications.js';
import { creditWallet } from './wallet.js';
import { addWagerRequirement, requirementFor } from './wager-requirements.js';

/**
 * Weekly quests: two quests per UTC week (Monday to Monday), each with its own prize pot, both
 * meant to bring money and players in rather than to reward play that would have happened anyway.
 *
 *   deposit_race  The players who put the most in this week share the pot by rank. What counts is
 *                 the week's deposits net of its withdrawals, and only as far as they were also
 *                 played that week (the lower of the two): money parked on Sunday and taken out on
 *                 Monday did nothing for anybody, and is not a deposit worth a prize.
 *   recruit       A player whose invite link brought in enough NEW players this week, each of
 *                 whom deposited and wagered a set amount, finishes the quest. Everybody who
 *                 finished shares the pot equally. A friend counts only if their account and their
 *                 invite are both from this week, so it brings players in instead of re-labelling
 *                 existing ones, and an invite voided for coming from the inviter's own network
 *                 (lib/referral-network.ts) does not count.
 *
 * Nothing is counted while the week runs. A round's scores are read from the ledger, the wager log
 * and the referrals, which already hold every deposit, withdrawal, wager and invite with its time,
 * so the board can never disagree with the wallet history behind it. A round is a row (migration
 * 084) that freezes the pot, the split and the thresholds when it opens: what a player is shown
 * while the week runs is what decides it. Staff, developer logins and media-test twins neither
 * place nor count as friends.
 *
 * The sweeper opens the week's rounds and settles each one once its grace period after the week
 * has passed, paying the prizes through the ledger ('weekly_quest_reward', referenced by the payout
 * row) with the wager requirement every kind of free money carries (signupBonusWagerMultiplier,
 * lib/wager-requirements.ts). A round that was open
 * keeps settling even after the quests are switched off: it was promised.
 */

export const WEEKLY_QUESTS = ['deposit_race', 'recruit'] as const;
export type WeeklyQuest = (typeof WEEKLY_QUESTS)[number];

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** The most rows a board reads. A week with more depositors than this is a good problem. */
const BOARD_LIMIT = 500;
/** The places shown on the race's board. */
export const BOARD_SHOWN = 10;

const MONEY_KINDS_SQL = [...DEPOSIT_KINDS, ...WITHDRAWAL_KINDS].map((kind) => `'${kind}'`).join(', ');
const COUNTS = (alias: string) =>
  `${alias}.status = 'active' AND ${notDemoPredicate(alias)} AND NOT ${staffPredicate(alias)}`;

/** Monday 00:00 UTC of the week that holds `at`. */
export function weekStart(at: Date): Date {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
  return new Date(day - sinceMonday * DAY_MS);
}

/** What each place of a race is paid: its share of the pot in basis points, rounded down. */
export function rankPrizes(potMinor: bigint, curve: readonly number[]): bigint[] {
  return curve.map((bps) => (potMinor * BigInt(bps)) / 10_000n);
}

/** One finisher's share of a pot split equally, rounded down (the remainder stays with the house). */
export function equalShare(potMinor: bigint, finishers: number): bigint {
  return finishers > 0 ? potMinor / BigInt(finishers) : 0n;
}

export interface RoundRow {
  readonly id: string;
  readonly quest: WeeklyQuest;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly settles_at: Date;
  readonly pot_minor: string;
  readonly payout_curve: number[];
  readonly min_deposit_minor: string;
  readonly min_wager_minor: string;
  readonly target_count: number;
  readonly settled_at: Date | null;
}

const ROUND_COLUMNS = `id, quest, starts_at, ends_at, settles_at, pot_minor::text AS pot_minor, payout_curve,
       min_deposit_minor::text AS min_deposit_minor, min_wager_minor::text AS min_wager_minor,
       target_count, settled_at`;

type Runner = Pick<DbClient, 'query'>;

/** The figures a new round freezes, from the settings as they stand when it opens. */
function roundTerms(config: AppConfig, quest: WeeklyQuest) {
  return quest === 'deposit_race'
    ? {
        pot: config.depositRacePotMinor,
        curve: config.depositRaceSplitBps,
        minDeposit: config.depositRaceMinDepositMinor,
        minWager: 0n,
        target: config.depositRaceSplitBps.length,
      }
    : {
        pot: config.recruitQuestPotMinor,
        curve: [] as number[],
        minDeposit: config.recruitFriendDepositMinor,
        minWager: config.recruitFriendWagerMinor,
        target: config.recruitQuestFriends,
      };
}

/** This week's round of a quest, opened if it is not open yet. */
export async function ensureRound(
  db: Runner,
  config: AppConfig,
  quest: WeeklyQuest,
  at: Date,
): Promise<RoundRow> {
  const startsAt = weekStart(at);
  const select = () =>
    db.query<RoundRow>(
      `SELECT ${ROUND_COLUMNS} FROM weekly_quest_rounds WHERE quest = $1 AND starts_at = $2`,
      [quest, startsAt],
    );
  /* Read first: the page asks on every visit, and only the first ask of a week has to write. */
  const open = await select();
  if (open.rows[0]) return open.rows[0];

  const endsAt = new Date(startsAt.getTime() + WEEK_MS);
  const settlesAt = new Date(endsAt.getTime() + config.weeklyQuestGraceHours * 3_600_000);
  const terms = roundTerms(config, quest);
  await db.query(
    `INSERT INTO weekly_quest_rounds
       (id, quest, starts_at, ends_at, settles_at, pot_minor, payout_curve, min_deposit_minor,
        min_wager_minor, target_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     ON CONFLICT (quest, starts_at) DO NOTHING`,
    [
      randomUUID(),
      quest,
      startsAt,
      endsAt,
      settlesAt,
      terms.pot.toString(),
      JSON.stringify(terms.curve),
      terms.minDeposit.toString(),
      terms.minWager.toString(),
      terms.target,
    ],
  );
  return (await select()).rows[0]!;
}

/* ─────────── scores ─────────── */

export interface RaceEntry {
  readonly user_id: string;
  readonly player: string;
  /** The week's deposits net of withdrawals, and only as far as they were played. */
  readonly score: string;
  readonly net_minor: string;
  readonly wagered_minor: string;
}

/**
 * The race's entries, best first. $1/$2 bound the week, $3 is the least score that places. Ties go
 * to whoever made their first deposit of the week earlier. A player who deposited nothing, or took
 * out more than they put in, is not on it.
 */
export const RACE_SQL = `
  WITH money AS (
    SELECT t.user_id, sum(t.amount_minor) AS net_minor, min(t.created_at) AS first_at
      FROM wallet_transactions t
     WHERE t.kind IN (${MONEY_KINDS_SQL})
       AND t.created_at >= $1 AND t.created_at < $2
     GROUP BY t.user_id
  ), played AS (
    SELECT w.user_id, sum(w.amount_minor) AS wagered_minor
      FROM wager_events w
     WHERE w.created_at >= $1 AND w.created_at < $2
       AND w.user_id IN (SELECT user_id FROM money WHERE net_minor > 0)
     GROUP BY w.user_id
  )
  SELECT u.id AS user_id, ${maskedName('u.minecraft_username')} AS player,
         LEAST(m.net_minor, coalesce(p.wagered_minor, 0))::text AS score,
         m.net_minor::text AS net_minor, coalesce(p.wagered_minor, 0)::text AS wagered_minor
    FROM money m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN played p ON p.user_id = m.user_id
   WHERE m.net_minor > 0 AND ${COUNTS('u')}
     AND LEAST(m.net_minor, coalesce(p.wagered_minor, 0)) >= $3
   ORDER BY LEAST(m.net_minor, coalesce(p.wagered_minor, 0)) DESC, m.first_at, u.id
   LIMIT ${BOARD_LIMIT}`;

/** One player's own race figures, whether or not they place yet. */
const RACE_SELF_SQL = `
  SELECT coalesce((SELECT sum(t.amount_minor) FROM wallet_transactions t
                    WHERE t.user_id = $1 AND t.kind IN (${MONEY_KINDS_SQL})
                      AND t.created_at >= $2 AND t.created_at < $3), 0)::text AS net_minor,
         coalesce((SELECT sum(w.amount_minor) FROM wager_events w
                    WHERE w.user_id = $1 AND w.created_at >= $2 AND w.created_at < $3), 0)::text
           AS wagered_minor`;

export interface FriendRow {
  readonly referrer_id: string;
  readonly referee_id: string;
  readonly friend: string;
  readonly net_minor: string;
  readonly wagered_minor: string;
  readonly qualified: boolean;
}

/**
 * Every friend invited this week, with what they have deposited and wagered so far. $1/$2 bound the
 * week, $3 is how far to count (the settle time, or now), $4/$5 are what a friend needs. $6 limits
 * it to one inviter, or is NULL for all of them.
 */
export const FRIENDS_SQL = `
  WITH friends AS (
    SELECT r.referrer_id, r.referee_id, ${maskedName('f.minecraft_username')} AS friend
      FROM referrals r
      JOIN users f ON f.id = r.referee_id
      JOIN users i ON i.id = r.referrer_id
     WHERE r.voided_at IS NULL
       AND r.created_at >= $1 AND r.created_at < $2
       AND f.created_at >= $1 AND f.created_at < $2
       AND ${COUNTS('f')} AND ${COUNTS('i')}
       AND ($6::uuid IS NULL OR r.referrer_id = $6::uuid)
  ), money AS (
    SELECT t.user_id, sum(t.amount_minor) AS net_minor
      FROM wallet_transactions t
     WHERE t.user_id IN (SELECT referee_id FROM friends)
       AND t.kind IN (${MONEY_KINDS_SQL}) AND t.created_at < $3
     GROUP BY t.user_id
  ), played AS (
    SELECT w.user_id, sum(w.amount_minor) AS wagered_minor
      FROM wager_events w
     WHERE w.user_id IN (SELECT referee_id FROM friends) AND w.created_at < $3
     GROUP BY w.user_id
  )
  SELECT fr.referrer_id, fr.referee_id, fr.friend,
         coalesce(m.net_minor, 0)::text AS net_minor, coalesce(p.wagered_minor, 0)::text AS wagered_minor,
         (coalesce(m.net_minor, 0) >= $4 AND coalesce(p.wagered_minor, 0) >= $5) AS qualified
    FROM friends fr
    LEFT JOIN money m ON m.user_id = fr.referee_id
    LEFT JOIN played p ON p.user_id = fr.referee_id
   ORDER BY fr.referrer_id, qualified DESC, coalesce(m.net_minor, 0) DESC`;

/** The inviters who finished, with how many qualified friends each brought. */
export function finishers(rows: readonly FriendRow[], target: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.qualified) counts.set(row.referrer_id, (counts.get(row.referrer_id) ?? 0) + 1);
  }
  for (const [id, count] of counts) if (count < target) counts.delete(id);
  return counts;
}

async function readRace(db: Runner, round: RoundRow): Promise<RaceEntry[]> {
  const result = await db.query<RaceEntry>(RACE_SQL, [round.starts_at, round.ends_at, round.min_deposit_minor]);
  return result.rows;
}

async function readFriends(db: Runner, round: RoundRow, until: Date, onlyFor: string | null) {
  const result = await db.query<FriendRow>(FRIENDS_SQL, [
    round.starts_at,
    round.ends_at,
    until,
    round.min_deposit_minor,
    round.min_wager_minor,
    onlyFor,
  ]);
  return result.rows;
}

/* ─────────── settling ─────────── */

export interface Paid {
  readonly roundId: string;
  readonly quest: WeeklyQuest;
  readonly userId: string;
  readonly amountMinor: bigint;
}

/** Settles one round once and pays it. Returns what was paid (nothing if it was already settled). */
export async function settleRound(db: Database, config: AppConfig, roundId: string): Promise<Paid[]> {
  return db.transaction(async (client) => {
    const claimed = await client.query<RoundRow>(
      `UPDATE weekly_quest_rounds SET settled_at = now()
        WHERE id = $1 AND settled_at IS NULL AND settles_at <= now()
        RETURNING ${ROUND_COLUMNS}`,
      [roundId],
    );
    const round = claimed.rows[0];
    if (!round) return [];

    const pot = BigInt(round.pot_minor);
    const winners: { userId: string; rank: number; score: bigint; amount: bigint }[] = [];
    if (round.quest === 'deposit_race') {
      const prizes = rankPrizes(pot, round.payout_curve);
      const entries = await readRace(client, round);
      entries.slice(0, prizes.length).forEach((entry, index) => {
        winners.push({ userId: entry.user_id, rank: index + 1, score: BigInt(entry.score), amount: prizes[index]! });
      });
    } else {
      const done = finishers(await readFriends(client, round, round.settles_at, null), round.target_count);
      const share = equalShare(pot, done.size);
      for (const [userId, count] of done) winners.push({ userId, rank: 1, score: BigInt(count), amount: share });
    }

    const paid: Paid[] = [];
    for (const winner of winners) {
      if (winner.amount <= 0n) continue;
      const payoutId = randomUUID();
      await client.query(
        `INSERT INTO weekly_quest_payouts (id, round_id, user_id, rank, score, amount_minor)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [payoutId, round.id, winner.userId, winner.rank, winner.score.toString(), winner.amount.toString()],
      );
      await creditWallet(client, winner.userId, winner.amount, 'weekly_quest_reward', payoutId);
      await addWagerRequirement(
        client,
        winner.userId,
        requirementFor(winner.amount, config.signupBonusWagerMultiplier),
      );
      paid.push({ roundId: round.id, quest: round.quest, userId: winner.userId, amountMinor: winner.amount });
    }
    return paid;
  });
}

const DATABASE_NOW = 'SELECT now() AS now';

/** One pass: open this week's rounds (while the quests are on) and settle every round that is due. */
export async function runWeeklyQuestSweep(db: Database, config: AppConfig): Promise<Paid[]> {
  /* The database's clock, not this process's: the deposits and wagers were stamped by it. */
  const clock = await db.query<{ now: Date }>(DATABASE_NOW);
  const now = new Date(clock.rows.at(0)!.now);
  if (config.weeklyQuestsEnabled) {
    for (const quest of WEEKLY_QUESTS) await ensureRound(db, config, quest, now);
  }
  const due = await db.query<{ id: string }>(
    `SELECT id FROM weekly_quest_rounds WHERE settled_at IS NULL AND settles_at <= $1 ORDER BY settles_at, id`,
    [now],
  );
  const paid: Paid[] = [];
  for (const round of due.rows) paid.push(...(await settleRound(db, config, round.id)));
  if (paid.length) {
    const winners = paid.map((item) => item.userId);
    liveEvents.publish('balance', winners);
    for (const userId of winners) noticeSoon(userId);
  }
  return paid;
}

export function startWeeklyQuestSweeper(app: FastifyInstance, db: Database, config: AppConfig): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runWeeklyQuestSweep(db, config)
      .then((paid) => {
        for (const item of paid) {
          app.log.info(
            { quest: item.quest, roundId: item.roundId, userId: item.userId, amountMinor: item.amountMinor.toString() },
            'weekly quests: prize paid',
          );
        }
      })
      .catch((error: unknown) => app.log.error({ error }, 'weekly quest sweep failed'))
      .finally(() => {
        running = false;
      });
  }, config.weeklyQuestSweepSeconds * 1_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

/* ─────────── what the page shows ─────────── */

export interface WeeklyQuestBoard {
  readonly enabled: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly settlesAt: string | null;
  readonly depositRace: {
    readonly potMinor: string;
    readonly prizes: string[];
    readonly minDepositMinor: string;
    readonly board: { rank: number; player: string; scoreMinor: string; prizeMinor: string }[];
    readonly entrants: number;
    readonly you: {
      readonly netMinor: string;
      readonly wageredMinor: string;
      readonly scoreMinor: string;
      readonly rank: number | null;
    } | null;
    readonly lastWinners: { rank: number; player: string; amountMinor: string }[];
  } | null;
  readonly recruit: {
    readonly potMinor: string;
    readonly friendsNeeded: number;
    readonly friendDepositMinor: string;
    readonly friendWagerMinor: string;
    readonly finishers: number;
    /** What each finisher would get if the week ended now (the whole pot for the first). */
    readonly shareMinor: string;
    readonly you: {
      readonly qualified: number;
      readonly done: boolean;
      readonly friends: { player: string; netMinor: string; wageredMinor: string; qualified: boolean }[];
    } | null;
    readonly lastFinishers: { player: string; amountMinor: string }[];
  } | null;
  readonly wagerMultiplier: number;
}

async function lastWinners(db: Runner, quest: WeeklyQuest) {
  const result = await db.query<{ rank: number; player: string; amount_minor: string }>(
    `SELECT p.rank, ${maskedName('u.minecraft_username')} AS player, p.amount_minor::text AS amount_minor
       FROM weekly_quest_payouts p
       JOIN users u ON u.id = p.user_id
      WHERE p.round_id = (SELECT id FROM weekly_quest_rounds
                           WHERE quest = $1 AND settled_at IS NOT NULL
                           ORDER BY starts_at DESC LIMIT 1)
      ORDER BY p.rank, p.amount_minor DESC, p.created_at
      LIMIT ${BOARD_SHOWN}`,
    [quest],
  );
  return result.rows;
}

export async function readWeeklyQuests(
  db: Database,
  config: AppConfig,
  userId: string | null,
): Promise<WeeklyQuestBoard> {
  if (!config.weeklyQuestsEnabled) {
    return {
      enabled: false, startsAt: null, endsAt: null, settlesAt: null,
      depositRace: null, recruit: null, wagerMultiplier: config.signupBonusWagerMultiplier,
    };
  }
  const clock = await db.query<{ now: Date }>(DATABASE_NOW);
  const now = new Date(clock.rows.at(0)!.now);
  const [race, recruit] = await Promise.all([
    ensureRound(db, config, 'deposit_race', now),
    ensureRound(db, config, 'recruit', now),
  ]);

  const prizes = rankPrizes(BigInt(race.pot_minor), race.payout_curve);
  const [entries, friends, raceSelf, lastRace, lastRecruit] = await Promise.all([
    readRace(db, race),
    readFriends(db, recruit, now, null),
    userId
      ? db.query<{ net_minor: string; wagered_minor: string }>(RACE_SELF_SQL, [userId, race.starts_at, race.ends_at])
      : Promise.resolve(null),
    lastWinners(db, 'deposit_race'),
    lastWinners(db, 'recruit'),
  ]);

  let you: NonNullable<WeeklyQuestBoard['depositRace']>['you'] = null;
  if (userId && raceSelf) {
    const self = raceSelf.rows[0] ?? { net_minor: '0', wagered_minor: '0' };
    const net = BigInt(self.net_minor);
    const wagered = BigInt(self.wagered_minor);
    const score = net > 0n ? (net < wagered ? net : wagered) : 0n;
    const at = entries.findIndex((entry) => entry.user_id === userId);
    you = {
      netMinor: self.net_minor,
      wageredMinor: self.wagered_minor,
      scoreMinor: score.toString(),
      rank: at >= 0 ? at + 1 : null,
    };
  }

  const done = finishers(friends, recruit.target_count);
  const mine = userId ? friends.filter((row) => row.referrer_id === userId) : [];
  const qualified = mine.filter((row) => row.qualified).length;
  const finisherCount = done.size;

  return {
    enabled: true,
    startsAt: new Date(race.starts_at).toISOString(),
    endsAt: new Date(race.ends_at).toISOString(),
    settlesAt: new Date(race.settles_at).toISOString(),
    depositRace: {
      potMinor: race.pot_minor,
      prizes: prizes.map(String),
      minDepositMinor: race.min_deposit_minor,
      board: entries.slice(0, BOARD_SHOWN).map((entry, index) => ({
        rank: index + 1,
        player: entry.player,
        scoreMinor: entry.score,
        prizeMinor: (prizes[index] ?? 0n).toString(),
      })),
      entrants: entries.length,
      you,
      lastWinners: lastRace.map((row) => ({ rank: row.rank, player: row.player, amountMinor: row.amount_minor })),
    },
    recruit: {
      potMinor: recruit.pot_minor,
      friendsNeeded: recruit.target_count,
      friendDepositMinor: recruit.min_deposit_minor,
      friendWagerMinor: recruit.min_wager_minor,
      finishers: finisherCount,
      shareMinor: equalShare(BigInt(recruit.pot_minor), Math.max(finisherCount, 1)).toString(),
      you: userId
        ? {
            qualified,
            done: qualified >= recruit.target_count,
            friends: mine.map((row) => ({
              player: row.friend,
              netMinor: row.net_minor,
              wageredMinor: row.wagered_minor,
              qualified: row.qualified,
            })),
          }
        : null,
      lastFinishers: lastRecruit.map((row) => ({ player: row.player, amountMinor: row.amount_minor })),
    },
    wagerMultiplier: config.signupBonusWagerMultiplier,
  };
}
