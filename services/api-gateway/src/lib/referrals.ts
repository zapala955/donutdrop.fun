import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { staffPredicate } from './admin-stats.js';
import { compactMinor, holdQueuedForUser } from './anti-drain.js';
import { appendAudit } from './audit.js';
import type { ContributionSource } from './cash-settlement.js';
import type { DbClient } from './db.js';
import { conflict } from './errors.js';
import { recordNetwork, referralStanding, voidSameNetworkReferral } from './referral-network.js';
import { countedWagerMinor } from './rewards.js';
import { creditWallet } from './wallet.js';

/**
 * The referral programme: a lifetime revenue share, and a one-off milestone bonus.
 *
 * Both engines run on the same `referrals` row and both pay out of the house margin, but they are
 * independent of one another. The revenue share accrues on every wager forever and waits for the
 * referrer to claim it. The bonus unlocks exactly once when the referee crosses the cumulative
 * wager threshold.
 *
 * Everything here takes the caller's open transaction. An accrual that commits without the wager
 * that earned it, or a bonus or claim that pays without the row recording it, is a
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
export function revshareMinor(config: AppConfig, wagerMinor: bigint, marginMinor?: bigint): bigint {
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
  network_reviewed_at?: Date | null;
  revshare_bps?: number;
}

interface ClaimableReferralRow {
  referee_id: string;
  revshare_claimable_minor: string;
  network_reviewed_at?: Date | null;
}

/** A claim either pays, or finds the referrer blocked from the programme and pays nothing. */
/* `voidedInvites` counts the invites this claim found on the referrer's own network and voided. When
 * they were all there was, nothing is paid (`empty`), and the void still has to commit. */
export type ReferralClaimResult =
  | { blocked: false; empty: false; claimedMinor: string; balanceMinor: string; voidedInvites: number }
  | { blocked: false; empty: true; voidedInvites: number }
  | { blocked: true };

/**
 * Records one wager against the referee's referral, accrues claimable revenue share, and re-tests
 * the milestone gate.
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
    `SELECT r.referrer_id, r.wagered_minor, r.bonus_unlocked_at,
            coalesce((
              SELECT a.granted_revshare_bps FROM creator_applications a
               WHERE a.user_id = r.referrer_id AND a.status = 'approved'
               ORDER BY a.reviewed_at DESC LIMIT 1
            ), $2)::integer AS revshare_bps
       FROM referrals r WHERE r.referee_id = $1 AND r.voided_at IS NULL FOR UPDATE`,
    [refereeId, config.referralRevshareBps],
  );
  const referral = existing.rows[0];
  if (!referral) return;

  const margin = marginMinor ?? houseMarginMinor(config, wagerMinor);
  const commission =
    (margin * BigInt(referral.revshare_bps ?? config.referralRevshareBps)) / 10_000n;
  /* The milestone counts what the wager earned the house, expressed as a house-game stake, not
   * its face value: a PvP stake earns the rake alone, and counted in full it let a referee and the
   * referrer's own second account flip the gate open for 3% of it. See countedWagerMinor. So
   * `wagered_minor` is the counted wager from here on, which is also what the progress bar shows. */
  const wageredAfter =
    BigInt(referral.wagered_minor) + countedWagerMinor(config, wagerMinor, marginMinor);

  if (commission > 0n) {
    /* The earnings row goes in FIRST, so its unique (kind, reference_id) index stops a replayed
     * settlement before either running total moves. Revenue share is an earning here, but it is no
     * longer a wallet payment: it waits in revshare_claimable_minor until the referrer collects it
     * from the Rewards page. */
    const recorded = await client.query(
      `INSERT INTO referral_earnings
         (id, referrer_id, referee_id, kind, amount_minor, source, reference_id)
       VALUES ($1, $2, $3, 'revshare', $4, $5, $6)
       ON CONFLICT (kind, reference_id) DO NOTHING`,
      [randomUUID(), referral.referrer_id, refereeId, commission.toString(), source, referenceId],
    );
    if (!recorded.rowCount) return;
  }

  await client.query(
    `UPDATE referrals
        SET wagered_minor = $2,
            revshare_claimable_minor = revshare_claimable_minor + $3,
            updated_at = now()
      WHERE referee_id = $1`,
    [refereeId, wageredAfter.toString(), commission.toString()],
  );

  if (!referral.bonus_unlocked_at && wageredAfter >= config.referralBonusWagerMinor) {
    await tryUnlockMilestone(client, config, refereeId);
  }
}

