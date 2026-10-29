import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { publishLiveSoon } from './live-events.js';
import { maskedName } from './masked-name.js';

/**
 * notifications.ts — the bell in the top bar: what happened to a player's money that they did not
 * do themselves, while they were looking elsewhere or away.
 *
 * Nothing is stored for it. The list is read from the ledger and the withdrawals table, which
 * already hold every one of these events with its amount and its time, so a notification can never
 * disagree with the wallet history it summarises. The one thing stored is how far the player has
 * read (users.notifications_read_at, migration 070), and the unread count is everything newer.
 *
 * Only what the player did not cause is here. A round's win, a claimed reward or a sale is shown
 * the moment it happens on the page that did it; a deposit landing from the game, a withdrawal the
 * bot has paid, a tip, an invite reaching its bar or a staff adjustment happens somewhere else, and
 * that is what a bell is for.
 *
 * Crowns (lib/crowns.ts) are news of the same kind and read the same way: a crown somebody else
 * took, or one whose round left the window, is an ended reign; a bounty won is a won bounty. Both
 * rows already exist, so the bell stores nothing for them either.
 */

/**
 * The ledger kinds that are news. Written out, not imported, because migration 070 builds a partial
 * index over exactly this list and the query below must repeat it word for word for Postgres to use
 * that index; a test holds the three together.
 */
export const NOTICE_KINDS = [
  'cash_deposit',
  'pay_login_deposit',
  'cash_withdrawal_refund',
  'tip_received',
  'referral_bonus',
  'race_payout',
  'faction_payout',
  'jackpot_win',
  'admin_adjustment',
  'discord_join_reward',
  'discord_tag_reward',
  'discord_invite_reward',
  'signup_bonus',
] as const;

const NOTICE_KIND_SET: ReadonlySet<string> = new Set(NOTICE_KINDS);

/** The kinds as the SQL list the partial index is declared over. */
export const NOTICE_KINDS_SQL = NOTICE_KINDS.map((kind) => `'${kind}'`).join(', ');

/** How far back the bell looks, and how much it shows. */
export const NOTICE_DAYS = 30;
export const NOTICE_LIMIT = 30;

export function isNoticeKind(kind: string): boolean {
  return NOTICE_KIND_SET.has(kind);
}

/**
 * Tells the player's open tabs to look. Delayed a beat like every live event, so the browser does
 * not race the COMMIT; the page re-reads once more shortly after in case it did.
 */
export function noticeSoon(userId: string): void {
  publishLiveSoon('notice', [userId]);
}

export interface NotificationItem {
  readonly id: string;
  /** A ledger kind from NOTICE_KINDS, 'withdrawal_paid', 'crown_lost', 'crown_expired' or 'bounty_won'. */
  readonly kind: string;
  readonly amountMinor: string;
  readonly at: string;
  readonly unread: boolean;
  /** Who sent a tip, or (masked) who took a crown. */
  readonly from: string | null;
  /** The in-game name a withdrawal was paid to. */
  readonly to: string | null;
  /** The game a crown or a bounty was on. */
  readonly game?: string | null;
  /** The crown that was lost, or the multiplier that won a bounty, in hundredths. */
  readonly multiplierX100?: string | null;
  /** The multiplier that took the crown, in hundredths. */
  readonly byMultiplierX100?: string | null;
}

/** Money waiting for the player to collect it. Shown above the list, never counted as unread. */
export interface ReadyItem {
  readonly kind: 'rakeback' | 'referrals';
  readonly amountMinor: string;
  readonly path: string;
}

export interface NotificationFeed {
  readonly items: readonly NotificationItem[];
  readonly unread: number;
  readonly readAt: string | null;
  readonly ready: readonly ReadyItem[];
}

