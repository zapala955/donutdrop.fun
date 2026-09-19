/**
 * mystery-odds.ts — the Mystery Slot economics engine.
 *
 * One `?` sits in every crate on the platform. This module decides how often it lands, what sits
 * behind it, and how the rest of the crate has to be priced so the whole thing still returns
 * exactly 90%.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ODDS FORMULA
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A crate returns `RTP` of its price in expectation. A fixed share of that return is set aside to
 * fund the mystery slot, and the rest funds the ordinary drop table:
 *
 *     mysteryEV = price × RTP × mysteryBudgetShare
 *
 * The mystery slot pays, on average, the sub-pool's own average value. So the probability of
 * landing it is simply the budget divided by what a hit costs the house:
 *
 *     P(mystery) = mysteryEV / averageMysteryPoolValue
 *                = (price × RTP × mysteryBudgetShare) / averageMysteryPoolValue
 *
 * P scales LINEARLY with crate price, which is the property the brief's four reference points
 * describe: every tenfold increase in price is a tenfold increase in mystery frequency. A cheap
 * crate is buying a lottery ticket; a high-roller crate is buying a real chance.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE REFERENCE BENCHMARKS, AND WHY THE FLOOR MOVES THEM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The brief gives four targets at a 10% budget share:
 *
 *     $15,000 → 1 in 66,667      $100,000 → 1 in 10,000
 *     $1,000,000 → 1 in 1,000    $10,000,000 → 1 in 100
 *
 * These are perfectly self-consistent. Solving each one back through the formula gives the same
 * answer every time: they all assume an average sub-pool value of EXACTLY $90,000,000.
 *
 *     P = 0.09 × price / avg  ⟹  avg = 0.09 × 15,000 × 66,667 = $90.000M
 *                                 avg = 0.09 × 100,000 × 10,000 = $90.000M   (and so on)
 *
 * But the same brief also sets a hard $100,000,000 FLOOR under every item in the sub-pool. An
 * average cannot be below its own minimum, so the average is ≥ $100M by construction — and the
 * benchmarks assume $90M. The two requirements cannot both hold. The gap is exactly the ratio
 * 100/90, so the real odds land 11.1% rarer than the benchmarks even in the best possible case
 * where every scrap of weight sits on the cheapest payload:
 *
 *     $15,000 → 1 in 74,074 rather than 1 in 66,667      (and the same 11.1% at every tier)
 *
 * Three constraints — a 10% budget, a $100M floor, and the benchmark odds — and only two of them
 * can be true at once. This file implements the first two, because those are the ones stated as
 * rules rather than as "reference points", and because a floor is a promise to the player about
 * what the `?` can contain while the benchmarks are a tuning target.
 *
 * MYSTERY_BUDGET_SHARE_BPS is the single knob that changes the choice. Raising it re-reaches the
 * benchmark odds exactly while keeping the floor; the cost is that a larger slice of the 90% RTP
 * is paid out through the `?` and a correspondingly smaller slice through the ordinary table.
 * `budgetShareForBenchmarkOdds()` at the bottom of this file computes that figure exactly.
 */

/** Basis points of the RTP budget routed to the mystery slot. 1000 bps = 10%, per the brief. */
export const MYSTERY_BUDGET_SHARE_BPS = 1_000;

/** No item may sit behind the `?` below this value. A hard floor, in minor units. */
export const MYSTERY_VALUE_FLOOR_MINOR = 100_000_000n;

/**
 * The exponent k in Weight(I) ∝ 1 / Value(I)^k.
 *
 * k = 1 is barely a gradient: across a $100M–$1B pool it makes the top payload only ten times
 * rarer than the bottom one, which is not what "astronomical, micro-fractional" describes. k = 3
 * makes it a thousand times rarer, which lands the three bands the brief asks for — the $100M-
 * $200M pair taking the clear majority of hits, the $390M-$650M pair at fractions of a percent,
 * and the $1B vault at roughly one in seventeen hundred OF THE HITS, which compounds with the
 * mystery odds themselves into genuinely astronomical territory.
 *
 * Raising k also drags the pool average down toward the $100M floor, which pulls the odds back
 * toward the benchmarks. It is the second knob, and the trade is spread versus frequency.
 */
export const INVERSE_WEIGHT_EXPONENT = 3;

/** Denominator used to express probabilities as integers. Parts per billion. */
const PPB = 1_000_000_000;

