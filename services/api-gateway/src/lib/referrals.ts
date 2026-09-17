import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { ContributionSource } from './cash-settlement.js';
import type { DbClient } from './db.js';
import { creditWallet } from './wallet.js';

/**
 * The referral programme: a lifetime revenue share, and a one-off milestone bonus.
 *
 * Both engines run on the same `referrals` row and both pay out of the house margin, but they are
 * independent of one another. The revenue share accrues on every wager forever. The bonus unlocks
 * exactly once, when the referee has BOTH proved a Discord account and crossed the cumulative
 * wager threshold — whichever of those two happens second is what fires it, which is why the gate
 * is re-checked from the wager path AND from the Discord verification path.
 *
 * Everything here takes the caller's open transaction. A referral credit that commits without the
 * wager that earned it, or a bonus that pays without the row recording that it paid, is a
 * reconciliation problem nobody finds until the ledger is audited.
 */

/** What a wager earns the house, before the referrer's cut comes out of it. */
function houseMarginMinor(config: AppConfig, wagerMinor: bigint): bigint {
  return (wagerMinor * BigInt(config.houseEdgeBps)) / 10_000n;
}

/**
 * The referrer's cut of one wager.
 *
 * Taken from the margin, not from the wager: the player who was invited pays exactly what every
 * other player pays, and the referrer is paid out of what the house keeps. Integer division
 * truncates, so small wagers can round to nothing — that is correct, and preferable to rounding a
 * fraction of a unit up a few million times a day.
 */
export function revshareMinor(
  config: AppConfig,
  wagerMinor: bigint,
  marginMinor?: bigint,
): bigint {
  if (wagerMinor <= 0n) return 0n;
  /* See rakebackMinor for why an explicit margin exists: a skill duel's margin is a rake on the
   * pot, not an edge on the wager, and the referrer is owed a share of what was really collected
   * rather than of a number derived from an edge this mode does not charge. */
  const margin = marginMinor ?? houseMarginMinor(config, wagerMinor);
  return (margin * BigInt(config.referralRevshareBps)) / 10_000n;
}

interface ReferralRow {
  referrer_id: string;
  wagered_minor: string;
  bonus_unlocked_at: Date | null;
}

/**
 * Records one wager against the referee's referral, pays the revenue share, and re-tests the
 * milestone gate.
 *
 * Silently does nothing when the player was never referred or the programme is off. A wager is
 * not the moment to fail over a promotion: refusing the round because a bonus could not be paid
 * would let an optional side programme break the core game.
 */
export async function accrueReferralWager(
  client: DbClient,
  config: AppConfig,
  refereeId: string,
  wagerMinor: bigint,
  source: ContributionSource,
  referenceId: string,
  marginMinor?: bigint,
): Promise<void> {
  if (!config.referralsEnabled || wagerMinor <= 0n) return;

  /* FOR UPDATE, because two concurrent rounds from the same player would otherwise both read the
   * same running total, both decide the threshold was not crossed, and the milestone would never
   * fire. The lock also serializes the two writes to wagered_minor. */
  const existing = await client.query<ReferralRow>(
    `SELECT referrer_id, wagered_minor, bonus_unlocked_at
       FROM referrals WHERE referee_id = $1 FOR UPDATE`,
    [refereeId],
  );
  const referral = existing.rows[0];
  if (!referral) return;

  const commission = revshareMinor(config, wagerMinor, marginMinor);
  const wageredAfter = BigInt(referral.wagered_minor) + wagerMinor;

  await client.query(
    `UPDATE referrals
        SET wagered_minor = $2, revshare_paid_minor = revshare_paid_minor + $3, updated_at = now()
      WHERE referee_id = $1`,
    [refereeId, wageredAfter.toString(), commission.toString()],
  );

  if (commission > 0n) {
    /* The earnings row goes in FIRST, so its unique (kind, reference_id) index is what stops a
     * replayed settlement rather than the wallet insert further down. ON CONFLICT DO NOTHING plus
     * a rowCount check means a retry of the same round skips the credit instead of paying twice —
     * and the UPDATE above is idempotent-by-transaction, because a replay that reaches here is a
     * replay of the whole enclosing round. */
    const recorded = await client.query(
      `INSERT INTO referral_earnings
         (id, referrer_id, referee_id, kind, amount_minor, source, reference_id)
       VALUES ($1, $2, $3, 'revshare', $4, $5, $6)
       ON CONFLICT (kind, reference_id) DO NOTHING`,
      [randomUUID(), referral.referrer_id, refereeId, commission.toString(), source, referenceId],
    );
    if (recorded.rowCount) {
      await creditWallet(
        client,
        referral.referrer_id,
        commission,
        'referral_revshare',
        referenceId,
      );
    }
  }

  if (!referral.bonus_unlocked_at && wageredAfter >= config.referralBonusWagerMinor) {
    await tryUnlockMilestone(client, config, refereeId);
  }
}