export async function readNotifications(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<NotificationFeed> {
  const [user, ledger, paid, ready, crowns, bounties, poolDays, poolReleases] = await Promise.all([
    client.query<{ read_at: Date | null; referral_blocked: boolean }>(
      `SELECT notifications_read_at AS read_at, referral_blocked_at IS NOT NULL AS referral_blocked
         FROM users WHERE id = $1`,
      [userId],
    ),
    client.query<{
      id: string;
      kind: string;
      amount_minor: string;
      created_at: Date;
      from_name: string | null;
    }>(
      `SELECT t.id, t.kind, t.amount_minor::text AS amount_minor, t.created_at,
              s.minecraft_username AS from_name
         FROM wallet_transactions t
         LEFT JOIN player_tips p ON t.kind = 'tip_received' AND p.id = t.reference_id
         LEFT JOIN users s ON s.id = p.from_user_id
        WHERE t.user_id = $1
          AND t.kind IN (${NOTICE_KINDS_SQL})
          AND t.created_at >= now() - make_interval(days => $2)
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $3`,
      [userId, NOTICE_DAYS, NOTICE_LIMIT],
    ),
    client.query<{ id: string; amount_minor: string; payee_username: string; paid_at: Date }>(
      `SELECT id, amount_minor::text AS amount_minor, payee_username, paid_at
         FROM cash_withdrawals
        WHERE user_id = $1 AND status = 'paid'
          AND paid_at >= now() - make_interval(days => $2)
        ORDER BY paid_at DESC
        LIMIT $3`,
      [userId, NOTICE_DAYS, NOTICE_LIMIT],
    ),
    client.query<{ rakeback_minor: string | null; referrals_minor: string | null }>(
      `SELECT (SELECT accrued_minor - claimed_minor FROM rakeback_accruals
                WHERE user_id = $1 AND tier = 'instant')::text AS rakeback_minor,
              (SELECT sum(revshare_claimable_minor) FROM referrals
                WHERE referrer_id = $1 AND voided_at IS NULL)::text AS referrals_minor`,
      [userId],
    ),
    /* Crowns this player lost. Beating your own record ends your own reign, and is not news. */
    config.crownsEnabled
      ? client.query<{
          id: string;
          game: string;
          multiplier_x100: string;
          ended_at: Date;
          ended_reason: 'beaten' | 'expired';
          by_name: string | null;
          by_multiplier_x100: string | null;
        }>(
          `SELECT r.id, r.game, r.multiplier_x100::text AS multiplier_x100, r.ended_at, r.ended_reason,
                  CASE WHEN n.id IS NULL THEN NULL ELSE ${maskedName('nu.minecraft_username')} END AS by_name,
                  n.multiplier_x100::text AS by_multiplier_x100
             FROM crown_reigns r
             LEFT JOIN crown_reigns n ON n.id = r.ended_by
             LEFT JOIN users nu ON nu.id = n.user_id
            WHERE r.user_id = $1 AND r.ended_at IS NOT NULL
              AND r.ended_at >= now() - make_interval(days => $2)
              AND (n.id IS NULL OR n.user_id <> r.user_id)
            ORDER BY r.ended_at DESC
            LIMIT $3`,
          [userId, NOTICE_DAYS, NOTICE_LIMIT],
        )
      : Promise.resolve({ rows: [] }),
    config.crownsEnabled
      ? client.query<{
          id: string;
          game: string;
          prize_minor: string;
          winning_multiplier_x100: string;
          won_at: Date;
        }>(
          `SELECT id, game, prize_minor::text AS prize_minor,
                  winning_multiplier_x100::text AS winning_multiplier_x100, won_at
             FROM crown_bounties
            WHERE winner_user_id = $1 AND won_at >= now() - make_interval(days => $2)
            ORDER BY won_at DESC
            LIMIT $3`,
          [userId, NOTICE_DAYS, NOTICE_LIMIT],
        )
      : Promise.resolve({ rows: [] }),
    /* The house pool (lib/staking.ts): each settled day's result across the player's stakes, and
     * a stake paid back once it unlocked. Read whether or not the pool takes new stakes: what is
     * in keeps settling after it closes. */
    client.query<{ day: string; result_minor: string; settled_at: Date }>(
      `SELECT d.day::text AS day, sum(d.result_minor)::text AS result_minor, s.settled_at
         FROM staking_lot_days d JOIN staking_days s ON s.day = d.day
        WHERE d.user_id = $1 AND s.settled_at >= now() - make_interval(days => $2)
        GROUP BY d.day, s.settled_at
       HAVING sum(d.result_minor) <> 0
        ORDER BY s.settled_at DESC
        LIMIT $3`,
      [userId, NOTICE_DAYS, NOTICE_LIMIT],
    ),
    client.query<{ id: string; released_minor: string; closed_at: Date }>(
      `SELECT id, released_minor::text AS released_minor, closed_at
         FROM staking_lots
        WHERE user_id = $1 AND status = 'closed' AND closed_at >= now() - make_interval(days => $2)
        ORDER BY closed_at DESC
        LIMIT $3`,
      [userId, NOTICE_DAYS, NOTICE_LIMIT],
    ),
  ]);

  const readAt = user.rows[0]?.read_at ? new Date(user.rows[0].read_at) : null;
  // Compared as Dates, so both sides are at the browser's millisecond precision.
  const isUnread = (at: Date) => !readAt || at.getTime() > readAt.getTime();

  const merged: NotificationItem[] = [
    ...ledger.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      amountMinor: row.amount_minor,
      at: new Date(row.created_at).toISOString(),
      unread: isUnread(new Date(row.created_at)),
      from: row.from_name,
      to: null,
    })),
    ...paid.rows.map((row) => ({
      id: row.id,
      kind: 'withdrawal_paid',
      amountMinor: row.amount_minor,
      at: new Date(row.paid_at).toISOString(),
      unread: isUnread(new Date(row.paid_at)),
      from: null,
      to: row.payee_username,
    })),
    ...crowns.rows.map((row) => ({
      id: row.id,
      kind: row.ended_reason === 'expired' ? 'crown_expired' : 'crown_lost',
      amountMinor: '0',
      at: new Date(row.ended_at).toISOString(),
      unread: isUnread(new Date(row.ended_at)),
      from: row.by_name,
      to: null,
      game: row.game,
      multiplierX100: row.multiplier_x100,
      byMultiplierX100: row.by_multiplier_x100,
    })),
    ...bounties.rows.map((row) => ({
      id: row.id,
      kind: 'bounty_won',
      amountMinor: row.prize_minor,
      at: new Date(row.won_at).toISOString(),
      unread: isUnread(new Date(row.won_at)),
      from: null,
      to: null,
      game: row.game,
      multiplierX100: row.winning_multiplier_x100,
      byMultiplierX100: null,
    })),
    ...poolDays.rows.map((row) => ({
      id: `staking-day:${row.day}`,
      kind: 'staking_day',
      amountMinor: row.result_minor,
      at: new Date(row.settled_at).toISOString(),
      unread: isUnread(new Date(row.settled_at)),
      from: null,
      to: row.day,
    })),
    ...poolReleases.rows.map((row) => ({
      id: row.id,
      kind: 'staking_released',
      amountMinor: row.released_minor,
      at: new Date(row.closed_at).toISOString(),
      unread: isUnread(new Date(row.closed_at)),
      from: null,
      to: null,
    })),
  ];
  merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  const items = merged.slice(0, NOTICE_LIMIT);

  const readyItems: ReadyItem[] = [];
  const rakeback = BigInt(ready.rows[0]?.rakeback_minor ?? '0');
  if (config.rakebackEnabled && rakeback > 0n) {
    readyItems.push({ kind: 'rakeback', amountMinor: rakeback.toString(), path: '/rakeback' });
  }
  const referrals = BigInt(ready.rows[0]?.referrals_minor ?? '0');
  // A blocked referrer cannot claim, so the bell does not tell them there is something to claim.
  if (config.referralsEnabled && referrals > 0n && !user.rows[0]?.referral_blocked) {
    readyItems.push({ kind: 'referrals', amountMinor: referrals.toString(), path: '/referrals' });
  }

  return {
    items,
    unread: items.filter((item) => item.unread).length,
    readAt: readAt ? readAt.toISOString() : null,
    ready: readyItems,
  };
}

/**
 * Marks everything up to `until` read: the newest item the panel showed, not "now", so a notice
 * that lands while the panel is open is not marked read unseen. Never moves the marker backwards,
 * and never past the present.
 *
 * The extra millisecond is the browser's precision: an item stored at .123456 reaches it as .123,
 * and marking read "up to .123" would leave that very item unread.
 */
export async function markNotificationsRead(
  client: DbClient,
  userId: string,
  until: Date | null,
): Promise<string | null> {
  const result = await client.query<{ read_at: Date | null }>(
    `UPDATE users
        SET notifications_read_at = GREATEST(
              notifications_read_at,
              LEAST(COALESCE($2::timestamptz + interval '1 millisecond', now()), now()))
      WHERE id = $1
      RETURNING notifications_read_at AS read_at`,
    [userId, until ? until.toISOString() : null],
  );
  const readAt = result.rows[0]?.read_at;
  return readAt ? new Date(readAt).toISOString() : null;
}
