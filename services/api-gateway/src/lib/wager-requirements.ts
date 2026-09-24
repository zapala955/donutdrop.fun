/**
 * What a player must wager before money can leave their account.
 *
 * Signing up is free and a Bedrock account is a free Microsoft account, so a signup bonus that
 * could be withdrawn at once would pay anybody willing to make alts. And a deposit that could be
 * withdrawn untouched would make the site a free way to move money between Minecraft accounts.
 * Both are closed the same way: crediting either adds to a running figure the player owes in
 * wagers, every settled wager counts it down, and money only leaves (cash withdrawal, tip, item
 * withdrawal) once it reaches zero.
 *
 * ONE FIGURE, NOT A LEDGER OF LOCKS. The only question anybody asks is "may this player move money
 * out yet", and one row answers it in one read. The cost is that it cannot say which deposit is
 * still locked, and nothing needs it to.
 *
 * WHAT IT DOES NOT COVER. Losing a skill duel or a battle on purpose to a second account moves value
 * between players, and counts as wagering while doing it. That leak is priced by the rake rather
 * than closed; closing it would mean a separate bonus balance, which this deliberately is not.
 */
import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { AppError } from './errors.js';

const BIGINT_MAX = 9_223_372_036_854_775_807n;

/** The requirement a credit of `amountMinor` adds at `multiplier` times, clamped to a bigint. */
export function requirementFor(amountMinor: bigint, multiplier: number): bigint {
  if (amountMinor <= 0n || !Number.isInteger(multiplier) || multiplier <= 0) return 0n;
  const owed = amountMinor * BigInt(multiplier);
  return owed > BIGINT_MAX ? BIGINT_MAX : owed;
}

/**
 * Adds to what the player owes. Called in the same transaction as the credit that caused it.
 *
 * The sum is clamped in SQL rather than trusted to fit: this runs inside a deposit's settlement,
 * and a deposit that failed on an overflow would leave the bot retrying a payment it had already
 * received.
 */
export async function addWagerRequirement(
  client: DbClient,
  userId: string,
  amountMinor: bigint,
): Promise<void> {
  if (amountMinor <= 0n) return;
  await client.query(
    `INSERT INTO user_wager_requirements (user_id, remaining_minor)
     VALUES ($1, $2::bigint)
     ON CONFLICT (user_id) DO UPDATE
       SET remaining_minor = LEAST(
             user_wager_requirements.remaining_minor::numeric + EXCLUDED.remaining_minor,
             ${BIGINT_MAX.toString()}
           )::bigint,
           updated_at = now()`,
    [userId, amountMinor.toString()],
  );
}

/** Adds the requirement a deposit carries, at the configured multiplier. */
export async function addDepositRequirement(
  client: DbClient,
  config: AppConfig,
  userId: string,
  depositMinor: bigint,
): Promise<void> {
  await addWagerRequirement(
    client,
    userId,
    requirementFor(depositMinor, config.depositWagerMultiplier),
  );
}

/** Counts a settled wager against whatever the player owes. A no-op for everybody who owes nothing. */
export async function reduceWagerRequirement(
  client: DbClient,
  userId: string,
  wagerMinor: bigint,
): Promise<void> {
  if (wagerMinor <= 0n) return;
  await client.query(
    `UPDATE user_wager_requirements
        SET remaining_minor = GREATEST(remaining_minor - $2::bigint, 0), updated_at = now()
      WHERE user_id = $1 AND remaining_minor > 0`,
    [userId, wagerMinor.toString()],
  );
}

/** What the player still owes, or 0. */
export async function wagerRequirementRemaining(client: DbClient, userId: string): Promise<bigint> {
  const result = await client.query<{ remaining_minor: string }>(
    'SELECT remaining_minor FROM user_wager_requirements WHERE user_id = $1',
    [userId],
  );
  return BigInt(result.rows[0]?.remaining_minor ?? '0');
}

/**
 * Refuses to let money leave while anything is owed. Call inside the transaction that debits.
 *
 * The wallet row is locked FIRST. A deposit credits that row and adds its requirement in one
 * transaction, so taking the same lock orders the two: either the deposit committed before this
 * read (and its requirement is seen), or it waits until this withdrawal has debited only what was
 * there before it. Without the lock, a deposit landing between this check and the debit could be
 * withdrawn untouched.
 */
export async function assertWagerRequirementMet(
  client: DbClient,
  userId: string,
  action: 'withdrawing' | 'tipping',
): Promise<void> {
  await client.query('SELECT 1 FROM user_wallets WHERE user_id = $1 FOR UPDATE', [userId]);
  const remaining = await wagerRequirementRemaining(client, userId);
  if (remaining > 0n) {
    throw new AppError(
      409,
      'WAGER_REQUIREMENT',
      `Wager $${remaining.toLocaleString('en-US')} more before ${action}`,
      { remainingMinor: remaining.toString() },
    );
  }
}
