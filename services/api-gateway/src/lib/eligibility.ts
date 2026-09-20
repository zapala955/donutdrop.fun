/**
 * Whether an account may be credited for a deposit.
 *
 * One question now: is the account active.
 *
 * It used to ask six — country, terms, age, KYC, cooldown, self-exclusion — because the platform
 * was written to be able to run as a real-money casino, where every one of those is a licensing
 * condition. It settles in DonutSMP dollars, so none of them is. `GAME_CURRENCY_ONLY` already
 * switched four of them off in production; this removes the apparatus rather than leaving a flag
 * that only ever has one value and a code path nobody runs.
 *
 * Kept as its own function rather than inlined at the two call sites. "Active" is the whole rule
 * today, but it is the kind of rule that grows back, and one place for it is what stops the two
 * call sites from disagreeing about what eligible means.
 */
export interface DepositEligibilityState {
  status: string;
}

export function isDepositEligible(state: DepositEligibilityState | undefined): boolean {
  return state?.status === 'active';
}
