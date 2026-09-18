import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { AppError } from './errors.js';

/**
 * Rechecks every launch and responsible-play gate while the user row is locked.
 *
 * There is no longer a daily wager cap. Both halves of it were removed deliberately: the
 * platform-wide ceiling and the per-player self-set limit. Everything else here still stands —
 * account status, age and terms, KYC, country, cooldown and self-exclusion — and removing any of
 * those is a separate decision from removing a turnover cap.
 */
export async function assertGameEligible(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<void> {
  const result = await client.query<{
    status: string;
    country_code: string | null;
    terms_accepted_at: Date | null;
    age_verified_at: Date | null;
    kyc_status: string;
    cooldown_until: Date | null;
    self_excluded_until: Date | null;
  }>(
    `SELECT u.status, u.country_code, u.terms_accepted_at, u.age_verified_at, u.kyc_status,
            r.cooldown_until, r.self_excluded_until
       FROM users u JOIN responsible_limits r ON r.user_id = u.id
      WHERE u.id = $1 FOR UPDATE OF u, r`,
    [userId],
  );
  const user = result.rows[0];
  if (!user || user.status !== 'active') {
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
  }
  if (
    !config.gameCurrencyOnly &&
    (!user.terms_accepted_at || !user.age_verified_at || !user.country_code)
  ) {
    throw new AppError(
      403,
      'COMPLIANCE_INCOMPLETE',
      'Age, location, and terms verification are required',
    );
  }
  if (!config.gameCurrencyOnly && user.kyc_status !== 'verified') {
    throw new AppError(403, 'KYC_REQUIRED', 'Identity verification is required');
  }
  if (
    !config.gameCurrencyOnly &&
    config.allowedCountries.size &&
    !config.allowedCountries.has(user.country_code?.toLowerCase() ?? '')
  ) {
    throw new AppError(403, 'COUNTRY_NOT_ALLOWED', 'Service is not available in this country');
  }
  if (user.cooldown_until && user.cooldown_until > new Date()) {
    throw new AppError(403, 'COOLDOWN_ACTIVE', 'Account cooldown is active');
  }
  if (user.self_excluded_until && user.self_excluded_until > new Date()) {
    throw new AppError(403, 'SELF_EXCLUDED', 'Account is self-excluded');
  }
}
