import type { DbClient } from './db.js';
import { AppError } from './errors.js';

/**
 * Rechecks that the account may play, while its row is locked.
 *
 * ONE condition: the account is active. That is the whole gate.
 *
 * It used to be seven. Terms, age, country, KYC, a cooldown and a self-exclusion window all sat
 * here because the platform was built to be able to run as a real-money casino, where each is a
 * licensing condition rather than a product decision. It settles in DonutSMP dollars. Four of the
 * seven were already switched off in production by `GAME_CURRENCY_ONLY`, which made this function
 * mostly a branch nobody took; the remaining two were self-imposed play limits belonging to the
 * same apparatus.
 *
 * Suspension and banning are untouched and always were a different thing: an operator stopping an
 * account is not a compliance control, it is moderation, and it still runs through `status`.
 *
 * The lock stays. It is not here for the checks that were removed — it is here because the caller
 * is about to take money off this row, and reading the status outside the lock the debit runs under
 * is how an account gets suspended in the microsecond between the two.
 */
export async function assertGameEligible(client: DbClient, userId: string): Promise<void> {
  const result = await client.query<{ status: string }>(
    'SELECT status FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  const user = result.rows[0];
  if (!user || user.status !== 'active') {
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
  }
}
