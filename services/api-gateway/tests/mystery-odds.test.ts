import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASELINE_FLOOR_MINOR,
  BENCHMARK_IMPLIED_POOL_AVERAGE,
  HIGH_ROLLER_FLOOR_MINOR,
  HIGH_ROLLER_THRESHOLD_MINOR,
  INVERSE_WEIGHT_EXPONENT,
  MIN_JACKPOT_MULTIPLE,
  POOL_SPAN_MULTIPLE,
  buildScaledSubPool,
  mysteryFloorFor,
  MYSTERY_BUDGET_SHARE_BPS,
  MYSTERY_VALUE_FLOOR_MINOR,
  REFERENCE_BENCHMARKS,
  RTP_FRACTION,
  assertSubPoolFloor,
  averagePoolValue,
  budgetShareForBenchmarkOdds,
  calculateMysteryOdds,
  inverseValueProbabilities,
  mysteryBudgetFraction,
  resolveWeightSplit,
} from '../src/lib/mystery-odds.js';

/* The real sub-pool, mirrored here so the tests exercise the shipped shape rather than a toy. */
const SUB_POOL = [100_000_000, 130_000_000, 175_000_000, 250_000_000, 390_000_000, 650_000_000,
  1_000_000_000];

void describe('mystery odds formula', () => {
  void it('reproduces every published benchmark exactly at the implied $90M pool average', () => {
    /* The brief's four reference points. Each is stated at a 10% budget share, and each is
     * reproduced to the nearest whole denominator — which is the proof that the formula shipped
     * here is the formula the brief describes, not merely one that behaves similarly. */
    for (const benchmark of REFERENCE_BENCHMARKS) {
      const odds = calculateMysteryOdds(
        benchmark.priceMinor,
        RTP_FRACTION * 0.1,
        BENCHMARK_IMPLIED_POOL_AVERAGE,
      );
      assert.equal(
        odds.oddsDenominator,
        benchmark.oddsDenominator,
        `crate at ${benchmark.priceMinor} should be 1 in ${benchmark.oddsDenominator}`,
      );
    }
  });

  void it('derives the same $90M pool average from all four benchmarks independently', () => {
    /* If the benchmarks disagreed with each other this would catch it: four different prices and
     * four different odds must all invert to one pool average, or the specification is not
     * self-consistent and no single formula can satisfy it. */
    for (const benchmark of REFERENCE_BENCHMARKS) {
      const implied = benchmark.priceMinor * RTP_FRACTION * 0.1 * benchmark.oddsDenominator;
      assert.ok(
        Math.abs(implied - BENCHMARK_IMPLIED_POOL_AVERAGE) / BENCHMARK_IMPLIED_POOL_AVERAGE < 0.0001,
        `benchmark at ${benchmark.priceMinor} implies ${implied}, not ${BENCHMARK_IMPLIED_POOL_AVERAGE}`,
      );
    }
  });

  void it('scales the probability linearly with crate price', () => {
    /* The defining property: ten times the price is ten times the mystery frequency. This is what
     * makes a high-roller crate meaningfully different from a cheap one rather than just bigger. */
    const cheap = calculateMysteryOdds(15_000, mysteryBudgetFraction(), 126_000_000);
    const rich = calculateMysteryOdds(150_000, mysteryBudgetFraction(), 126_000_000);
    assert.ok(Math.abs(rich.probability / cheap.probability - 10) < 1e-9);
  });

  void it('routes exactly the configured share of the RTP through the slot', () => {
    const price = 1_000_000;
    const odds = calculateMysteryOdds(price, mysteryBudgetFraction(), 126_000_000);
    // Mystery EV plus ordinary EV must be the whole 90%, to the cent.
    assert.ok(Math.abs(odds.mysteryEvMinor + odds.ordinaryEvMinor - price * RTP_FRACTION) < 1e-6);
    // And the mystery half must be exactly the configured slice of it.
    const share = odds.mysteryEvMinor / (price * RTP_FRACTION);
    assert.ok(Math.abs(share - MYSTERY_BUDGET_SHARE_BPS / 10_000) < 1e-12);
  });

  void it('lifts the ordinary target to account for the rolls the slot consumes', () => {
    /* The ordinary table only pays on the (1 - P) of rolls that miss. At one in ninety thousand
     * that correction is invisible; at one in eight it is the difference between a 90% crate and
     * an 79% one. */
    const rare = calculateMysteryOdds(15_000, mysteryBudgetFraction(), 126_000_000);
    assert.ok(rare.ordinaryTargetMinor / rare.ordinaryEvMinor - 1 < 0.0001);

    const frequent = calculateMysteryOdds(150_000_000, mysteryBudgetFraction(), 126_000_000);
    assert.ok(frequent.probability > 0.05);
    assert.ok(frequent.ordinaryTargetMinor > frequent.ordinaryEvMinor);
    const restored = frequent.ordinaryTargetMinor * (1 - frequent.probability);
    assert.ok(Math.abs(restored - frequent.ordinaryEvMinor) < 1e-6);
  });

  void it('refuses inputs that would quietly produce a crate paying out forever', () => {
    assert.throws(() => calculateMysteryOdds(0, 0.09, 1e8), RangeError);
    assert.throws(() => calculateMysteryOdds(-1, 0.09, 1e8), RangeError);
    assert.throws(() => calculateMysteryOdds(Number.NaN, 0.09, 1e8), RangeError);
    assert.throws(() => calculateMysteryOdds(1000, 0, 1e8), RangeError);
    assert.throws(() => calculateMysteryOdds(1000, 1, 1e8), RangeError);
    assert.throws(() => calculateMysteryOdds(1000, 0.09, 0), RangeError);
    assert.throws(() => calculateMysteryOdds(1000, 0.09, Number.NaN), RangeError);
  });

  void it('refuses a crate whose slot would land on more than half of all opens', () => {
    // A crate priced far above the pool average cannot fund its own mystery slot.
    assert.throws(() => calculateMysteryOdds(10_000_000_000, 0.09, 100_000_000), RangeError);
  });
});

