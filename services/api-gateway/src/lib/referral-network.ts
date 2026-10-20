import { isIPv4, isIPv6 } from 'node:net';
import type { AppConfig } from '../config.js';
import { appendAudit } from './audit.js';
import { hmacHex } from './crypto.js';
import type { DbClient } from './db.js';

/**
 * Invites between accounts on the same network.
 *
 * The referral bonus is worth more than the wager that unlocks it, so the cheapest way to collect
 * it is to invite yourself. Two accounts that have used the same connection are, far more often
 * than not, one person: when an invite joins two such accounts, that invite is voided and pays
 * nothing, ever. Only that invite: both accounts stay in the programme and go on earning from every
 * other player they invite (until 2026-10-20 both were blocked as well; migration 074 lifted those
 * blocks). An administrator can restore the invite.
 *
 * It is checked when the invite is made (sign-up link, or the code entered in Settings) and again
 * at each moment referral money moves (the milestone bonus, a revenue-share claim), because the
 * alt that signed up on mobile data and plays on the home Wi-Fi only shows itself later.
 *
 * Known limit, and the reason for the administrator's override: a shared network is also a family,
 * a flat, a school, or a mobile carrier that puts many customers behind one IPv4 address.
 */

/** Two accounts' use of one network counts when it falls within this many days of each other. */
export const SAME_NETWORK_WINDOW_DAYS = 30;

/** What an automatic void says about itself, for the admin console and the audit. */
export const SAME_NETWORK_REASON = 'Automatic: the invited account shares a network with its inviter';

/**
 * The network an address belongs to, as the text that is hashed.
 *
 * IPv4 as it is: the same text sign-in has always hashed into `sessions.ip_hash`, so the two can be
 * compared. IPv6 by its /64, the block one household or one phone is given, because a device
 * rotates the rest of its address daily and the alt on the same machine would otherwise look like
 * a stranger by tomorrow. Null for anything that is not an address.
 */
export function networkOf(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const bare = ip.trim().split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped?.[1] && isIPv4(mapped[1])) return publicIPv4(mapped[1]);
  if (isIPv4(bare)) return publicIPv4(bare);
  if (!isIPv6(bare)) return null;
  const hextets = expandIPv6(bare);
  if (!hextets) return null;
  // NAT64 (64:ff9b::/96) carries an IPv4 address; that address is the network.
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((part) => part === 0)) {
    const [high, low] = [hextets[6] ?? 0, hextets[7] ?? 0];
    return publicIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  /* Loopback, link-local and unique-local (fc00::/7) are never a player's connection to the
   * internet. Seen here they mean the proxy chain is handing over its own address, and counting
   * that would make every player look like one person. */
  const first = hextets[0] ?? 0;
  if (hextets.slice(0, 7).every((part) => part === 0) || (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00) {
    return null;
  }
  return `${hextets.slice(0, 4).map((part) => part.toString(16)).join(':')}::/64`;
}

/** An IPv4 address that can be somebody's connection to the internet; null for private ranges. */
function publicIPv4(ip: string): string | null {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  const internal =
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, the inside of a carrier's network
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || // Docker's own networks live here
    (a === 192 && b === 168);
  return internal ? null : ip;
}

/** The eight 16-bit groups of a valid IPv6 address, an embedded IPv4 tail included. */
function expandIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  const numbers = parts.map((part) => Number.parseInt(part, 16));
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? numbers
    : null;
}

/** The keyed hash stored for a network. Never the address itself. */
export function networkHash(config: AppConfig, ip: string | undefined | null): Buffer | null {
  const network = networkOf(ip);
  return network ? Buffer.from(hmacHex(config.ipHashKey, network), 'hex') : null;
}

type Queryable = Pick<DbClient, 'query'>;

/**
 * Notes that an account is using the network this request came from.
 *
 * At most one write an hour per account and network: a repeat inside the hour finds the row fresh
 * and the conditional update changes nothing.
 */
export async function recordNetwork(
  client: Queryable,
  config: AppConfig,
  userId: string,
  ip: string | undefined | null,
): Promise<void> {
  const hash = networkHash(config, ip);
  if (!hash) return;
  await client.query(
    `INSERT INTO user_networks (user_id, network_hash) VALUES ($1, $2)
     ON CONFLICT (user_id, network_hash) DO UPDATE SET last_seen_at = now()
      WHERE user_networks.last_seen_at < now() - interval '1 hour'`,
    [userId, hash],
  );
}

/**
 * Whether an administrator has blocked the inviter from earning from invites, and whether the two
 * accounts have shared a network within the window. A missing answer reads as "no" on both counts.
 */
export async function referralStanding(
  client: Queryable,
  refereeId: string,
  referrerId: string,
): Promise<{ referrerBlocked: boolean; sharedNetwork: boolean }> {
  const result = await client.query<{ referrer_blocked: boolean | null; shared_network: boolean | null }>(
    `SELECT (SELECT referral_blocked_at IS NOT NULL FROM users WHERE id = $2) AS referrer_blocked,
            EXISTS (
              SELECT 1
                FROM user_networks a
                JOIN user_networks b ON b.network_hash = a.network_hash AND b.user_id = $2
               WHERE a.user_id = $1
                 AND a.first_seen_at <= b.last_seen_at + make_interval(days => $3)
                 AND b.first_seen_at <= a.last_seen_at + make_interval(days => $3)
            ) AS shared_network`,
    [refereeId, referrerId, SAME_NETWORK_WINDOW_DAYS],
  );
  const row = result.rows[0];
  return { referrerBlocked: row?.referrer_blocked === true, sharedNetwork: row?.shared_network === true };
}

/** Whether an administrator has blocked this account from the referral programme. */
export async function referralBlocked(client: Queryable, userId: string): Promise<boolean> {
  const result = await client.query<{ blocked: boolean }>(
    'SELECT referral_blocked_at IS NOT NULL AS blocked FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.blocked === true;
}

/**
 * Voids the invite, in the caller's transaction. Neither account is blocked: each goes on earning
 * from the other players it invites.
 *
 * Marked, not deleted, as every void is: the row keeps who invited whom and what it had banked, so
 * the decision can be reviewed. Nothing already paid is taken back; that is a wallet adjustment an
 * administrator makes on purpose, never a side effect.
 */
export async function voidSameNetworkReferral(
  client: DbClient,
  config: AppConfig,
  refereeId: string,
  referrerId: string,
  moment: 'invite' | 'milestone' | 'claim',
): Promise<void> {
  const voided = await client.query<{ revshare_claimable_minor: string }>(
    `UPDATE referrals
        SET voided_at = now(), voided_by = NULL, void_reason = $2, updated_at = now()
      WHERE referee_id = $1 AND voided_at IS NULL
      RETURNING revshare_claimable_minor`,
    [refereeId, SAME_NETWORK_REASON],
  );
  await appendAudit(client, config, {
    actorUserId: null,
    action: 'referral.same_network',
    targetType: 'referral',
    targetId: refereeId,
    details: {
      refereeId,
      referrerId,
      moment,
      // What stopped being claimable, recorded at the moment it did.
      claimableMinor: voided.rows[0]?.revshare_claimable_minor ?? '0',
    },
  });
}
