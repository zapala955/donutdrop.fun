import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { DEPOSIT_KINDS, WITHDRAWAL_KINDS } from './admin-stats.js';
import { allRoundsSql } from './player-rounds.js';
import type { Database, DbClient } from './db.js';
import { AppError, conflict } from './errors.js';
import { liveEvents } from './live-events.js';
import { creditWallet } from './wallet.js';
import { addWagerRequirement, requirementFor } from './wager-requirements.js';

/**
 * The quest board (migration 087): quests the operator writes in the admin console, such as
 * "deposit $10M, get $1M", that every player can finish once per period.
 *
 * ONE CLOCK FOR EVERY QUEST. A period is three days, starting at 00:00 UTC on every day number since
 * the epoch that divides by three, so it is the same for everybody, cannot be shifted by a timezone,
 * and needs no row to say when it began. Every quest resets together.
 *
 * NOTHING IS COUNTED. A player's progress is read from the ledger and the wager log for the period:
 *
 *   deposit  the period's deposits net of its withdrawals (cash and pay-login deposits, less cash
 *            withdrawals, plus any withdrawal refunded), never below zero. Putting the same money
 *            in and taking it out again moves nothing.
 *   wager    the period's wagers, every game's, as the wager log holds them.
 *   multiplier  the best multiplier hit on one bet of at least the quest's minimum stake, in any
 *            game; the target is in hundredths (2500 is 25x).
 *
 * A CLAIM PAYS ONCE. Its row is unique on (quest, player, period), inserted in the same transaction
 * that credits the wallet; a second claim, a double click or a retried request, finds the row and is
 * refused. Progress is read again inside that transaction, against the database's own clock. The
 * reward is free money, so it carries a wager requirement: the quest rewards' own multiplier
 * (questRewardWagerMultiplier, lib/wager-requirements.ts).
 */

export const QUEST_KINDS = ['deposit', 'wager', 'multiplier'] as const;
export type QuestKind = (typeof QUEST_KINDS)[number];

export const PERIOD_DAYS = 3;
const DAY_MS = 86_400_000;
const PERIOD_MS = PERIOD_DAYS * DAY_MS;

/** The period that holds `at`: [start, end). */
export function periodOf(at: Date): { start: Date; end: Date } {
  const start = Math.floor(at.getTime() / PERIOD_MS) * PERIOD_MS;
  return { start: new Date(start), end: new Date(start + PERIOD_MS) };
}

const MONEY_KINDS = [...DEPOSIT_KINDS, ...WITHDRAWAL_KINDS];

/* Fishing, Ice Fishing and Mob Derby are not in the history's round list (lib/player-rounds.ts);
 * a multiplier quest counts them too. Settled rounds only, with what they staked and paid. */
const EXTRA_ROUNDS = `
  SELECT created_at AS at, stake_minor AS wager, payout_minor AS payout FROM fishing_casts
   WHERE user_id = $1 AND status IN ('landed', 'snapped')
  UNION ALL
  SELECT created_at, stake_minor, coalesce(payout_minor, 0) FROM ice_fishing_games
   WHERE user_id = $1 AND status = 'settled'
  UNION ALL
  SELECT created_at, stake_minor, payout_minor FROM derby_races WHERE user_id = $1`;

/**
 * The best multiplier one player hit on a single bet of at least `minStake` over [start, end), in
 * hundredths (2500 is 25x), rounded down; 0 when there is none. Every game's settled rounds: the
 * history's list (lib/player-rounds.ts) and the three above. A round counts by when it was placed.
 */
export async function bestMultiplierFor(
  client: Pick<DbClient, 'query'>,
  userId: string,
  start: Date,
  end: Date,
  minStake: bigint,
): Promise<bigint> {
  const result = await client.query<{ best: string | null }>(
    `SELECT max(floor(r.payout::numeric * 100 / r.wager))::text AS best
       FROM ((${allRoundsSql()}) UNION ALL (SELECT 'x', 'x', e.at, e.wager, e.payout, '' FROM (${EXTRA_ROUNDS}) e)) r
      WHERE r.at >= $2 AND r.at < $3 AND r.wager >= $4 AND r.wager > 0`,
    [userId, start, end, minStake.toString()],
  );
  return BigInt(result.rows[0]?.best ?? '0');
}

/** One player's progress on deposits and wagers over [start, end), in minor units. */
export async function progressFor(
  client: Pick<DbClient, 'query'>,
  userId: string,
  start: Date,
  end: Date,
): Promise<Record<'deposit' | 'wager', bigint>> {
  const result = await client.query<{ deposit: string; wager: string }>(
    `SELECT
       greatest(0, coalesce((SELECT sum(t.amount_minor) FROM wallet_transactions t
                              WHERE t.user_id = $1 AND t.kind = ANY($4::text[])
                                AND t.created_at >= $2 AND t.created_at < $3), 0))::text AS deposit,
       coalesce((SELECT sum(w.amount_minor) FROM wager_events w
                  WHERE w.user_id = $1 AND w.created_at >= $2 AND w.created_at < $3), 0)::text AS wager`,
    [userId, start, end, MONEY_KINDS],
  );
  const row = result.rows[0];
  return { deposit: BigInt(row?.deposit ?? '0'), wager: BigInt(row?.wager ?? '0') };
}