export interface MysteryOdds {
  /** Probability of the mystery slot landing, as a float in (0, 1). */
  readonly probability: number;
  /** The same probability as "1 in N", rounded. */
  readonly oddsDenominator: number;
  /** The same probability in parts per billion, as an integer. */
  readonly probabilityPpb: number;
  /** Expected value the mystery slot contributes per open, in minor units. */
  readonly mysteryEvMinor: number;
  /** Expected value the ordinary drop table must contribute per open, in minor units. */
  readonly ordinaryEvMinor: number;
  /**
   * What the ordinary table must AVERAGE, given it only pays on the (1 - P) of rolls that miss
   * the mystery slot. Higher than ordinaryEvMinor, and the difference matters at high tiers where
   * P is percentage points rather than millionths.
   */
  readonly ordinaryTargetMinor: number;
}

/**
 * The core calculator.
 *
 * @param cratePrice              the crate's price, in minor units
 * @param mysteryBudgetRtp        share of the crate PRICE routed to the mystery slot, as a
 *                                fraction — i.e. rtp × budgetShare, already multiplied out
 * @param averageScaledMysteryPoolValue the probability-weighted mean of the crate's OWN scaled
 *                                      sub-pool, in minor units. Scaled, because the pool a crate
 *                                      draws from depends on its price: see mysteryFloorFor().
 *
 * Every argument is validated rather than trusted. This function decides how much money leaves
 * the house, and a NaN or a zero reaching it silently produces a crate that pays out forever.
 */
export function calculateMysteryOdds(
  cratePrice: number,
  mysteryBudgetRtp: number,
  averageScaledMysteryPoolValue: number,
): MysteryOdds {
  if (!Number.isFinite(cratePrice) || cratePrice <= 0) {
    throw new RangeError(`cratePrice must be a positive finite number, received ${cratePrice}`);
  }
  if (!Number.isFinite(mysteryBudgetRtp) || mysteryBudgetRtp <= 0 || mysteryBudgetRtp >= 1) {
    throw new RangeError(
      `mysteryBudgetRtp must be a fraction in (0, 1), received ${mysteryBudgetRtp}`,
    );
  }
  if (!Number.isFinite(averageScaledMysteryPoolValue) || averageScaledMysteryPoolValue <= 0) {
    throw new RangeError(
      'averageScaledMysteryPoolValue must be a positive finite number, received '
        + String(averageScaledMysteryPoolValue),
    );
  }

  const mysteryEvMinor = cratePrice * mysteryBudgetRtp;
  const probability = mysteryEvMinor / averageScaledMysteryPoolValue;

  /* A mystery slot that lands more often than never is the whole point, but one that lands on
   * more than half of opens is not a mystery slot — it is the drop table, and the ordinary pool
   * would have to pay a negative amount to compensate. That can only happen if a caller asks for
   * a crate priced above half the pool average divided by the budget share, which is a
   * configuration error rather than a crate. */
  if (probability >= 0.5) {
    throw new RangeError(
      `mystery probability ${probability.toFixed(4)} is not viable: a crate priced at ` +
        `${cratePrice} against a ${averageScaledMysteryPoolValue} pool average would land the slot on ` +
        'more than half of all opens',
    );
  }

  const ordinaryEvMinor = cratePrice * (RTP_FRACTION - mysteryBudgetRtp);

  return {
    probability,
    oddsDenominator: Math.round(1 / probability),
    probabilityPpb: Math.round(probability * PPB),
    mysteryEvMinor,
    ordinaryEvMinor,
    /* The ordinary table only pays on the rolls that MISS the mystery slot, so to contribute
     * ordinaryEvMinor across all opens it has to average more than that across its own share. At
     * one in ninety thousand the correction is invisible; at one in eight it is 14%. */
    ordinaryTargetMinor: ordinaryEvMinor / (1 - probability),
  };
}

/** The platform's fixed return to player. 90%, so the house edge is exactly 10%. */
export const RTP_FRACTION = 0.9;

/** Convenience: the crate-price fraction routed to the mystery slot at the configured share. */
export const mysteryBudgetFraction = (): number =>
  RTP_FRACTION * (MYSTERY_BUDGET_SHARE_BPS / 10_000);

/**
 * Inverse-value weights for a sub-pool: Weight(I) ∝ 1 / Value(I)^k.
 *
 * Returned as normalised probabilities rather than raw weights, because raw inverse powers of a
 * billion underflow to zero in double precision and the caller only ever needs the ratios. The
 * values are divided by the pool's own minimum first, so the arithmetic happens on numbers near 1
 * instead of near 1e-27.
 */