/**
 * Collects every referral-share balance belonging to one referrer in a single wallet credit.
 *
 * The rows are locked in referee-id order. A concurrent wager either lands before this snapshot
 * and is included, or after it and remains claimable for the next collection; it can never be
 * cleared without being paid. A replay finds every balance at zero and is refused.
 */
export async function claimReferralRewards(
  client: DbClient,
  config: AppConfig,
  referrerId: string,
  ip?: string,
): Promise<ReferralClaimResult> {
  /* The network this claim came from counts as one the referrer uses, before anything is compared:
   * collecting from a referee's account on the referee's own connection is the case to catch. */
  await recordNetwork(client, config, referrerId, ip);
  const locked = await client.query<ClaimableReferralRow>(
    /* Voided referrals are excluded HERE as well as at the accrual, and that is the half that
     * actually matters: stopping future earnings while still paying out everything a fraudulent
     * relationship had already banked would make voiding it a formality. The frozen figure stays
     * on the row rather than being zeroed, so what was forfeited is still legible afterwards. */
    `SELECT referee_id, revshare_claimable_minor, network_reviewed_at
       FROM referrals
      WHERE referrer_id = $1 AND revshare_claimable_minor > 0 AND voided_at IS NULL
      ORDER BY referee_id
      FOR UPDATE`,
    [referrerId],
  );
  /* Every invite being paid is checked, not only new ones: an alt that signed up elsewhere and
   * later played on its inviter's connection shows itself here. That invite is voided and its
   * balance left out; the genuine ones are paid as usual. A referrer an administrator has blocked
   * collects nothing until the block is lifted; the balances wait. */
  const paying: ClaimableReferralRow[] = [];
  let voidedInvites = 0;
  for (const row of locked.rows) {
    const standing = await referralStanding(client, row.referee_id, referrerId);
    if (standing.referrerBlocked) return { blocked: true };
    if (standing.sharedNetwork && !row.network_reviewed_at) {
      await voidSameNetworkReferral(client, config, row.referee_id, referrerId, 'claim');
      voidedInvites += 1;
    } else {
      paying.push(row);
    }
  }
  const amount = paying.reduce(
    (sum, row) => sum + BigInt(row.revshare_claimable_minor),
    0n,
  );
  // Returned rather than thrown, so the voids above commit; the route words the refusal.
  if (amount <= 0n && voidedInvites > 0) return { blocked: false, empty: true, voidedInvites };
  if (amount <= 0n) conflict('REFERRAL_REWARDS_EMPTY', 'No referral rewards are ready to claim');

  const claimId = randomUUID();
  const balanceAfter = await creditWallet(
    client,
    referrerId,
    amount,
    'referral_revshare',
    claimId,
  );
  /* Exactly the rows summed above, which this transaction holds locked. Matching on "claimable > 0"
   * instead would also clear an invite whose first commission landed after the snapshot, moving
   * money that was never credited into the paid column. */
  await client.query(
    `UPDATE referrals
        SET revshare_paid_minor = revshare_paid_minor + revshare_claimable_minor,
            revshare_claimable_minor = 0,
            updated_at = now()
      WHERE referrer_id = $1 AND referee_id = ANY($2::uuid[]) AND voided_at IS NULL`,
    [referrerId, paying.map((row) => row.referee_id)],
  );
  await client.query(
    `INSERT INTO referral_claims
       (id, referrer_id, amount_minor, balance_after_minor)
     VALUES ($1, $2, $3, $4)`,
    [claimId, referrerId, amount.toString(), balanceAfter],
  );

  return {
    blocked: false,
    empty: false,
    claimedMinor: amount.toString(),
    balanceMinor: balanceAfter,
    voidedInvites,
  };
}

