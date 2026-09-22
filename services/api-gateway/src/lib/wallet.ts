import { randomUUID } from 'node:crypto';
import type { DbClient } from './db.js';
import { publishLiveSoon } from './live-events.js';

/**
 * The cash ledger, on its own.
 *
 * This lives apart from cash-settlement.ts because both that module and the referral engine need
 * to credit a wallet, and cash-settlement calls the referral engine. Leaving the credit in
 * cash-settlement would make those two modules import each other; a cycle between two files that
 * both move money is the kind of thing that works until a bundler reorders it.
 */

export type WalletKind =
  | 'pay_login_deposit'
  | 'cash_deposit'
  | 'upgrade_win'
  | 'case_win'
  | 'quest_reward'
  | 'streak_reward'
  | 'faction_payout'
  // Battles: the pot paid to a winning seat, and a stake returned when a lobby is abandoned.
  | 'battle_win'
  | 'battle_refund'
  /* Skill duels: the pot less the rake paid to the winner, and a stake returned whole when the
   * duel produced no winner — a draw, a cancelled lobby or an expiry. There is no 'duel_stake'
   * here for the same reason there is no 'battle_stake': this type is the credit vocabulary, and
   * a stake is a debit written directly by the route that takes it. */
  | 'duel_win'
  | 'duel_refund'
  /* The arena, which no longer exists — and these two kinds stay anyway.
   *
   * The wallet is append-only, so every extraction and every refund the arena ever wrote is still
   * in somebody's history and still needs a name. Removing them would not tidy anything; it would
   * make those rows unnameable. They outlive the mode, as the piggy bank's three did before them.
   *
   * `slither_cashout` is an extraction that reached the wallet net of the platform's
   * cut, and `slither_refund` is the buy-in handed back whole when the arena process died holding
   * a live session. There is no credit vocabulary for a kill: a kill does not pay the killer, it
   * puts the victim's value on the floor for whoever reaches it, and that transfer happens inside
   * the simulation where the ledger never sees it. The ledger sees a buy-in and an exit. */
  | 'slither_cashout'
  | 'slither_refund'
  /* The social suite. `tip_received` is the credit half of a player-to-player transfer; the debit
   * half is written by the route that takes it, like every other stake on this platform. There is
   * no house cut on either side — a tip generates no margin, so charging for one would be charging
   * a player to be generous. */
  | 'jackpot_win'
  | 'rain_claim'
  | 'tip_received'
  | 'sidebet_win'
  | 'sidebet_refund'
  | 'roulette_win'
  // A community crate paying its author. Carved from the house margin, never added to the price.
  | 'creator_royalty'
  // Referrals: the lifetime cut of the house margin, and the one-off milestone bonus. Both are
  // carved from the margin, so neither costs the referred player anything.
  | 'referral_revshare'
  | 'referral_bonus'
  // Rakeback claimed from one of the four tiers, and a wagering race paying a placing. Both are
  // carved from the house margin, like everything else that pays a player for playing.
  | 'rakeback_claim'
  | 'race_payout';

/**
 * Credits the wallet and writes the matching ledger row.
 *
 * wallet_transactions is unique on (kind, reference_id), so passing the round id as the reference
 * makes a replayed request fail loudly on the second insert rather than paying twice.
 */
export async function creditWallet(
  client: DbClient,
  userId: string,
  amountMinor: bigint,
  kind: WalletKind,
  referenceId: string,
): Promise<string> {
  if (amountMinor <= 0n) throw new Error(`Refusing to credit a non-positive ${kind}`);
  await client.query(
    `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const credited = await client.query<{ balance_minor: string }>(
    `UPDATE user_wallets SET balance_minor = balance_minor + $2, updated_at = now()
      WHERE user_id = $1 RETURNING balance_minor`,
    [userId, amountMinor.toString()],
  );
  const balanceAfter = credited.rows[0]?.balance_minor;
  if (balanceAfter === undefined) throw new Error('Wallet credit returned no balance');

  await client.query(
    `INSERT INTO wallet_transactions
       (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, amountMinor.toString(), balanceAfter, kind, referenceId],
  );
  // The caller still owns the transaction. Delay the invalidation by one event-loop turn so the
  // browser cannot race the COMMIT and read the old balance; a harmless refresh is the worst case
  // if the surrounding transaction subsequently rolls back.
  publishLiveSoon('balance', [userId]);
  return balanceAfter;
}