export function inverseValueProbabilities(
  values: readonly number[],
  exponent: number = INVERSE_WEIGHT_EXPONENT,
): number[] {
  if (values.length === 0) throw new RangeError('mystery sub-pool cannot be empty');
  if (!Number.isFinite(exponent) || exponent <= 0) {
    throw new RangeError(`exponent must be a positive finite number, received ${exponent}`);
  }
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`sub-pool values must be positive and finite, received ${value}`);
    }
  }

  const smallest = values.reduce((least, value) => Math.min(least, value), Infinity);
  const raw = values.map((value) => (smallest / value) ** exponent);
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) throw new RangeError('inverse weighting produced a zero-weight sub-pool');
  return raw.map((weight) => weight / total);
}

/** The probability-weighted mean of a sub-pool. This is what feeds calculateMysteryOdds. */
export function averagePoolValue(
  values: readonly number[],
  probabilities: readonly number[],
): number {
  if (values.length !== probabilities.length) {
    throw new RangeError('values and probabilities must be the same length');
  }
  let mean = 0;
  for (let index = 0; index < values.length; index += 1) {
    mean += (values[index] ?? 0) * (probabilities[index] ?? 0);
  }
  return mean;
}

/**
 * Refuses a sub-pool that breaks the floor.
 *
 * Separate from the weighting so the floor is checked as its own named rule rather than as a side
 * effect of building weights. A cheap filler slipping into the `?` is the single failure that
 * would make the whole feature a lie: the reveal promises a hundred-million-dollar payload, and
 * one $4,000 Slime Ball in the pool turns that promise into a coin flip nobody was told about.
 */
export function assertSubPoolFloor(
  values: readonly number[],
  floorMinor: bigint = MYSTERY_VALUE_FLOOR_MINOR,
): void {
  const floor = Number(floorMinor);
  for (const value of values) {
    if (!(value >= floor)) {
      throw new RangeError(
        `mystery sub-pool item valued ${value} is below the ${floor} floor; the ? may not ` +
          'contain low-tier fillers',
      );
    }
  }
}

/**
 * The brief's four reference points, kept as data so a test can assert against them directly
 * rather than restating them in prose.
 */
export const REFERENCE_BENCHMARKS: readonly {
  readonly priceMinor: number;
  readonly oddsDenominator: number;
}[] = [
  { priceMinor: 15_000, oddsDenominator: 66_667 },
  { priceMinor: 100_000, oddsDenominator: 10_000 },
  { priceMinor: 1_000_000, oddsDenominator: 1_000 },
  { priceMinor: 10_000_000, oddsDenominator: 100 },
];

/**
 * The average sub-pool value the four benchmarks imply, at the brief's stated 10% budget share.
 *
 * Solving any one of them gives $90,000,000, and solving all four gives the same figure — which
 * is what makes them a coherent specification rather than four loose numbers. It is also what
 * makes them incompatible with the $100M floor.
 */
export const BENCHMARK_IMPLIED_POOL_AVERAGE = 90_000_000;

/**
 * The budget share, in basis points, that would reproduce the benchmark odds EXACTLY for a
 * sub-pool with the given average — i.e. the answer to "what would we have to change to get the
 * numbers in the brief, without weakening the $100M floor?".
 *
 * At a $126M pool average this returns roughly 1400 bps: 14% of the RTP through the `?` instead
 * of 10%, with the ordinary table funded from 86% instead of 90%.
 */
export function budgetShareForBenchmarkOdds(averageMysteryPoolValue: number): number {
  if (!Number.isFinite(averageMysteryPoolValue) || averageMysteryPoolValue <= 0) {
    throw new RangeError('averageMysteryPoolValue must be a positive finite number');
  }
  // Benchmarks are P = price / 1e9. Setting that equal to price × RTP × share / avg and solving:
  const share = averageMysteryPoolValue / (PPB * RTP_FRACTION);
  return Math.round(share * 10_000);
}

/**
 * Splits a crate's total weight into an integer mystery weight and an integer ordinary weight
 * that together express the target probability as closely as the integer column allows.
 *
 * case_items.weight is `integer NOT NULL CHECK (weight BETWEEN 1 AND 1000000000)` and the round
 * tables sum it, so the total is held inside a 32-bit range. The total is chosen as the smallest
 * value that gives the mystery slot at least `minMysteryWeight` — enough granularity to split it
 * across the sub-pool without any payload rounding away to zero.
 */
