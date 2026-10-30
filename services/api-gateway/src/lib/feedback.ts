import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { staffPredicate } from './admin-stats.js';
import type { Database, DbClient } from './db.js';
import { AppError } from './errors.js';
import { notDemoPredicate } from './media-test.js';
import { creditWallet } from './wallet.js';
import { addWagerRequirement, requirementFor } from './wager-requirements.js';

/**
 * Player feedback: what to add or fix, in the player's own words, and one survey answer (do you
 * like the 3D games?). Stored in player_feedback (migration 085), read by staff in the admin panel.
 *
 * The first note an account sends is rewarded once, FEEDBACK_REWARD_MINOR (1M by default), paid
 * through the ledger as 'feedback_reward' with the wager requirement every kind of free money
 * carries (signupBonusWagerMultiplier, lib/wager-requirements.ts). Only an account that has played
 * a little (FEEDBACK_MIN_WAGER_MINOR, lifetime) earns it, so a fresh alt cannot collect a million
 * for one sentence; staff, developer logins and media-test twins can write but are never paid.
 * Later notes are welcome and paid nothing; a player may send a few a day, not a stream.
 *
 * The survey is counted by each player's LATEST answer: three notes are one vote, and a player who
 * changes their mind is counted as they think now.
 */

export const FEEDBACK_MIN_CHARS = 20;
export const FEEDBACK_MAX_CHARS = 1_000;
/** Notes one account may send in a day. */
export const FEEDBACK_DAILY_LIMIT = 3;

type Runner = Pick<DbClient, 'query'>;

export interface FeedbackStatus {
  readonly enabled: boolean;
  readonly rewardMinor: string;
  /** Already paid for a note. */
  readonly rewarded: boolean;
  /** A note sent now would be paid. */
  readonly eligible: boolean;
  /** Why it would not be, when it would not: 'played' (play a little first) or 'staff'. */
  readonly reason: 'played' | 'staff' | null;
  readonly minWagerMinor: string;
  readonly wageredMinor: string;
  /** The player's latest survey answer, or null before the first. */
  readonly likes3d: boolean | null;
  readonly notesToday: number;
}

const STATUS_SQL = `
  SELECT coalesce((SELECT t.wagered_minor FROM user_wager_totals t WHERE t.user_id = u.id), 0)::text AS wagered_minor,
         EXISTS (SELECT 1 FROM player_feedback f WHERE f.user_id = u.id AND f.reward_minor > 0) AS rewarded,
         (SELECT f.likes_3d FROM player_feedback f WHERE f.user_id = u.id ORDER BY f.created_at DESC LIMIT 1) AS likes_3d,
         (SELECT count(*) FROM player_feedback f
           WHERE f.user_id = u.id AND f.created_at > now() - interval '1 day')::int AS notes_today,
         (u.status = 'active' AND ${notDemoPredicate('u')} AND NOT ${staffPredicate('u')}) AS counts
    FROM users u
   WHERE u.id = $1`;

interface StatusRow {
  wagered_minor: string;
  rewarded: boolean;
  likes_3d: boolean | null;
  notes_today: number;
  counts: boolean;
}

function toStatus(config: AppConfig, row: StatusRow | undefined): FeedbackStatus {
  const wagered = BigInt(row?.wagered_minor ?? '0');
  const counts = Boolean(row?.counts);
  const played = wagered >= config.feedbackMinWagerMinor;
  const rewarded = Boolean(row?.rewarded);
  return {
    enabled: config.feedbackEnabled,
    rewardMinor: config.feedbackRewardMinor.toString(),
    rewarded,
    eligible: config.feedbackEnabled && config.feedbackRewardMinor > 0n && counts && played && !rewarded,
    reason: !counts ? 'staff' : !played ? 'played' : null,
    minWagerMinor: config.feedbackMinWagerMinor.toString(),
    wageredMinor: wagered.toString(),
    likes3d: row?.likes_3d ?? null,
    notesToday: row?.notes_today ?? 0,
  };
}

export async function readFeedbackStatus(db: Runner, config: AppConfig, userId: string): Promise<FeedbackStatus> {
  const result = await db.query<StatusRow>(STATUS_SQL, [userId]);
  return toStatus(config, result.rows[0]);
}