void describe('inverse-value weighting inside the sub-pool', () => {
  void it('makes probability fall as value rises, strictly', () => {
    const probabilities = inverseValueProbabilities(SUB_POOL);
    for (let index = 1; index < probabilities.length; index += 1) {
      assert.ok(
        (probabilities[index] ?? 0) < (probabilities[index - 1] ?? 0),
        `payload ${index} must be rarer than payload ${index - 1}`,
      );
    }
  });

  void it('normalises to exactly one', () => {
    const total = inverseValueProbabilities(SUB_POOL).reduce((sum, p) => sum + p, 0);
    assert.ok(Math.abs(total - 1) < 1e-12);
  });

  void it('lands the three bands the brief describes', () => {
    const probabilities = inverseValueProbabilities(SUB_POOL, INVERSE_WEIGHT_EXPONENT);
    const band = (low: number, high: number) => SUB_POOL.reduce(
      (sum, value, index) => (value >= low && value <= high ? sum + (probabilities[index] ?? 0) : sum),
      0,
    );

    // "$100M – $200M Drops: Higher relative draw probability."
    const common = band(100_000_000, 200_000_000);
    assert.ok(common > 0.5, `$100M-$200M band should dominate, got ${common}`);

    // "$390M Elytra / $500M+ Drops: Rare, low-fractional draw probability."
    const rare = band(390_000_000, 999_999_999);
    assert.ok(rare < 0.05 && rare > 0, `$390M-$999M band should be low-fractional, got ${rare}`);

    // "$1B+ Legendary Cash Vaults: Astronomical, micro-fractional draw probability."
    const legendary = band(1_000_000_000, Number.MAX_SAFE_INTEGER);
    assert.ok(legendary < 0.001, `$1B+ band should be micro-fractional, got ${legendary}`);
  });

  void it('keeps the pool average above the floor, which is what moves the odds', () => {
    const probabilities = inverseValueProbabilities(SUB_POOL);
    const average = averagePoolValue(SUB_POOL, probabilities);
    assert.ok(average >= Number(MYSTERY_VALUE_FLOOR_MINOR));
    // And therefore strictly worse than the benchmarks' implied $90M, by construction.
    assert.ok(average > BENCHMARK_IMPLIED_POOL_AVERAGE);
  });

  void it('refuses an empty pool, a non-positive value, or a non-positive exponent', () => {
    assert.throws(() => inverseValueProbabilities([]), RangeError);
    assert.throws(() => inverseValueProbabilities([100_000_000, 0]), RangeError);
    assert.throws(() => inverseValueProbabilities([100_000_000], 0), RangeError);
    assert.throws(() => inverseValueProbabilities([100_000_000], Number.NaN), RangeError);
  });
});

