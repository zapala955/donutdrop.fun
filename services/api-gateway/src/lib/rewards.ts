import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { creditWallet } from './wallet.js';

/**
 * Rakeback accrual and wagering-race entry.
 *
 * Both hang off the same moment — a wager being settled — and both are paid out of the house
 * margin, so they live together and are driven from the one call every game route already makes.
 *
 * The rates here are shares of the MARGIN, never of turnover. A "10% instant rakeback" priced off
 * the wager would pay twice what the wager earned the house at a 5% edge; priced off the margin
 * it returns a tenth of the edge. The product copy says 10% and means 10% of the edge.
 */

/**
 * One tier, not four.
 *
 * The daily, weekly and monthly clocks were retired in migration 042, which folded whatever they
 * still owed into the instant tier so no player lost a balance. What is left is the tier that
 * never made anybody wait: a share of the house margin, claimable the moment there is one.
 *
 * The 'vip' tier is still written to `rakeback_accruals` and is deliberately not in this list. It
 * is a share of the WAGER rather than of the margin, it accrues from lib/vip.ts, and it is
 * claimed from the VIP page -- it shares a table with this and nothing else.
 */
export const RAKEBACK_TIERS = ['instant'] as const;
export type RakebackTier = (typeof RAKEBACK_TIERS)[number];

/** Kept as a map because the claim path still reads a cooldown; the only tier left has none. */
export const TIER_COOLDOWN_MS: Readonly<Record<RakebackTier, number>> = Object.freeze({
  instant: 0,
});

/** What a wager earns the house, before anything is carved back out of it. */
export function houseMarginMinor(config: AppConfig, wagerMinor: bigint): bigint {
  if (wagerMinor <= 0n) return 0n;
  return (wagerMinor * BigInt(config.houseEdgeBps)) / 10_000n;
}

/**
 * One tier's cash-back on one wager.
 *
 * Integer division truncates, so a wager too small to produce a whole unit earns nothing on that
 * tier. That is correct: the alternative rounds a fraction of a unit up several million times a
 * day, and every one of those roundings is the house paying for arithmetic.
 */
export function rakebackMinor(
  config: AppConfig,
  tier: RakebackTier,
  wagerMinor: bigint,
  marginMinor?: bigint,
): bigint {
  const rate = BigInt(config.rakebackTierBps[tier]);
  /* `marginMinor` is the margin the round ACTUALLY generated, for modes where it is not
   * `wager * houseEdgeBps`. Skill duels are the case that forced this: the house takes no edge on
   * a duel's outcome and is paid a rake on the pot instead, so deriving the margin from the edge
   * would credit rakeback against revenue that was never collected. Every other caller omits it
   * and keeps the derivation it always had. */
  const margin = marginMinor ?? houseMarginMinor(config, wagerMinor);
  return (margin * rate) / 10_000n;
}

/**
 * Credits every rakeback tier for one wager.
 *
 * A single statement writes all four rows, because four round trips inside the settlement of
 * every case open is four times the lock contention for no benefit. The rows are created on
 * demand, so a player who has never wagered has no rakeback rows at all.
 */
export async function accrueRakeback(
  client: DbClient,
  config: AppConfig,
  userId: string,
  wagerMinor: bigint,
  marginMinor?: bigint,
): Promise<void> {
  if (!config.rakebackEnabled || wagerMinor <= 0n) return;

  const amounts = RAKEBACK_TIERS.map((tier) => rakebackMinor(config, tier, wagerMinor, marginMinor));
  if (amounts.every((amount) => amount <= 0n)) return;

  await client.query(
    `INSERT INTO rakeback_accruals (user_id, tier, accrued_minor)
     SELECT $1, tier, amount
       FROM unnest($2::text[], $3::bigint[]) AS t(tier, amount)
      WHERE amount > 0
     ON CONFLICT (user_id, tier) DO UPDATE
       SET accrued_minor = rakeback_accruals.accrued_minor + EXCLUDED.accrued_minor,
           updated_at = now()`,
    [userId, [...RAKEBACK_TIERS], amounts.map((amount) => amount.toString())],
  );
}

/**
 * Counts a wager toward every race currently running.
 *
 * Races overlap by design — a daily and a weekly run at the same time — so this updates every
 * live race rather than picking one. Entries are created on first wager inside the window.
 *
 * Silently does nothing when no race is live. A wager is not the moment to fail over a promotion:
 * refusing the round because a leaderboard could not be updated would let an optional side event
 * break the core game.
 */
export async function recordRaceWager(
  client: DbClient,
  config: AppConfig,
  userId: string,
  wagerMinor: bigint,
): Promise<void> {
  if (!config.racesEnabled || wagerMinor <= 0n) return;

  await client.query(
    `INSERT INTO wager_race_entries (race_id, user_id, wagered_minor)
     SELECT r.id, $1, $2::bigint
       FROM wager_races r
      WHERE r.settled_at IS NULL AND now() >= r.starts_at AND now() < r.ends_at
     ON CONFLICT (race_id, user_id) DO UPDATE
       SET wagered_minor = wager_race_entries.wagered_minor + EXCLUDED.wagered_minor,
           updated_at = now()`,
    [userId, wagerMinor.toString()],
  );
}

/**
 * The prize for one rank, given a pool and the race's stored curve.
 *
 * Ranks beyond the curve pay nothing, which is what makes a fifty-place leaderboard affordable
 * with a ten-place curve. Exported because the leaderboard shows a PROJECTED payout beside every
 * live entry, and that projection has to be computed by the same function that will settle it —
 * otherwise the number a player races for is not the number they are paid.
 */