export interface FeedbackInput {
  readonly likes3d: boolean;
  readonly message: string;
}

export interface FeedbackResult {
  readonly id: string;
  readonly rewardMinor: string;
}

/** Stores a note and, if it is the account's first paid one, pays it. Serialised per account. */
export async function submitFeedback(
  db: Database,
  config: AppConfig,
  userId: string,
  input: FeedbackInput,
): Promise<FeedbackResult> {
  if (!config.feedbackEnabled) throw new AppError(404, 'FEEDBACK_DISABLED', 'Feedback is not open right now');
  const message = input.message.trim();
  if (message.length < FEEDBACK_MIN_CHARS || message.length > FEEDBACK_MAX_CHARS) {
    throw new AppError(400, 'FEEDBACK_LENGTH', `Write between ${FEEDBACK_MIN_CHARS} and ${FEEDBACK_MAX_CHARS} characters`);
  }

  return db.transaction(async (client) => {
    /* One note at a time per account: two tabs pressing Send together cannot both be the first. */
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const status = toStatus(config, (await client.query<StatusRow>(STATUS_SQL, [userId])).rows[0]);
    if (status.notesToday >= FEEDBACK_DAILY_LIMIT) {
      throw new AppError(429, 'FEEDBACK_LIMIT', 'Thanks, that is plenty for today. Send more tomorrow');
    }

    const reward = status.eligible ? config.feedbackRewardMinor : 0n;
    const id = randomUUID();
    await client.query(
      `INSERT INTO player_feedback (id, user_id, likes_3d, message, reward_minor) VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, input.likes3d, message, reward.toString()],
    );
    if (reward > 0n) {
      await creditWallet(client, userId, reward, 'feedback_reward', id);
      await addWagerRequirement(client, userId, requirementFor(reward, config.signupBonusWagerMultiplier));
    }
    return { id, rewardMinor: reward.toString() };
  });
}

export interface FeedbackAdminView {
  readonly survey: { readonly yes: number; readonly no: number };
  readonly paid: { readonly notes: number; readonly totalMinor: string };
  readonly notes: {
    readonly id: string;
    readonly player: string;
    readonly likes3d: boolean;
    readonly message: string;
    readonly rewardMinor: string;
    readonly createdAt: string;
  }[];
}

/** For staff: the survey's tally by latest answer, what the rewards have cost, and the newest notes. */
export async function readFeedbackAdmin(db: Runner, limit: number): Promise<FeedbackAdminView> {
  const [survey, paid, notes] = await Promise.all([
    db.query<{ likes_3d: boolean; voters: number }>(
      `SELECT likes_3d, count(*)::int AS voters
         FROM (SELECT DISTINCT ON (user_id) user_id, likes_3d FROM player_feedback ORDER BY user_id, created_at DESC) latest
        GROUP BY likes_3d`,
    ),
    db.query<{ notes: number; total_minor: string }>(
      `SELECT count(*)::int AS notes, coalesce(sum(reward_minor), 0)::text AS total_minor
         FROM player_feedback WHERE reward_minor > 0`,
    ),
    db.query<{ id: string; player: string; likes_3d: boolean; message: string; reward_minor: string; created_at: Date }>(
      `SELECT f.id, u.minecraft_username AS player, f.likes_3d, f.message, f.reward_minor::text AS reward_minor, f.created_at
         FROM player_feedback f JOIN users u ON u.id = f.user_id
        ORDER BY f.created_at DESC, f.id
        LIMIT $1`,
      [limit],
    ),
  ]);
  const tally = (value: boolean) => survey.rows.find((row) => row.likes_3d === value)?.voters ?? 0;
  return {
    survey: { yes: tally(true), no: tally(false) },
    paid: { notes: paid.rows[0]?.notes ?? 0, totalMinor: paid.rows[0]?.total_minor ?? '0' },
    notes: notes.rows.map((row) => ({
      id: row.id,
      player: row.player,
      likes3d: row.likes_3d,
      message: row.message,
      rewardMinor: row.reward_minor,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
