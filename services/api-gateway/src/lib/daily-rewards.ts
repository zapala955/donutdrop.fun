import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { AppError } from './errors.js';

export interface DailyWagerProgress {
  readonly wageredMinor: bigint;
  readonly requiredMinor: bigint;
  readonly remainingMinor: bigint;
  readonly met: boolean;
}

/**
 * Reads the player's settled wagers since midnight UTC.
 *
 * wager_events is written in the same transaction as every game stake and is idempotent on the
 * round reference, so this total cannot be inflated by replaying a settlement or by reporting
 * progress from the browser.
 */
export async function dailyRewardWagerProgress(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<DailyWagerProgress> {
  /* No requirement configured, no query. This runs on every load of the quests page and inside
   * every claim, and summing a day of wager_events to compare it against zero is a scan bought
   * to reach a foregone conclusion. Reporting 0 wagered here would be a lie the progress bar
   * would render, so the real total is still returned -- it is only the aggregate that is
   * skipped, and only when nothing depends on it. */
  if (config.streakDailyWagerRequiredMinor <= 0n) {
    return { wageredMinor: 0n, requiredMinor: 0n, remainingMinor: 0n, met: true };
  }
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total
       FROM wager_events
      WHERE user_id = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`,
    [userId],
  );
  const wageredMinor = BigInt(result.rows[0]?.total ?? '0');
  const requiredMinor = config.streakDailyWagerRequiredMinor;
  const remainingMinor = wageredMinor >= requiredMinor ? 0n : requiredMinor - wageredMinor;
  return {
    wageredMinor,
    requiredMinor,
    remainingMinor,
    met: remainingMinor === 0n,
  };
}

/** Refuses a daily reward before any wallet credit when today's wager threshold is not met. */
export async function requireDailyRewardWager(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<DailyWagerProgress> {
  const progress = await dailyRewardWagerProgress(client, config, userId);
  if (!progress.met) {
    throw new AppError(
      409,
      'STREAK_WAGER_REQUIRED',
      'Wager more today before claiming the daily reward',
      {
        wageredMinor: progress.wageredMinor.toString(),
        requiredMinor: progress.requiredMinor.toString(),
        remainingMinor: progress.remainingMinor.toString(),
      },
    );
  }
  return progress;
}