void describe('the $100M sub-pool floor', () => {
  void it('accepts a pool that respects it', () => {
    assert.doesNotThrow(() => assertSubPoolFloor(SUB_POOL));
  });

  void it('refuses any low-tier filler, however small the slice', () => {
    assert.throws(() => assertSubPoolFloor([...SUB_POOL, 4_000]), RangeError);
    assert.throws(() => assertSubPoolFloor([99_999_999]), RangeError);
  });

  void it('accepts a value sitting exactly on the floor', () => {
    assert.doesNotThrow(() => assertSubPoolFloor([Number(MYSTERY_VALUE_FLOOR_MINOR)]));
  });
});

void describe('the benchmark / floor conflict, stated numerically', () => {
  void it('shows the floor alone costs exactly the 100/90 ratio', () => {
    /* The best case under the floor is every scrap of weight on the cheapest payload, giving an
     * average of exactly $100M. Even then the odds are 100/90 rarer than the benchmark — and that
     * ratio is identical at every tier, which is what proves the gap is the floor and not some
     * artefact of one crate's pricing. */
    for (const benchmark of REFERENCE_BENCHMARKS) {
      const best = calculateMysteryOdds(
        benchmark.priceMinor,
        RTP_FRACTION * 0.1,
        Number(MYSTERY_VALUE_FLOOR_MINOR),
      );
      /* Compared on the raw probability, not the rounded "1 in N". At the $10M tier the
       * denominator is 100, so rounding 111.11 to 111 alone moves the ratio by a tenth of a
       * percent and would mask or fake a real drift. */
      const ratio = 1 / best.probability / benchmark.oddsDenominator;
      assert.ok(
        Math.abs(ratio - 100 / 90) < 0.001,
        `expected the floor to cost 100/90, got ${ratio} at ${benchmark.priceMinor}`,
      );
    }
  });

  void it('computes the budget share that would restore the benchmarks exactly', () => {
    const probabilities = inverseValueProbabilities(SUB_POOL);
    const average = averagePoolValue(SUB_POOL, probabilities);
    const share = budgetShareForBenchmarkOdds(average);

    // It must be larger than the configured 10%, because the floor made the slot cost more.
    assert.ok(share > MYSTERY_BUDGET_SHARE_BPS);

    // And using it must actually land the benchmarks, which is the point of the function.
    for (const benchmark of REFERENCE_BENCHMARKS) {
      const odds = calculateMysteryOdds(
        benchmark.priceMinor,
        RTP_FRACTION * (share / 10_000),
        average,
      );
      const drift = Math.abs(odds.oddsDenominator - benchmark.oddsDenominator)
        / benchmark.oddsDenominator;
      assert.ok(drift < 0.01, `restored odds drifted ${drift} at ${benchmark.priceMinor}`);
    }
  });
});