export function resolveWeightSplit(
  probability: number,
  minMysteryWeight: number,
  maxTotalWeight: number,
): { mysteryWeight: number; ordinaryWeight: number; totalWeight: number; achieved: number } {
  if (!(probability > 0) || probability >= 1) {
    throw new RangeError(`probability must be in (0, 1), received ${probability}`);
  }
  const wanted = Math.ceil(minMysteryWeight / probability);
  const totalWeight = Math.min(maxTotalWeight, Math.max(wanted, minMysteryWeight + 1));
  const mysteryWeight = Math.max(1, Math.round(probability * totalWeight));
  const ordinaryWeight = totalWeight - mysteryWeight;
  if (ordinaryWeight < 1) {
    throw new RangeError('weight split left no room for the ordinary drop table');
  }
  return {
    mysteryWeight,
    ordinaryWeight,
    totalWeight,
    achieved: mysteryWeight / totalWeight,
  };
}

/**
 * Apportions an integer total across a set of probabilities, largest-remainder style.
 *
 * The sub-pool's shape is a set of real-valued probabilities, but case_items.weight is an integer
 * column and the parts have to add up to the whole exactly — a mystery slot whose payload weights
 * sum to one less than its own weight is a crate that can roll a number matching no outcome.
 *
 * Rounding each share independently does not do this: seven shares each rounded to nearest can
 * sum to anything within ±3 of the total. Largest remainder floors every share, then hands the
 * leftover units out to whichever shares were cut hardest, which lands on the total by
 * construction and keeps the distribution as close to the intended one as integers allow.
 *
 * Every payload is guaranteed at least one unit of weight: a published outcome that can never be
 * drawn is a lie on the label, and the `?` publishes its contents.
 */