/**
 * Tests the milestone condition and pays the bonus if it is met.
 *
 * ONE condition now: the referee's cumulative wager has reached the threshold. It used to need a
 * verified Discord account as well, and that second condition was doing two jobs — it gated the
 * payout, and it made a referee expensive to fabricate, because one Discord account can be bound
 * to at most one site account here.
 *
 * Only the first job was asked for and only the first job is gone. The second is now unprotected:
 * nothing in this function can tell a real invite from an operator's own second login, and the
 * wager threshold is the only cost an attacker pays. See the note on solvency in .env.example —
 * whether that cost exceeds the bonus is a matter of arithmetic between the threshold and the
 * house edge, and it is the operator's to keep true.
 *
 * Returns whether the bonus was paid by THIS call, so a caller can tell the player something
 * happened. The row is re-read under a lock rather than trusting whatever the caller already had.
 */
export async function tryUnlockMilestone(
  client: DbClient,
  config: AppConfig,
  refereeId: string,
): Promise<boolean> {
  if (!config.referralsEnabled) return false;

  /* The join to `users` went with the Discord condition. This reads one row from one table now,
     which is the whole of what the gate depends on. */
  const locked = await client.query<ReferralRow>(
    /* `voided_at IS NULL` is the whole of the fraud control on this path. A voided referral keeps
     * its row and its counters -- the evidence outlives the decision -- and simply stops earning,
     * so a manufactured signup cannot reach its milestone after somebody has ruled on it. */
    `SELECT referrer_id, wagered_minor, bonus_unlocked_at, network_reviewed_at
       FROM referrals
      WHERE referee_id = $1 AND voided_at IS NULL
      FOR UPDATE`,
    [refereeId],
  );
  const referral = locked.rows[0];
  if (!referral || referral.bonus_unlocked_at) return false;
  if (BigInt(referral.wagered_minor) < config.referralBonusWagerMinor) return false;

  /* Last look before the bonus is paid. A blocked referrer is simply not paid yet: the gate stays
   * shut, the next wager asks again, and if an administrator has lifted the block by then it pays.
   * Two accounts that have shared a network are the self-invite this bonus attracts, unless an
   * administrator has already looked at this pair and restored it: that invite is voided. */
  const standing = await referralStanding(client, refereeId, referral.referrer_id);
  if (standing.referrerBlocked) return false;
  if (standing.sharedNetwork && !referral.network_reviewed_at) {
    await voidSameNetworkReferral(client, config, refereeId, referral.referrer_id, 'milestone');
    return false;
  }

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

  /* Before the credit: the referrer's account row is locked here and their wallet after it, the
   * order a withdrawal takes them in, so the two cannot deadlock. */
  await holdIfInvitesStopAtRequirement(
    client,
    config,
    referral.referrer_id,
    refereeId,
    BigInt(referral.wagered_minor),
  );

  await creditWallet(client, referral.referrer_id, bonus, 'referral_bonus', refereeId);
  await client.query(
    `UPDATE referrals
        SET bonus_unlocked_at = now(), bonus_paid_minor = $2, updated_at = now()
      WHERE referee_id = $1`,
    [refereeId, bonus.toString()],
  );
  return true;
}

/** How far over the referral wager requirement an invite may go and still count as stopping at it. */
export const REFERRAL_STOP_MARGIN_BPS = 1_000n; // 10%
/** How many such invites put the referrer on hold. */
export const REFERRAL_STOP_COUNT = 2;
/** A referrer whose account is younger than this is held at the first such invite. */
export const REFERRAL_FRESH_REFERRER_DAYS = 7;