/**
 * Tests both milestone conditions and pays the bonus if they are met.
 *
 * Called from two places — after a wager moves the running total, and after a Discord account is
 * verified — because either one can be the condition that completes the pair. Returns whether the
 * bonus was paid by THIS call, so a caller can tell the player something happened.
 *
 * The row is re-read under a lock rather than trusting whatever the caller already had: between a
 * caller's read and this write, the other condition may have landed in a parallel request.
 */
export async function tryUnlockMilestone(
  client: DbClient,
  config: AppConfig,
  refereeId: string,
): Promise<boolean> {
  if (!config.referralsEnabled) return false;

  const locked = await client.query<ReferralRow & { discord_verified_at: Date | null }>(
    `SELECT r.referrer_id, r.wagered_minor, r.bonus_unlocked_at, u.discord_verified_at
       FROM referrals r JOIN users u ON u.id = r.referee_id
      WHERE r.referee_id = $1
      FOR UPDATE OF r`,
    [refereeId],
  );
  const referral = locked.rows[0];
  if (!referral || referral.bonus_unlocked_at) return false;
  if (!referral.discord_verified_at) return false;
  if (BigInt(referral.wagered_minor) < config.referralBonusWagerMinor) return false;

  const bonus = config.referralBonusMinor;

  /* The referee id is the reference, so the unique index makes a second milestone payment for one
   * referral structurally impossible — not merely unreachable through this function. */
  const recorded = await client.query(
    `INSERT INTO referral_earnings
       (id, referrer_id, referee_id, kind, amount_minor, source, reference_id)
     VALUES ($1, $2, $3, 'milestone', $4, NULL, $3)
     ON CONFLICT (kind, reference_id) DO NOTHING`,
    [randomUUID(), referral.referrer_id, refereeId, bonus.toString()],
  );
  if (!recorded.rowCount) return false;

  await creditWallet(client, referral.referrer_id, bonus, 'referral_bonus', refereeId);
  await client.query(
    `UPDATE referrals
        SET bonus_unlocked_at = now(), bonus_paid_minor = $2, updated_at = now()
      WHERE referee_id = $1`,
    [refereeId, bonus.toString()],
  );
  return true;
}

/**
 * Returns the caller's invite code, minting one on first use.
 *
 * Random rather than derived from the user id: a code that is a function of the account id is a
 * reversible handle on an internal identifier, and referral links get pasted into public chat.
 * The alphabet omits the characters that get misread when a code is retyped from a screenshot.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function ensureReferralCode(client: DbClient, userId: string): Promise<string> {
  const existing = await client.query<{ code: string }>(
    'SELECT code FROM referral_codes WHERE user_id = $1',
    [userId],
  );
  const found = existing.rows[0]?.code;
  if (found) return found;

  /* A handful of attempts, because the only way this collides is a random 8-character draw from a
   * 32-letter alphabet hitting an existing row, and looping forever on a failure that is really
   * "the table is broken" would hang a request instead of surfacing it. */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    const inserted = await client.query<{ code: string }>(
      `INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING code`,
      [userId, code],
    );
    if (inserted.rows[0]?.code) return inserted.rows[0].code;
    // A conflict on user_id rather than on code means a parallel request won the race.
    const raced = await client.query<{ code: string }>(
      'SELECT code FROM referral_codes WHERE user_id = $1',
      [userId],
    );
    if (raced.rows[0]?.code) return raced.rows[0].code;
  }
  throw new Error('Unable to allocate a referral code');
}

function randomCode(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}