void describe('integer weight split', () => {
  void it('expresses the target probability inside the integer weight column', () => {
    const probabilities = inverseValueProbabilities(SUB_POOL);
    const average = averagePoolValue(SUB_POOL, probabilities);

    for (const price of [5_000, 15_000, 50_000, 150_000, 500_000, 1_500_000, 5_000_000,
      15_000_000, 50_000_000, 150_000_000]) {
      const odds = calculateMysteryOdds(price, mysteryBudgetFraction(), average);
      const split = resolveWeightSplit(odds.probability, 10_000, 2_000_000_000);

      assert.ok(split.mysteryWeight >= 1);
      assert.ok(split.ordinaryWeight >= 1);
      assert.equal(split.mysteryWeight + split.ordinaryWeight, split.totalWeight);
      assert.ok(split.totalWeight <= 2_000_000_000, 'total must fit a 32-bit integer column');

      // The achieved probability must match the target to within a fraction of a percent.
      const drift = Math.abs(split.achieved - odds.probability) / odds.probability;
      assert.ok(drift < 0.001, `weight split drifted ${drift} at price ${price}`);
    }
  });

  void it('refuses a probability it cannot represent', () => {
    assert.throws(() => resolveWeightSplit(0, 1000, 1_000_000), RangeError);
    assert.throws(() => resolveWeightSplit(1, 1000, 1_000_000), RangeError);
  });
});

void describe('the dynamic scaled mystery floor', () => {
  const PAYLOADS = [100_000_000, 130_000_000, 175_000_000, 250_000_000, 390_000_000,
    650_000_000, 1_000_000_000, 1_750_000_000, 3_000_000_000];
  const valueOf = (v: number) => v;

  void it('reproduces the brief’s three worked examples exactly', () => {
    assert.equal(mysteryFloorFor(100_000_000), 250_000_000, '$100M crate floors at $250M');
    assert.equal(mysteryFloorFor(200_000_000), 500_000_000, '$200M crate floors at $500M');
    assert.equal(mysteryFloorFor(52_000_000), 130_000_000, '$52M crate floors at $130M');
  });

  void it('uses the baseline below the threshold and the high-roller minimum above it', () => {
    assert.equal(mysteryFloorFor(5_000), BASELINE_FLOOR_MINOR);
    assert.equal(mysteryFloorFor(15_000_000), BASELINE_FLOOR_MINOR);
    // Just over the threshold the high-roller minimum takes effect.
    assert.ok(mysteryFloorFor(HIGH_ROLLER_THRESHOLD_MINOR + 1) >= HIGH_ROLLER_FLOOR_MINOR);
  });

  void it('never lets a mystery hit pay less than the minimum jackpot multiple', () => {
    /* The rule the whole feature rests on: there is no such thing as a disappointing mystery hit.
     * Checked across the ladder and past the top of it, because the guarantee has to survive a
     * crate priced higher than anything currently published. */
    for (const price of [5_000, 15_000, 50_000, 150_000, 500_000, 1_500_000, 5_000_000,
      15_000_000, 50_000_000, 150_000_000, 400_000_000, 1_000_000_000]) {
      const floor = mysteryFloorFor(price);
      assert.ok(
        floor / price >= MIN_JACKPOT_MULTIPLE - 1e-9,
        `a crate at ${price} floors at ${floor}, only ${(floor / price).toFixed(2)}x`,
      );
    }
  });

  void it('rises monotonically with price', () => {
    let previous = 0;
    for (const price of [5_000, 1_500_000, 15_000_000, 50_000_000, 150_000_000, 400_000_000]) {
      const floor = mysteryFloorFor(price);
      assert.ok(floor >= previous, `floor fell from ${previous} to ${floor} at price ${price}`);
      previous = floor;
    }
  });

  void it('refuses a nonsensical price rather than returning a nonsensical floor', () => {
    assert.throws(() => mysteryFloorFor(0), RangeError);
    assert.throws(() => mysteryFloorFor(-1), RangeError);
    assert.throws(() => mysteryFloorFor(Number.NaN), RangeError);
  });
});

