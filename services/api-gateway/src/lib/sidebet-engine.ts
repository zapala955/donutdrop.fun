/**
 * sidebet-engine.ts — the parimutuel maths, with no database and no network in it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PARIMUTUEL, NOT FIXED ODDS, AND THAT IS THE WHOLE DESIGN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every stake goes into one pool; the house takes its cut of the pool at settlement and the rest is
 * split between the winning side in proportion to what each of them put in. Nobody is quoted a
 * price they are then owed.
 *
 * The alternative — fixed odds — would make the house the counterparty on every bet, which means it
 * can lose, which means it has to price the market. Pricing "does this snake get out with $80M"
 * correctly, live, against players who can see the same board, is a real trading desk. A parimutuel
 * pool cannot lose: it only ever pays out money that is already in it.
 *
 * The multiplier a spectator is shown is therefore a CURRENT multiplier, not a promise. It moves as
 * other people bet, and it is computed from the pool, so it is always exactly what would be paid if
 * the market settled that instant.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE CUT IS NEVER SHOWN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `impliedMultiplier` already has the rake taken out of it, so a spectator sees the number they
 * would actually be paid per unit staked and never sees a percentage. That is the brief's "display
 * clean payout multipliers only", and it is also just better: a multiplier is actionable, a rake
 * disclosure is a number nobody can do anything with.
 */

export interface PoolSplit {
  readonly poolMinor: bigint;
  readonly rakeMinor: bigint;
  readonly payoutMinor: bigint;
}

/**
 * Splits a settled pool.
 *
 * Integer division truncates, which rounds the rake down and therefore in the players' favour on
 * every partial unit — the same direction every other settlement on this platform rounds.
 */
export function splitPool(poolMinor: bigint, rakeBps: number): PoolSplit {
  if (poolMinor < 0n) throw new Error('Refusing to settle a negative pool');
  const rakeMinor = (poolMinor * BigInt(rakeBps)) / 10_000n;
  return { poolMinor, rakeMinor, payoutMinor: poolMinor - rakeMinor };
}

/**
 * What one winning stake is paid out of a settled pool.
 *
 * Pro-rata by stake: a bet twice the size of another on the same side is paid twice as much. The
 * remainder from the division is handled by the caller, which gives it to the largest stake — see
 * `settlePool`.
 */
export function shareFor(
  stakeMinor: bigint,
  winningStakeMinor: bigint,
  payoutMinor: bigint,
): bigint {
  if (winningStakeMinor <= 0n) return 0n;
  return (payoutMinor * stakeMinor) / winningStakeMinor;
}

export interface Bet {
  readonly id: string;
  readonly userId: string;
  readonly outcome: string;
  readonly stakeMinor: bigint;
}

export interface Settlement {
  readonly poolMinor: bigint;
  readonly rakeMinor: bigint;
  readonly payoutMinor: bigint;
  /** Bet id to what it is paid. Losing bets appear with 0 rather than being absent. */
  readonly payouts: ReadonlyMap<string, bigint>;
  /**
   * True when the market resolved to a side nobody backed, or to no side at all.
   *
   * Both are refunds at face value with no rake, because the house did not produce a result anybody
   * can be paid on — and charging a fee to hand money back is the clearest way to lose a player.
   */
  readonly voided: boolean;
}

/**
 * Settles a market.
 *
 * The rounding remainder goes to the LARGEST winning stake rather than being dropped. Dropping it
 * would mean the pool did not add up, and `side_bet_rake_adds_up` in the schema refuses a row where
 * it does not — so this is not a nicety, it is what makes the write succeed.
 */
export function settlePool(
  bets: readonly Bet[],
  winningOutcome: string | null,
  rakeBps: number,
): Settlement {
  const poolMinor = bets.reduce((total, bet) => total + bet.stakeMinor, 0n);
  const payouts = new Map<string, bigint>();

  const winners = winningOutcome ? bets.filter((bet) => bet.outcome === winningOutcome) : [];
  const winningStake = winners.reduce((total, bet) => total + bet.stakeMinor, 0n);

  /* No winner, or a winner nobody backed: everybody gets exactly what they put in. */
  if (!winningOutcome || winningStake <= 0n) {
    for (const bet of bets) payouts.set(bet.id, bet.stakeMinor);
    return { poolMinor, rakeMinor: 0n, payoutMinor: poolMinor, payouts, voided: true };
  }

  const split = splitPool(poolMinor, rakeBps);
  let distributed = 0n;
  for (const bet of bets) {
    const share =
      bet.outcome === winningOutcome
        ? shareFor(bet.stakeMinor, winningStake, split.payoutMinor)
        : 0n;
    payouts.set(bet.id, share);
    distributed += share;
  }

  const remainder = split.payoutMinor - distributed;
  if (remainder > 0n) {
    const largest = winners.reduce((best, bet) => (bet.stakeMinor > best.stakeMinor ? bet : best));
    payouts.set(largest.id, (payouts.get(largest.id) ?? 0n) + remainder);
  }

  return { ...split, payouts, voided: false };
}

/**
 * The multiplier a side is currently paying, net of the rake, in hundredths.
 *
 * Returned as an integer so nothing on the way to the browser has to round a float. 250 means 2.50x.
 * A side nobody has backed yet would divide by zero, so it reports the whole pool as its multiple —
 * which is the truth: the first person in takes everything on the other side.
 */
export function impliedMultiplierBps(
  sideStakeMinor: bigint,
  poolMinor: bigint,
  rakeBps: number,
): number {
  const { payoutMinor } = splitPool(poolMinor, rakeBps);
  if (sideStakeMinor <= 0n) return payoutMinor > 0n ? 10_000 : 0;
  return Number((payoutMinor * 10_000n) / sideStakeMinor);
}
