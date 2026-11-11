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
 * FREE MONEY IS FREE MONEY, WHATEVER IT IS CALLED. Every credit the player did not stake for
 * carries a requirement. Three multipliers, each a live setting, price them:
 *   signupBonusWagerMultiplier    the signup bonus, and with it a daily code, a Discord join or tag
 *                                 reward, a crown bounty, the daily streak, a Lava Rain share and a
 *                                 balance an administrator gives away;
 *   questRewardWagerMultiplier    a quest reward (the quest board, the daily and weekly quests);
 *   referralBonusWagerMultiplier  the referral milestone bonus paid to an inviter.
 * Any one of them left out is money an alt can collect and withdraw untouched: the streak paid
 * with no wager at all, and a giveaway credited from the admin panel could be withdrawn the same
 * minute. What stays out is money the player already wagered for at the house's price --
 * rakeback, race and jackpot wins, the referral revenue share -- and money that was theirs to
 * begin with (an operator refund says so with wagerLock). A deposit carries its own,
 * depositWagerMultiplier.
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

/**
 * Adds the requirement a deposit carries, at the configured multiplier. Called after the deposit's
 * credit, in the same transaction.
 *
 * A REQUIREMENT DIES WITH THE MONEY IT WAS FOR (the owner, 2026-11-11: "when someone loses their
 * money if they all in and then deposit again the old deposits counts too"). Only wagers count a
 * requirement down, never losses: $10M from a code owes $30M, an all-in $10M loss leaves $20M owed
 * on a $0 balance, and the next deposit used to stack on top of it. So when the balance before this
 * deposit was all but nothing AND nothing is still in play, what was left is forgiven before the
 * deposit adds its own. "Nothing in play" is the guard: a stake still riding (an open mines game, a
 * coinflip waiting for an opponent, a crash bet in the air) or items still held could come back
 * after the forgiveness and be withdrawn having skipped the wagering.
 */
export async function addDepositRequirement(
  client: DbClient,
  config: AppConfig,
  userId: string,
  depositMinor: bigint,
): Promise<void> {
  await forgiveSpentRequirement(client, userId, depositMinor);
  await addWagerRequirement(
    client,
    userId,
    requirementFor(depositMinor, config.depositWagerMultiplier),
  );
}

/** Below this, a balance is spent: less than any game takes as a stake. */
export const SPENT_BALANCE_MINOR = 1_000n;

/**
 * Clears what is owed when the player's balance before `justCreditedMinor` was under
 * SPENT_BALANCE_MINOR and they have no stake still unsettled and no items held. Returns what was
 * forgiven (0 when nothing was). The wallet row is already locked by the credit before it.
 */
export async function forgiveSpentRequirement(
  client: DbClient,
  userId: string,
  justCreditedMinor: bigint,
): Promise<bigint> {
  const result = await client.query<{ forgiven: string }>(
    `UPDATE user_wager_requirements r
        SET remaining_minor = 0, updated_at = now()
       FROM (SELECT remaining_minor AS before FROM user_wager_requirements WHERE user_id = $1) old
      WHERE r.user_id = $1 AND r.remaining_minor > 0
        AND (SELECT w.balance_minor FROM user_wallets w WHERE w.user_id = $1) - $2::bigint < $3::bigint
        AND NOT EXISTS (SELECT 1 FROM mines_games g WHERE g.user_id = $1 AND g.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM tower_games g WHERE g.user_id = $1 AND g.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM chicken_games g WHERE g.user_id = $1 AND g.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM blackjack_hands g WHERE g.user_id = $1 AND g.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM ice_fishing_games g WHERE g.user_id = $1 AND g.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM fishing_casts g WHERE g.user_id = $1 AND g.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM crash_bets g WHERE g.user_id = $1 AND g.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM roulette_bets g WHERE g.user_id = $1 AND g.settled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM side_bets g WHERE g.user_id = $1 AND g.settled_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM coinflip_games g
                         WHERE (g.host_user_id = $1 OR g.opponent_user_id = $1) AND g.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM mines_duel_games g
                         WHERE (g.host_user_id = $1 OR g.opponent_user_id = $1) AND g.status IN ('open', 'playing'))
        AND NOT EXISTS (SELECT 1 FROM duel_lobbies g
                         WHERE (g.host_user_id = $1 OR g.opponent_user_id = $1) AND g.status IN ('lobby', 'running'))
        AND NOT EXISTS (SELECT 1 FROM battle_players p JOIN battles b ON b.id = p.battle_id
                         WHERE p.user_id = $1 AND b.status IN ('lobby', 'running'))
        AND NOT EXISTS (SELECT 1 FROM inventory_lots l WHERE l.owner_user_id = $1 AND l.state = 'available')
      RETURNING old.before AS forgiven`,
    [userId, justCreditedMinor.toString(), SPENT_BALANCE_MINOR.toString()],
  );
  return BigInt(result.rows[0]?.forgiven ?? '0');
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
  action: 'withdrawing' | 'tipping' | 'staking',
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
