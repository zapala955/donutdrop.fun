import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import type { VipProgressEvent } from './vip.js';
import { accrueReferralWager } from './referrals.js';
import { accrueAndDrawJackpot, type JackpotOutcome } from './jackpot.js';
import { accrueRakeback, houseMarginMinor, recordRaceWager } from './rewards.js';
import { recordVipWager } from './vip.js';
import { publishLiveSoon } from './live-events.js';
import { reduceWagerRequirement } from './wager-requirements.js';

/* The cash credit itself lives in wallet.ts and is re-exported here, because every game route
 * already reaches for it through this module and the referral engine below needs it too. */
export { creditWallet, type WalletKind } from './wallet.js';

/**
 * Cash settlement, quest progress and faction contribution.
 *
 * Every game route settles a wager the same way, so the rules live in one place rather than being
 * re-implemented per route where they would quietly drift apart. All three functions take the
 * caller's open transaction: a payout that commits without its contribution row, or a quest tick
 * that survives a rolled-back round, is a reconciliation problem nobody finds until it matters.
 */

/**
 * Everything one wager set in motion that a caller might want to tell the player about.
 *
 * `vip` is non-null only on a wager that crossed a level boundary; `jackpot.win` only on one that
 * drew the pot. Both are already committed by the time this returns — the caller is being informed,
 * not asked.
 */
export interface WagerOutcome {
  readonly vip: VipProgressEvent | null;
  readonly jackpot: JackpotOutcome;
}

export type QuestMetric =
  | 'upgrader_rolls'
  | 'upgrader_wins'
  | 'cases_opened'
  | 'wagered_minor'
  | 'faction_contribution_minor';

export type ContributionSource =
  | 'upgrader'
  | 'case'
  | 'skill_duel'
  | 'roulette';

/**
 * Advances every enabled quest that watches this metric, for the current UTC day.
 *
 * UTC rather than the request's timezone so that "today" is the same day for every player and
 * cannot be re-rolled by changing a header. Already-claimed rows keep counting: the progress bar
 * should keep telling the truth after the reward is taken.
 */
export async function recordQuestProgress(
  client: DbClient,
  userId: string,
  metric: QuestMetric,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) return;
  await client.query(
    `INSERT INTO quest_progress (user_id, quest_code, quest_day, progress_value)
     SELECT $1, q.code, (now() AT TIME ZONE 'utc')::date, $3::bigint
       FROM quest_definitions q
      WHERE q.enabled AND q.metric = $2
     ON CONFLICT (user_id, quest_code, quest_day) DO UPDATE
       SET progress_value = quest_progress.progress_value + EXCLUDED.progress_value,
           updated_at = now()`,
    [userId, metric, amount.toString()],
  );
}

/**
 * Records a wager against the player's faction, if a war is running and they have picked a side.
 *
 * Silently does nothing when there is no live event or the player has not joined one. A wager is
 * not the moment to force a team choice on someone, and refusing the wager over it would make an
 * optional side event able to break the core game.
 */
export async function recordFactionContribution(
  client: DbClient,
  userId: string,
  amountMinor: bigint,
  source: ContributionSource,
  referenceId: string,
): Promise<void> {
  if (amountMinor <= 0n) return;
  const membership = await client.query<{ event_id: string; faction_id: string }>(
    `SELECT m.event_id, m.faction_id
       FROM faction_members m JOIN faction_events e ON e.id = m.event_id
      WHERE m.user_id = $1 AND e.settled_at IS NULL
        AND now() >= e.starts_at AND now() < e.ends_at
      ORDER BY e.starts_at DESC LIMIT 1`,
    [userId],
  );
  const membershipRow = membership.rows[0];
  if (!membershipRow) return;

  await client.query(
    `INSERT INTO faction_contributions
       (id, event_id, faction_id, user_id, amount_minor, source, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source, reference_id) DO NOTHING`,
    [
      randomUUID(),
      membershipRow.event_id,
      membershipRow.faction_id,
      userId,
      amountMinor.toString(),
      source,
      referenceId,
    ],
  );
  await recordQuestProgress(client, userId, 'faction_contribution_minor', amountMinor);
}

/**
 * Everything a wager triggers besides the wager itself: quest counters, the war ledger, the
 * referral engines, rakeback accrual and every live wagering race.
 *
 * One call so a new game route cannot accidentally record half of it. The referral accrual in
 * particular must not be optional per route — a game mode that forgot it would quietly stop a
 * referrer's revenue share and stall a milestone that the player can see counting up.
 */