/**
 * Two invited players who wager just past the referral requirement and then stop are what alts
 * farming the bonus look like; a real friend keeps playing. So when an invite pays its milestone
 * and REFERRAL_STOP_COUNT or more of the referrer's paid invites (this one included) have wagered no
 * more than REFERRAL_STOP_MARGIN_BPS over the requirement, the referrer gets a payout hold until an
 * administrator reviews it. The operator's rule, 2026-10-23.
 *
 * A hold takes nothing (lib/anti-drain.ts): the bonus is still paid into the wallet and can be
 * played. It stops money leaving, pulls back withdrawals already waiting for the bot, and lists the
 * player in admin -> Payouts with this reason, where Release lifts it; staff alerts post it.
 *
 * Judged when an invite pays, because that is when money moves. The invite paying now has only just
 * reached the requirement, so it is almost always inside the margin; what decides the hold is
 * whether an earlier paid invite also stopped there instead of playing on. Measured against the
 * requirement as it is now, so an invite paid under a lower one counts by today's figure.
 *
 * A referrer younger than REFERRAL_FRESH_REFERRER_DAYS is held at the FIRST such invite. The farm
 * of 2026-10-23 chained its alts: an invite that had just paid became a referrer itself, invited one
 * more fresh alt and took that bonus too, and an account with one invite never reaches two.
 */
async function holdIfInvitesStopAtRequirement(
  client: DbClient,
  config: AppConfig,
  referrerId: string,
  refereeId: string,
  refereeWageredMinor: bigint,
): Promise<boolean> {
  const requirement = config.referralBonusWagerMinor;
  const limit = (requirement * (10_000n + REFERRAL_STOP_MARGIN_BPS)) / 10_000n;
  const earlier = await client.query<{ n: string; fresh: boolean | null }>(
    `SELECT (SELECT count(*) FROM referrals
              WHERE referrer_id = $1 AND referee_id <> $2 AND voided_at IS NULL
                AND bonus_unlocked_at IS NOT NULL AND wagered_minor <= $3)::text AS n,
            (SELECT created_at > now() - make_interval(days => $4::integer)
               FROM users WHERE id = $1) AS fresh`,
    [referrerId, refereeId, limit.toString(), REFERRAL_FRESH_REFERRER_DAYS],
  );
  const fresh = earlier.rows[0]?.fresh === true;
  const stopped = Number(earlier.rows[0]?.n ?? 0) + (refereeWageredMinor <= limit ? 1 : 0);
  if (stopped < (fresh ? 1 : REFERRAL_STOP_COUNT)) return false;

  const bounds = `${compactMinor(limit)} against ${compactMinor(requirement)}`;
  const reason =
    stopped < REFERRAL_STOP_COUNT
      ? `Auto: account under ${REFERRAL_FRESH_REFERRER_DAYS} days old, and its invite stopped at the ` +
        `referral wager requirement (wagered at most ${bounds}). Review the invites.`
      : `Auto: ${stopped} invites stopped at the referral wager requirement (each wagered at most ` +
        `${bounds}). Review the invites.`;
  /* The guard is in the UPDATE: a hold already in place (by hand or by another rule) is left as it
   * is, and staff, who test the programme with their own invites, are never held by it. */
  const placed = await client.query(
    `UPDATE users u
        SET payout_hold_reason = $2, payout_hold_at = now(), payout_hold_by = NULL,
            updated_at = now()
      WHERE u.id = $1 AND u.payout_hold_reason IS NULL AND u.status = 'active'
        AND NOT ${staffPredicate('u')}
      RETURNING u.id`,
    [referrerId, reason.slice(0, 300)],
  );
  if (!placed.rows.length) return false;
  const pulled = await holdQueuedForUser(client, referrerId, reason);
  await appendAudit(client, config, {
    actorUserId: null,
    action: 'referral.auto_hold',
    targetType: 'user',
    targetId: referrerId,
    details: {
      reason,
      stoppedInvites: stopped,
      freshReferrer: fresh,
      limitMinor: limit.toString(),
      requirementMinor: requirement.toString(),
      paidInvite: refereeId,
      pulledBack: pulled.held,
    },
  });
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
