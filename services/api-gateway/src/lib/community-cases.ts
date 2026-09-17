/**
 * community-cases.ts — the economics of a player-authored crate.
 *
 * Pure functions. The studio runs exactly these calculations in the browser so the price updates
 * as a slider moves, and the server runs them again on submit — the client copy is a preview, and
 * the server copy is the one that decides what anything costs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PRICE IS DERIVED, NEVER TYPED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A creator chooses the contents and the weights. They do NOT choose the price:
 *
 *     price = ceil(EV / 0.90)
 *
 * which fixes the return to the player at 90% whatever distribution they build. This is the whole
 * safety property of the feature. If a creator could set the price, the obvious exploit writes
 * itself: publish a crate whose contents are worth more than it costs, open it yourself a
 * thousand times, and the platform funds the difference. Deriving the price removes the exploit
 * rather than policing it.
 *
 * Rounding goes UP, always. Rounding to nearest would let a carefully tuned pool land a fraction
 * of a unit in the player's favour on every open, and a fraction of a unit multiplied by a
 * million opens is a real amount of money.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THE ROYALTY COMES FROM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Out of the house's margin, not off the top of the price.
 *
 * The brief asks for both "a guaranteed 10% house edge" and "a creator royalty of 1.5-2% of the
 * crate price". Those cannot both be additions to the price: charging the player for the royalty
 * would push the crate's real return below the 90% printed on it, and the platform advertises
 * that 90% on every crate on the site. So the royalty is carved from the ten points the house
 * already takes:
 *
 *     player return   90.0%   (identical to a first-party crate)
 *     creator royalty  2.0%   (of price, paid on every open)
 *     platform net      8.0%
 *
 * The alternative — price = EV / (0.90 - royalty) — keeps the platform on ten points by taking
 * the royalty out of the player instead, and produces a community crate that quietly returns 88%
 * where the label says 90%. That is the one thing this codebase will not do.
 */

/** The platform-wide return to player. Community crates are held to the same figure. */
export const RTP_FRACTION = 0.9;

/** Bounds on what a creator may set. The upper bound is a fifth of the house's own margin. */
export const MIN_ROYALTY_BPS = 0;
export const MAX_ROYALTY_BPS = 200;
export const DEFAULT_ROYALTY_BPS = 150;

/** A crate needs enough outcomes to be a distribution rather than a coin flip. */
export const MIN_COMMUNITY_DROPS = 3;
export const MAX_COMMUNITY_DROPS = 12;

/** Weight bounds, matching the integer column the weights are stored in. */
export const MIN_DROP_WEIGHT = 1;
export const MAX_DROP_WEIGHT = 1_000_000;

/** Guard rails on the derived price, so a crate cannot be unsellably cheap or absurd. */
export const MIN_COMMUNITY_PRICE_MINOR = 1_000n;
export const MAX_COMMUNITY_PRICE_MINOR = 500_000_000n;

export interface DraftDrop {
  readonly catalogItemId: string;
  readonly valueMinor: bigint;
  readonly weight: number;
}

export interface CrateEconomics {
  /** Expected value of one open, in minor units, rounded down. */
  readonly expectedValueMinor: bigint;
  /** The derived selling price. */
  readonly priceMinor: bigint;
  /** Realised return to player at the derived price, in basis points. At or just under 9000. */
  readonly rtpBps: number;
  /** The house's gross margin in basis points, before the royalty. */
  readonly houseEdgeBps: number;
  /** What the creator earns per open, in minor units. */
  readonly royaltyPerOpenMinor: bigint;
  /** What the platform keeps per open after the royalty. */
  readonly platformNetPerOpenMinor: bigint;
  /** Total weight across the pool. */
  readonly totalWeight: bigint;
  /** Each drop's chance, in parts per million, in the order supplied. */
  readonly chancesPpm: readonly number[];
  /** Coefficient of variation of the payout, as a 0-100 volatility score. */
  readonly riskPercent: number;
  readonly riskLabel: string;
  /** The best outcome as a multiple of price, for the card. */
  readonly topMultiple: number;
}

/**
 * Values every drop and derives the price.
 *
 * All money is BigInt. The expected value of a weighted pool is a ratio of two large integers and
 * these values reach ten figures; a double would stop representing them exactly somewhere around
 * a crate containing a billion-unit item, and the price it derived would be wrong in the
 * platform's disfavour at exactly the values where that matters most.
 */