interface QuestRow {
  id: string;
  name: string;
  description: string;
  kind: QuestKind;
  target_minor: string;
  reward_minor: string;
  sort_order: number;
  min_stake_minor: string | null;
}

/** Where one player stands on one quest: money for deposit and wager, hundredths of a multiplier. */
async function questProgress(
  client: Pick<DbClient, 'query'>,
  row: QuestRow,
  userId: string,
  start: Date,
  end: Date,
  money: Record<'deposit' | 'wager', bigint> | null,
): Promise<bigint> {
  if (row.kind === 'multiplier') return bestMultiplierFor(client, userId, start, end, BigInt(row.min_stake_minor ?? '1'));
  return (money ?? (await progressFor(client, userId, start, end)))[row.kind];
}

export interface BoardQuest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: QuestKind;
  /** Money for deposit and wager; for multiplier, hundredths of the multiplier (2500 is 25x). */
  readonly targetMinor: string;
  readonly rewardMinor: string;
  /** Multiplier quests: the least a bet must stake to count. */
  readonly minStakeMinor: string | null;
  /** Signed in only: where the player stands this period, capped at the target. */
  readonly progressMinor: string | null;
  readonly claimed: boolean;
  readonly claimable: boolean;
}

export interface QuestBoard {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly wagerMultiplier: number;
  readonly quests: BoardQuest[];
}

const DATABASE_NOW = 'SELECT now() AS now';

/** The board as one player sees it (or anybody, signed out): every enabled quest, in order. */
export async function readQuestBoard(db: Database, config: AppConfig, userId: string | null): Promise<QuestBoard> {
  const clock = await db.query<{ now: Date }>(DATABASE_NOW);
  const { start, end } = periodOf(new Date(clock.rows.at(0)!.now));
  const quests = await db.query<QuestRow>(
    `SELECT id, name, description, kind, target_minor, reward_minor, sort_order, min_stake_minor
       FROM board_quests WHERE enabled ORDER BY sort_order, created_at, id`,
  );
  const progress = new Map<string, bigint>();
  let claimed = new Set<string>();
  if (userId && quests.rows.length) {
    const money = quests.rows.some((row) => row.kind !== 'multiplier') ? await progressFor(db, userId, start, end) : null;
    for (const row of quests.rows) progress.set(row.id, await questProgress(db, row, userId, start, end, money));
    const claims = await db.query<{ quest_id: string }>(
      'SELECT quest_id FROM board_quest_claims WHERE user_id = $1 AND period_start = $2',
      [userId, start],
    );
    claimed = new Set(claims.rows.map((row) => row.quest_id));
  }
  return {
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    wagerMultiplier: config.questRewardWagerMultiplier,
    quests: quests.rows.map((row) => {
      const target = BigInt(row.target_minor);
      const done = progress.get(row.id) ?? null;
      const isClaimed = claimed.has(row.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        kind: row.kind,
        targetMinor: row.target_minor,
        rewardMinor: row.reward_minor,
        minStakeMinor: row.min_stake_minor,
        progressMinor: done === null ? null : (done > target ? target : done).toString(),
        claimed: isClaimed,
        claimable: done !== null && !isClaimed && done >= target,
      };
    }),
  };
}

export interface Claimed {
  readonly rewardMinor: string;
  readonly balanceAfterMinor: string;
}

/** Pays one quest for this period, once, if the player has done it. */
export async function claimBoardQuest(
  db: Database,
  config: AppConfig,
  userId: string,
  questId: string,
): Promise<Claimed> {
  const claimed = await db.transaction(async (client) => {
    const quest = await client.query<QuestRow>(
      `SELECT id, name, description, kind, target_minor, reward_minor, sort_order, min_stake_minor
         FROM board_quests WHERE id = $1 AND enabled FOR SHARE`,
      [questId],
    );
    const row = quest.rows[0];
    if (!row) throw new AppError(404, 'QUEST_NOT_FOUND', 'That quest is not on the board');
    const clock = await client.query<{ now: Date }>(DATABASE_NOW);
    const { start, end } = periodOf(new Date(clock.rows.at(0)!.now));
    const done = await questProgress(client, row, userId, start, end, null);
    if (done < BigInt(row.target_minor)) {
      throw new AppError(409, 'QUEST_INCOMPLETE', 'That quest is not finished yet');
    }
    const reward = BigInt(row.reward_minor);
    const claimId = randomUUID();
    const balanceAfter = await creditWallet(client, userId, reward, 'quest_reward', claimId);
    /* The claim's row, unique on (quest, player, period). A second claim for the period finds it
     * and throws, and the throw rolls this transaction back, the credit above with it. Two at once
     * queue on the wallet row the credit locked, so the second always meets the first's row. */
    const inserted = await client.query(
      `INSERT INTO board_quest_claims
         (id, quest_id, user_id, period_start, progress_minor, reward_minor, balance_after_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (quest_id, user_id, period_start) DO NOTHING`,
      [claimId, row.id, userId, start, done.toString(), reward.toString(), balanceAfter],
    );
    if (inserted.rowCount !== 1) conflict('QUEST_ALREADY_CLAIMED', 'That quest is already claimed for this period');
    // Free money: wagered like the signup bonus before it can leave.
    await addWagerRequirement(client, userId, requirementFor(reward, config.questRewardWagerMultiplier));
    return { rewardMinor: reward.toString(), balanceAfterMinor: balanceAfter };
  });
  liveEvents.publish('balance', [userId]);
  return claimed;
}
