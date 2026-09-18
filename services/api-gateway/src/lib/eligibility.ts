export interface DepositEligibilityState {
  status: string;
  country_code: string | null;
  terms_accepted_at: Date | string | null;
  age_verified_at: Date | string | null;
  kyc_status: string;
  cooldown_until: Date | string | null;
  self_excluded_until: Date | string | null;
}

function restrictionIsActive(value: Date | string | null, nowMs: number): boolean {
  if (value === null) return false;
  if (value === 'infinity') return true;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  // Invalid database state fails closed rather than silently lifting a restriction.
  return !Number.isFinite(timestamp) || timestamp > nowMs;
}

export function isDepositEligible(
  state: DepositEligibilityState | undefined,
  allowedCountries: ReadonlySet<string>,
  nowMs = Date.now(),
  gameCurrencyOnly = false,
): boolean {
  if (!state || state.status !== 'active') return false;
  if (!gameCurrencyOnly) {
    if (
      !state.country_code ||
      !state.terms_accepted_at ||
      !state.age_verified_at ||
      state.kyc_status !== 'verified'
    ) {
      return false;
    }
    if (
      allowedCountries.size > 0 &&
      !allowedCountries.has(state.country_code.trim().toLowerCase())
    ) {
      return false;
    }
  }
  return (
    !restrictionIsActive(state.cooldown_until, nowMs) &&
    !restrictionIsActive(state.self_excluded_until, nowMs)
  );
}