export function computeCrateEconomics(
  drops: readonly DraftDrop[],
  royaltyBps: number,
): CrateEconomics {
  if (drops.length < MIN_COMMUNITY_DROPS || drops.length > MAX_COMMUNITY_DROPS) {
    throw new RangeError(
      `a crate needs between ${MIN_COMMUNITY_DROPS} and ${MAX_COMMUNITY_DROPS} outcomes, got ${drops.length}`,
    );
  }
  if (!Number.isInteger(royaltyBps) || royaltyBps < MIN_ROYALTY_BPS || royaltyBps > MAX_ROYALTY_BPS) {
    throw new RangeError(`royaltyBps must be an integer between ${MIN_ROYALTY_BPS} and ${MAX_ROYALTY_BPS}`);
  }

  let totalWeight = 0n;
  let weightedValue = 0n;
  for (const drop of drops) {
    if (!Number.isInteger(drop.weight) || drop.weight < MIN_DROP_WEIGHT || drop.weight > MAX_DROP_WEIGHT) {
      throw new RangeError(
        `every weight must be an integer between ${MIN_DROP_WEIGHT} and ${MAX_DROP_WEIGHT}`,
      );
    }
    if (drop.valueMinor <= 0n) throw new RangeError('every outcome must have a positive value');
    totalWeight += BigInt(drop.weight);
    weightedValue += BigInt(drop.weight) * drop.valueMinor;
  }
  if (totalWeight <= 0n) throw new RangeError('total weight must be positive');

  // EV = sum(weight * value) / totalWeight, floored.
  const expectedValueMinor = weightedValue / totalWeight;
  if (expectedValueMinor <= 0n) throw new RangeError('a crate cannot have an expected value of zero');

  /* price = ceil(EV / 0.9) = ceil(EV * 10 / 9), done in integers so no rounding slips in.
   * Rounding up rather than to nearest: a half-unit in the player's favour, on every open of a
   * popular crate, is a real subsidy. */
  const priceMinor = (expectedValueMinor * 10n + 8n) / 9n;

  if (priceMinor < MIN_COMMUNITY_PRICE_MINOR) {
    throw new RangeError(
      `the derived price ${priceMinor} is below the ${MIN_COMMUNITY_PRICE_MINOR} minimum; use more valuable outcomes`,
    );
  }
  if (priceMinor > MAX_COMMUNITY_PRICE_MINOR) {
    throw new RangeError(
      `the derived price ${priceMinor} is above the ${MAX_COMMUNITY_PRICE_MINOR} maximum; use less valuable outcomes`,
    );
  }

  const rtpBps = Number((expectedValueMinor * 10_000n) / priceMinor);
  const houseEdgeBps = 10_000 - rtpBps;
  const royaltyPerOpenMinor = (priceMinor * BigInt(royaltyBps)) / 10_000n;
  const platformNetPerOpenMinor = priceMinor - expectedValueMinor - royaltyPerOpenMinor;

  /* The royalty is carved from the house's margin, so it can never exceed it. The bounds above
   * already guarantee this (200 bps against roughly 1000), but the invariant is asserted rather
   * than assumed: it is the line between "the creator is paid from our cut" and "the creator is
   * paid by us", and a future change to either bound must fail loudly here. */
  if (platformNetPerOpenMinor < 0n) {
    throw new RangeError('the royalty exceeds the house margin on this crate');
  }

  const chancesPpm = drops.map((drop) =>
    Number((BigInt(drop.weight) * 1_000_000n) / totalWeight));

  // Volatility, measured on the real distribution, in floating point because it is a display
  // figure rather than a money figure.
  const mean = Number(expectedValueMinor);
  let variance = 0;
  for (const drop of drops) {
    const share = drop.weight / Number(totalWeight);
    variance += share * (Number(drop.valueMinor) - mean) ** 2;
  }
  const deviation = Math.sqrt(variance);
  const coefficient = mean > 0 ? deviation / mean : 0;
  const riskPercent = Math.min(99, Math.max(5, Math.round((coefficient / (coefficient + 1.6)) * 100)));

  const best = drops.reduce((most, drop) => (drop.valueMinor > most ? drop.valueMinor : most), 0n);
  const topMultiple = Number((best * 100n) / priceMinor) / 100;

  return {
    expectedValueMinor,
    priceMinor,
    rtpBps,
    houseEdgeBps,
    royaltyPerOpenMinor,
    platformNetPerOpenMinor,
    totalWeight,
    chancesPpm,
    riskPercent,
    riskLabel: riskLabelFor(riskPercent),
    topMultiple,
  };
}

export function riskLabelFor(percent: number): string {
  if (percent < 25) return 'Low Risk / High Odds';
  if (percent < 45) return 'Steady';
  if (percent < 65) return 'Swingy';
  if (percent < 82) return 'High Volatility';
  return 'High Volatility Jackpot';
}

/**
 * Converts a crate name into a slug that cannot collide with a first-party one.
 *
 * Community slugs are prefixed, so a creator cannot publish "dirt-block" and take over the URL of
 * a platform crate — or, worse, have a battle's stored `case_id` resolve to something other than
 * what the host chose.
 */
export function communitySlug(name: string, discriminator: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const safe = base.length >= 2 ? base : 'crate';
  return `c-${safe}-${discriminator.toLowerCase()}`;
}

/** The marketplace's sort orders, as data. The SQL fragment for each is chosen from this map. */
export const MARKETPLACE_SORTS = {
  opened: 'opens_count DESC',
  volume: 'volume_minor DESC',
  newest: 'created_at DESC',
  yield: 'royalties_paid_minor DESC',
} as const;

export type MarketplaceSort = keyof typeof MARKETPLACE_SORTS;

export function isMarketplaceSort(value: unknown): value is MarketplaceSort {
  return typeof value === 'string' && Object.hasOwn(MARKETPLACE_SORTS, value);
}