export function prizeForRank(
  prizePoolMinor: bigint,
  curveBps: readonly number[],
  rank: number,
): bigint {
  const share = curveBps[rank - 1];
  if (share === undefined || share <= 0) return 0n;
  return (prizePoolMinor * BigInt(share)) / 10_000n;
}

/**
 * Validates a payout curve.
 *
 * A curve summing above 10000 bps pays out more than the pool it is drawn from, which is a
 * shortfall the ledger discovers at settlement rather than at configuration time.
 */
export function isValidCurve(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) return false;
  if (!value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 10_000)) {
    return false;
  }
  return value.reduce((sum: number, entry: number) => sum + entry, 0) <= 10_000;
}

interface RaceRow {
  id: string;
  prize_pool_minor: string;
  payout_curve: unknown;
}

/**
 * Settles one finished race: ranks the entries, pays the curve, and stamps the race.
 *
 * The race row is locked first and re-checked for settled_at, so two concurrent settlement passes
 * cannot both pay. Payout rows are unique on (race, user) and (race, rank), so even if that lock
 * were somehow lost the second pass would fail on the insert rather than double-pay.
 *
 * Returns the number of players paid.
 */
export async function settleRace(
  client: DbClient,
  config: AppConfig,
  raceId: string,
): Promise<number> {
  const locked = await client.query<RaceRow>(
    `SELECT id, prize_pool_minor, payout_curve
       FROM wager_races
      WHERE id = $1 AND settled_at IS NULL AND now() >= ends_at
      FOR UPDATE`,
    [raceId],
  );
  const race = locked.rows[0];
  if (!race) return 0;

  const curve = isValidCurve(race.payout_curve) ? race.payout_curve : [];
  const pool = BigInt(race.prize_pool_minor);

  /* Ranked by volume, ties broken by who reached that volume first. Limited to the curve's length
   * rather than to the leaderboard size: ranks past the curve are paid nothing, so reading them
   * here would be work done to multiply by zero. */
  const standings = await client.query<{ user_id: string; wagered_minor: string }>(
    `SELECT user_id, wagered_minor
       FROM wager_race_entries
      WHERE race_id = $1 AND wagered_minor > 0
      ORDER BY wagered_minor DESC, updated_at ASC
      LIMIT $2`,
    [raceId, curve.length],
  );

  let paid = 0;
  for (const [index, entry] of standings.rows.entries()) {
    const rank = index + 1;
    const amount = prizeForRank(pool, curve, rank);
    if (amount <= 0n) continue;

    await client.query(
      `INSERT INTO wager_race_payouts (id, race_id, user_id, rank, wagered_minor, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), raceId, entry.user_id, rank, entry.wagered_minor, amount.toString()],
    );
    /* The wallet ledger is unique on (kind, reference_id), so the race id is the reference and a
     * replayed settlement cannot pay the same player twice for the same race. One player can win
     * several different races, which is why the reference is the race rather than the user. */
    await creditWallet(client, entry.user_id, amount, 'race_payout', raceReference(raceId, rank));
    paid += 1;
  }

  await client.query('UPDATE wager_races SET settled_at = now() WHERE id = $1', [raceId]);
  return paid;
}

/**
 * A deterministic wallet reference for one race placing.
 *
 * The wallet ledger's uniqueness is on (kind, reference_id) and reference_id is a uuid column, so
 * the race id alone would collide across the ten players paid by one race. Mixing the rank into
 * the uuid keeps each placing distinct while staying reproducible from the race itself.
 */
function raceReference(raceId: string, rank: number): string {
  const suffix = rank.toString(16).padStart(12, '0');
  return `${raceId.slice(0, 8)}-${raceId.slice(9, 13)}-4${raceId.slice(15, 18)}-8${raceId.slice(20, 23)}-${suffix}`;
}

/** Every rakeback tier for one player, with the claimable balance and the clock on each. */
export interface RakebackTierView {
  tier: RakebackTier;
  rateBps: number;
  accruedMinor: string;
  claimedMinor: string;
  claimableMinor: string;
  cooldownMs: number;
  availableAt: string | null;
  claimable: boolean;
}

export function tierViews(
  config: AppConfig,
  rows: readonly {
    tier: string;
    accrued_minor: string;
    claimed_minor: string;
    last_claim_at: Date | null;
  }[],
  now = new Date(),
): RakebackTierView[] {
  const byTier = new Map(rows.map((row) => [row.tier, row]));
  return RAKEBACK_TIERS.map((tier) => {
    const row = byTier.get(tier);
    const accrued = BigInt(row?.accrued_minor ?? '0');
    const claimed = BigInt(row?.claimed_minor ?? '0');
    const claimable = accrued - claimed;
    const cooldown = TIER_COOLDOWN_MS[tier];
    const last = row?.last_claim_at ? new Date(row.last_claim_at).getTime() : 0;
    const readyAt = last && cooldown ? last + cooldown : 0;
    return {
      tier,
      rateBps: config.rakebackTierBps[tier],
      accruedMinor: accrued.toString(),
      claimedMinor: claimed.toString(),
      claimableMinor: claimable.toString(),
      cooldownMs: cooldown,
      availableAt: readyAt > now.getTime() ? new Date(readyAt).toISOString() : null,
      claimable: claimable > 0n && readyAt <= now.getTime(),
    };
  });
}