export async function recordWager(
  client: DbClient,
  config: AppConfig,
  userId: string,
  amountMinor: bigint,
  source: ContributionSource,
  referenceId: string,
  metrics: readonly QuestMetric[],
  /**
   * The margin this wager ACTUALLY generated, for modes where it is not `wager * houseEdgeBps`.
   *
   * Omitted by every mode that charges the standard edge, which keeps their behaviour byte for
   * byte what it was. Passed by skill duels, which charge no edge on the outcome at all and are
   * paid a rake on the pot instead — deriving their margin from the edge would hand rakeback and
   * referral revenue-share a number the house never collected, on every duel, forever.
   *
   * Note what it does NOT change: `amountMinor` is still the real stake, so VIP progress, the
   * referral milestone and the faction war all keep counting genuine wagered volume. Only the
   * two payouts that are explicitly a share of the margin read this.
   */
  marginMinor?: bigint,
): Promise<WagerOutcome> {
  for (const metric of metrics) {
    await recordQuestProgress(client, userId, metric, metric.endsWith('_minor') ? amountMinor : 1n);
  }
  // The full stake, like the referral milestone: what a player owes is wagered volume, not margin.
  await reduceWagerRequirement(client, userId, amountMinor);
  await recordFactionContribution(client, userId, amountMinor, source, referenceId);
  await accrueReferralWager(client, config, userId, amountMinor, source, referenceId, marginMinor);
  await accrueRakeback(client, config, userId, amountMinor, marginMinor);
  await recordRaceWager(client, config, userId, amountMinor);
  await recordWagerEvent(client, config, userId, amountMinor, source, referenceId, marginMinor);
  /* The jackpot draw runs inside the caller's transaction, so a round that rolls back cannot leave
   * a win behind it and a win cannot exist without the wager that drew it. */
  const jackpot = await accrueAndDrawJackpot(
    client,
    config,
    userId,
    amountMinor,
    marginMinor ?? houseMarginMinor(config, amountMinor),
    source,
    referenceId,
  );
  /* VIP last, because it is the only one of these that has anything to say about the player's
   * standing. Callers that want to announce a level-up or a jackpot read the result; callers that
   * do not can ignore it exactly as they ignore everything above. */
  const vip = await recordVipWager(client, config, userId, amountMinor);
  publishLiveSoon('activity');
  publishLiveSoon('balance', [userId]);
  return { vip, jackpot };
}

/**
 * Appends the wager to the time-stamped log.
 *
 * This exists because the platform could not otherwise answer "how much has this player staked in
 * the last hour" — `user_wager_totals` is lifetime and has no clock in it, and faction contributions
 * only get a row when a war is live and the player has picked a side. The lava rain's eligibility
 * window is a question about a span of time, so it needs a table with time in it.
 *
 * ON CONFLICT DO NOTHING on (source, reference_id): a retried settlement must log once, not twice,
 * or the same round pays its way into a rain window repeatedly.
 */
async function recordWagerEvent(
  client: DbClient,
  config: AppConfig,
  userId: string,
  amountMinor: bigint,
  source: ContributionSource,
  referenceId: string,
  marginMinor?: bigint,
): Promise<void> {
  if (amountMinor <= 0n) return;
  const margin = marginMinor ?? houseMarginMinor(config, amountMinor);
  await client.query(
    `INSERT INTO wager_events (id, user_id, amount_minor, margin_minor, source, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source, reference_id) DO NOTHING`,
    [randomUUID(), userId, amountMinor.toString(), margin.toString(), source, referenceId],
  );
}

/**
 * How much a player has staked inside a trailing window.
 *
 * The lava rain's entry bar, and the only question `wager_events` exists to answer. Tips are not in
 * this table at all, deliberately: a tip is not a wager, and if it counted here two accounts could
 * pass the same money back and forth to qualify each other for every drop.
 */
export async function wageredSince(
  client: DbClient,
  userId: string,
  windowMinutes: number,
): Promise<bigint> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total
       FROM wager_events
      WHERE user_id = $1 AND created_at >= now() - make_interval(mins => $2)`,
    [userId, windowMinutes],
  );
  return BigInt(result.rows[0]?.total ?? '0');
}

/**
 * The reward for claiming a streak of a given length.
 *
 * Linear in the streak and capped, rather than exponential. An exponential ladder makes day 30
 * worth more than everything before it combined, which stops being a habit and starts being a
 * hostage situation — and it is the shape that bankrupts the house if anyone actually reaches it.
 */
export function streakRewardMinor(config: AppConfig, streakLength: number): bigint {
  const capped = Math.max(1, Math.min(streakLength, config.streakMaxMultiplier));
  return config.streakBaseRewardMinor * BigInt(capped);
}