export function apportion(total: number, probabilities: readonly number[]): number[] {
  const count = probabilities.length;
  if (count === 0) throw new RangeError('cannot apportion across an empty set');
  if (!Number.isInteger(total) || total < count) {
    throw new RangeError(
      `total ${total} must be a whole number at least as large as the ${count} shares it covers`,
    );
  }

  /* Each share gets one unit up front, and the remainder is apportioned over what is left. This
   * is what makes the "never zero" guarantee structural rather than a clamp applied afterwards —
   * clamping to 1 after the fact would break the sum. */
  const remaining = total - count;
  const exact = probabilities.map((probability) => probability * remaining);
  const floors = exact.map((share) => Math.floor(share));
  let handedOut = floors.reduce((sum, share) => sum + share, 0);

  const order = exact
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort((left, right) => right.remainder - left.remainder);

  let cursor = 0;
  while (handedOut < remaining) {
    const slot = order[cursor % order.length];
    if (!slot) break;
    floors[slot.index] = (floors[slot.index] ?? 0) + 1;
    handedOut += 1;
    cursor += 1;
  }

  const weights = floors.map((share) => share + 1);
  const summed = weights.reduce((sum, weight) => sum + weight, 0);
  if (summed !== total) {
    throw new Error(`apportionment summed to ${summed}, not ${total}`);
  }
  return weights;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   THE DYNAMIC SCALED FLOOR
   ═══════════════════════════════════════════════════════════════════════════════════════════════
   A fixed $100,000,000 floor is the right promise for a 5,000 crate, where it is twenty thousand
   times the price. It is a broken promise for a 150,000,000 one, where it is two thirds of the
   price — landing the rarest outcome in the game and getting back less than you paid is worse
   than not having the slot at all.

   So the floor scales with the crate. Three rules, in order of precedence:

     1. every payload must be at least MIN_JACKPOT_MULTIPLE times the crate price, so a mystery
        hit is always an extraordinary win and never a breakeven;
     2. crates above HIGH_ROLLER_THRESHOLD carry a hard minimum of HIGH_ROLLER_FLOOR_MINOR;
     3. everything else carries BASELINE_FLOOR_MINOR.

   The strongest rule wins, which on the ladder produces:

     5,000 - 15,000,000  ->  $100M floor   (20,000x down to 6.7x)
        50,000,000       ->  $125M floor   (2.5x)
       150,000,000       ->  $375M floor   (2.5x)

   and reproduces the brief's worked examples exactly: a $100M crate floors at $250M, a $200M
   crate at $500M, a $52M crate at $130M.                                                      */

/** Below this price a crate uses the baseline floor. */
export const HIGH_ROLLER_THRESHOLD_MINOR = 50_000_000;

/** The floor for ordinary crates. */
export const BASELINE_FLOOR_MINOR = 100_000_000;

/** The hard minimum for crates above the threshold. */
export const HIGH_ROLLER_FLOOR_MINOR = 130_000_000;

/**
 * The smallest multiple of the crate price a mystery payload may be worth.
 *
 * This is the rule that makes the `?` mean something. At 2.5 the worst possible mystery outcome
 * still returns two and a half times the stake, so there is no such thing as a disappointing
 * mystery hit — only a good one and a spectacular one.
 */
export const MIN_JACKPOT_MULTIPLE = 2.5;

/**
 * How far above its own floor a sub-pool may reach.
 *
 * Not cosmetic — it is what keeps the pool representable. Inverse-cube weighting over a 30x span
 * makes the top payload roughly one in forty-seven thousand OF THE HITS, and at a 5,000 crate's
 * one-in-280,000 landing odds that compounds into a total weight of thirteen billion, which no
 * longer fits the integer weight column. Capping the span at one order of magnitude keeps the
 * rarest payload near one in seventeen hundred of the hits: still a rumour, still drawable, and
 * still expressible in an integer.
 */
export const POOL_SPAN_MULTIPLE = 10;

/**
 * The mystery floor for a crate at this price, in minor units.
 *
 * @param cratePrice the crate's price, in minor units
 */
export function mysteryFloorFor(cratePrice: number): number {
  if (!Number.isFinite(cratePrice) || cratePrice <= 0) {
    throw new RangeError(`cratePrice must be a positive finite number, received ${cratePrice}`);
  }
  const baseline = cratePrice > HIGH_ROLLER_THRESHOLD_MINOR
    ? HIGH_ROLLER_FLOOR_MINOR
    : BASELINE_FLOOR_MINOR;
  return Math.max(baseline, Math.ceil(cratePrice * MIN_JACKPOT_MULTIPLE));
}

export interface ScaledSubPool<T> {
  /** The payloads this crate's `?` can actually contain. */
  readonly payloads: readonly T[];
  /** Their values, in the same order. */
  readonly values: readonly number[];
  /** Their probabilities GIVEN the slot landed, inverse-weighted by value. */
  readonly probabilities: readonly number[];
  /** The probability-weighted mean value — the figure the odds calculator consumes. */
  readonly averageValue: number;
  /** The floor this pool was built against. */
  readonly floorMinor: number;
  /** The worst payload as a multiple of the crate price. Never below MIN_JACKPOT_MULTIPLE. */
  readonly worstMultiple: number;
}

/**
 * Builds the sub-pool for one crate: everything at or above its floor, capped at one order of
 * magnitude above it, inverse-weighted by value.
 *
 * Throws rather than returning an empty or breakeven pool. A crate whose `?` cannot be filled is
 * a crate that must not be published — silently shipping one with a thin or low-value pool is how
 * the slot stops being a jackpot without anybody noticing.
 */
export function buildScaledSubPool<T>(
  candidates: readonly T[],
  valueOf: (item: T) => number,
  cratePrice: number,
  exponent: number = INVERSE_WEIGHT_EXPONENT,
  /**
   * A floor the caller requires on top of the price-derived one.
   *
   * The price-derived floor cannot see the crate it is being built for. A caller that already
   * knows the dearest ordinary outcome passes it here, so the `?` can never reveal something
   * worth less than a drop the player can read off the reel. Raising the floor makes the pool
   * richer, which calculateMysteryOdds then pays for by landing it less often.
   */
  minimumFloorMinor = 0,
): ScaledSubPool<T> {
  const floorMinor = Math.max(mysteryFloorFor(cratePrice), Math.ceil(minimumFloorMinor));
  const ceiling = floorMinor * POOL_SPAN_MULTIPLE;

  const payloads = candidates
    .filter((item) => valueOf(item) >= floorMinor && valueOf(item) <= ceiling)
    .sort((left, right) => valueOf(left) - valueOf(right));

  if (payloads.length === 0) {
    throw new RangeError(
      `no mystery payload sits between the ${floorMinor} floor and the ${ceiling} ceiling for a ` +
        `crate priced at ${cratePrice}; the sub-pool would be empty`,
    );
  }

  const values = payloads.map(valueOf);
  assertSubPoolFloor(values, BigInt(Math.round(floorMinor)));

  const probabilities = inverseValueProbabilities(values, exponent);
  const averageValue = averagePoolValue(values, probabilities);

  const worstMultiple = Math.min(...values) / cratePrice;
  if (worstMultiple < MIN_JACKPOT_MULTIPLE - 1e-9) {
    throw new RangeError(
      `mystery sub-pool for a crate at ${cratePrice} contains a payload worth only ` +
        `${worstMultiple.toFixed(2)}x the price; the floor guarantees at least ` +
        `${MIN_JACKPOT_MULTIPLE}x`,
    );
  }

  return { payloads, values, probabilities, averageValue, floorMinor, worstMultiple };
}