void describe('the scaled sub-pool', () => {
  const PAYLOADS = [100_000_000, 130_000_000, 175_000_000, 250_000_000, 390_000_000,
    650_000_000, 1_000_000_000, 1_750_000_000, 3_000_000_000];
  const valueOf = (v: number) => v;

  void it('gives a cheap crate the low band and a high-roller crate a different one', () => {
    const cheap = buildScaledSubPool(PAYLOADS, valueOf, 5_000);
    const rich = buildScaledSubPool(PAYLOADS, valueOf, 150_000_000);

    assert.equal(Math.min(...cheap.values), 100_000_000);
    assert.equal(Math.min(...rich.values), 390_000_000);
    // The bands barely overlap, which is the entire point of scaling the floor.
    assert.ok(rich.averageValue > cheap.averageValue * 3);
  });

  void it('never reaches more than one order of magnitude above its own floor', () => {
    /* The span cap is load-bearing, not cosmetic: without it the rarest payload is one in
     * forty-seven thousand of the hits, which at a cheap crate's landing odds compounds into a
     * total weight of thirteen billion and no longer fits the integer weight column. */
    for (const price of [5_000, 5_000_000, 50_000_000, 150_000_000]) {
      const scaled = buildScaledSubPool(PAYLOADS, valueOf, price);
      assert.ok(
        Math.max(...scaled.values) <= scaled.floorMinor * POOL_SPAN_MULTIPLE,
        `pool for ${price} reaches past its span cap`,
      );
    }
  });

  void it('keeps every payload above the crate’s own floor', () => {
    for (const price of [5_000, 15_000_000, 50_000_000, 150_000_000]) {
      const scaled = buildScaledSubPool(PAYLOADS, valueOf, price);
      for (const value of scaled.values) assert.ok(value >= scaled.floorMinor);
      assert.ok(scaled.worstMultiple >= MIN_JACKPOT_MULTIPLE - 1e-9);
    }
  });

  void it('keeps the inverse ordering inside every scaled band', () => {
    for (const price of [5_000, 50_000_000, 150_000_000]) {
      const scaled = buildScaledSubPool(PAYLOADS, valueOf, price);
      for (let index = 1; index < scaled.probabilities.length; index += 1) {
        assert.ok(
          (scaled.probabilities[index] ?? 0) < (scaled.probabilities[index - 1] ?? 0),
          `payload ${index} is not rarer than ${index - 1} at price ${price}`,
        );
      }
    }
  });

  void it('drives the landing odds DOWN as the floor scales up', () => {
    /* This is the equilibrium the brief asks for: a richer pool costs the house more per hit, so
     * the probability has to fall or the crate stops returning 90%. Compared against what a flat
     * $100M pool would have given the same crate. */
    const flat = buildScaledSubPool(PAYLOADS, valueOf, 5_000).averageValue;
    const price = 150_000_000;
    const scaled = buildScaledSubPool(PAYLOADS, valueOf, price);

    const withFlat = calculateMysteryOdds(price, mysteryBudgetFraction(), flat);
    const withScaled = calculateMysteryOdds(price, mysteryBudgetFraction(), scaled.averageValue);

    assert.ok(withScaled.probability < withFlat.probability);
    assert.ok(withScaled.oddsDenominator > withFlat.oddsDenominator * 3);
    // And the budget routed through the slot is unchanged either way.
    assert.ok(Math.abs(withScaled.mysteryEvMinor - withFlat.mysteryEvMinor) < 1e-6);
  });

  void it('refuses to build a pool that would be empty', () => {
    // Nothing in this catalogue can serve a crate priced so high that 2.5x clears every payload.
    assert.throws(() => buildScaledSubPool(PAYLOADS, valueOf, 5_000_000_000), RangeError);
  });
});
