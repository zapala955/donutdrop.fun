import { randomInt, randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database, DbClient } from './db.js';
import { oldEnough } from './discord-rewards.js';
import { liveEvents } from './live-events.js';
import { networkHash } from './referral-network.js';
import { creditWallet } from './wallet.js';
import { addWagerRequirement, requirementFor } from './wager-requirements.js';

/**
 * code-drops.ts — a code in the Discord every two hours, for the first five to redeem it.
 *
 * The owner, 2026-11-11, replacing the daily codes: "the community bot [will] send a code every
 * 2 hours that gives 10m and only 5 ppl can claim it, wager req to withdraw it is 3x", with no
 * wager needed to claim. Every figure is a setting (codeDrop*), read when a drop is MINTED and
 * copied onto its row, so a change applies from the next drop and never to a code already posted.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHO DOES WHAT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The site mints, the bot posts, the site pays. The bot asks for the current drop every minute
 * (`codeDropTick`): the first ask in a slot mints it, and the first ask that finds it unannounced
 * takes it to post (`announce: true`, claimed by a guarded UPDATE before anything is sent, so two
 * ticks post it once). The bot then reports the message (`recordDropMessage`), or that the post
 * failed, which hands it back for a later tick. The bot never sees a balance and cannot claim.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE LIMIT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A claim is one transaction at READ COMMITTED: the drop row is locked, the count is raised by an
 * UPDATE that only succeeds while it is under the limit, the claim row is written (one per site
 * account and one per Discord account, by unique index) and the prize credited with its wager
 * requirement. A SERIALIZABLE snapshot would be taken before the lock wait and could not see the
 * claims that committed while it waited; here every statement after the lock sees them.
 *
 * A claimer must be signed in with a linked Discord account old enough for Discord rewards, like
 * every other reward the server pays: that is what keeps one person from taking all five.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Eight characters from an alphabet without 0, 1, I or O. `random` is injectable for tests. */
export function generateDropCode(random: (max: number) => number = (max) => randomInt(0, max)): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return code;
}

/** What somebody typed or pasted, reduced to the code it names, or null if it is not one. */
export function normalizeDropCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code) ? code : null;
}

/** The start of the slot `now` falls in: every `everyMinutes`, counted from the Unix epoch. */
export function slotStartOf(now: Date, everyMinutes: number): Date {
  const every = everyMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / every) * every);
}

interface DropRow {
  id: string;
  slot_start: Date;
  code: string;
  prize_minor: string;
  max_claims: number;
  claims: number;
  wager_multiplier: number;
  expires_at: Date;
  announced_at: Date | null;
  channel_id: string | null;
  message_id: string | null;
}

export interface DropView {
  readonly id: string;
  readonly code: string;
  readonly prizeMinor: string;
  readonly maxClaims: number;
  readonly claims: number;
  readonly wagerMultiplier: number;
  readonly slotStart: string;
  readonly expiresAt: string;
  readonly channelId: string | null;
  readonly messageId: string | null;
}

const view = (row: DropRow): DropView => ({
  id: row.id,
  code: row.code,
  prizeMinor: String(row.prize_minor),
  maxClaims: Number(row.max_claims),
  claims: Number(row.claims),
  wagerMultiplier: Number(row.wager_multiplier),
  slotStart: row.slot_start.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  channelId: row.channel_id,
  messageId: row.message_id,
});

const DROP_COLUMNS = `id, slot_start, code, prize_minor::text AS prize_minor, max_claims, claims,
  wager_multiplier, expires_at, announced_at, channel_id, message_id`;

/**
 * The bot's minute: the current slot's drop, minted if this is the first ask, and whether this ask
 * is the one that posts it. Null drop while code drops are switched off.
 */
export async function codeDropTick(
  db: Database,
  config: AppConfig,
  now: Date = new Date(),
): Promise<{ readonly enabled: boolean; readonly drop: DropView | null; readonly announce: boolean; readonly nextAt: string }> {
  const every = config.codeDropEveryMinutes;
  const slot = slotStartOf(now, every);
  const nextAt = new Date(slot.getTime() + every * 60_000).toISOString();
  if (!config.codeDropsEnabled) return { enabled: false, drop: null, announce: false, nextAt };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await db.query(
        `INSERT INTO discord_code_drops
           (id, slot_start, code, prize_minor, max_claims, wager_multiplier, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $2::timestamptz + ($7::integer * interval '1 minute'))
         ON CONFLICT (slot_start) DO NOTHING`,
        [
          randomUUID(),
          slot,
          generateDropCode(),
          config.codeDropPrizeMinor.toString(),
          config.codeDropMaxClaims,
          config.codeDropWagerMultiplier,
          every,
        ],
      );
      break;
    } catch (error) {
      // Two drops drawing the same eight characters: draw again.
      if ((error as { code?: string }).code !== '23505' || attempt === 4) throw error;
    }
  }

  // Taken to post by the first ask that finds it unannounced, and by no other.
  const taken = await db.query<DropRow>(
    `UPDATE discord_code_drops SET announced_at = now()
      WHERE slot_start = $1 AND announced_at IS NULL
      RETURNING ${DROP_COLUMNS}`,
    [slot],
  );
  if (taken.rows[0]) return { enabled: true, drop: view(taken.rows[0]), announce: true, nextAt };
  const current = await db.query<DropRow>(`SELECT ${DROP_COLUMNS} FROM discord_code_drops WHERE slot_start = $1`, [slot]);
  const row = current.rows[0];
  return { enabled: true, drop: row ? view(row) : null, announce: false, nextAt };
}

/**
 * The bot's report on a drop it took: where the message is, or that posting failed, which hands the
 * drop back so a later tick tries again (only while nothing is recorded as posted).
 */
export async function recordDropMessage(
  db: Database,
  input: { dropId: string } & ({ channelId: string; messageId: string } | { failed: true }),
): Promise<void> {
  if ('failed' in input) {
    await db.query(
      'UPDATE discord_code_drops SET announced_at = NULL WHERE id = $1 AND message_id IS NULL',
      [input.dropId],
    );
    return;
  }
  await db.query(
    'UPDATE discord_code_drops SET channel_id = $2, message_id = $3 WHERE id = $1',
    [input.dropId, input.channelId, input.messageId],
  );
}

export type DropRedeemResult =
  | {
      status: 'paid';
      prizeMinor: string;
      wagerMinor: string;
      username: string;
      claimsLeft: number;
      maxClaims: number;
    }
  | { status: 'refused'; reason: string; keepCode: boolean };

const refused = (reason: string, keepCode = false): DropRedeemResult => ({ status: 'refused', reason, keepCode });

/** Runs `work` at READ COMMITTED, retrying a deadlock (see the header for why not SERIALIZABLE). */
async function readCommitted<T>(db: Database, work: (client: DbClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && attempt < 2) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Redeems a drop code for the signed-in account `userId`.
 *
 * The refusals a player can act on keep the code (link your Discord first); the ones that end it
 * (claimed out, expired, already yours) do not. "No such code" and a mistyped one read the same.
 */
export async function redeemCodeDrop(
  db: Database,
  config: AppConfig,
  input: { userId: string; code: string; ip: string | undefined | null },
): Promise<DropRedeemResult> {
  if (!config.codeDropsEnabled) return refused('Code drops are switched off right now');
  const code = normalizeDropCode(input.code);
  if (!code) return refused('That is not a code. A code is eight letters and numbers');
  /* One claim per network and drop (migration 094; the owner, 2026-11-13: "a second account on the
   * same connection gets refused"). An address that cannot be read is refused rather than let
   * through, so the limit cannot be stepped round by sending something unreadable. */
  const network = networkHash(config, input.ip);
  if (!network) return refused('Your connection could not be checked. Try again', true);

  const outcome = await readCommitted(db, async (client): Promise<{ result: DropRedeemResult; paid: boolean }> => {
    const found = await client.query<DropRow & { expired: boolean }>(
      `SELECT ${DROP_COLUMNS}, expires_at <= now() AS expired
         FROM discord_code_drops WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const drop = found.rows[0];
    if (!drop) return { result: refused('That code is not valid. Check it against the post in the Discord'), paid: false };

    const account = await client.query<{
      id: string;
      minecraft_username: string;
      status: string;
      discord_user_id: string | null;
    }>(
      'SELECT id, minecraft_username, status, discord_user_id FROM users WHERE id = $1',
      [input.userId],
    );
    const user = account.rows[0];
    if (!user || user.status !== 'active') {
      return { result: refused('This account cannot redeem codes right now'), paid: false };
    }
    if (!user.discord_user_id) {
      return {
        result: refused(
          'Link your Discord account first: open the Discord page, get your link code and run /link in the server. Your code is kept',
          true,
        ),
        paid: false,
      };
    }
    if (!oldEnough(config, user.discord_user_id)) {
      return {
        result: refused(
          `Discord accounts younger than ${config.discordRewardMinAccountAgeDays} days cannot redeem codes`,
        ),
        paid: false,
      };
    }

    const mine = await client.query(
      'SELECT 1 FROM discord_code_drop_claims WHERE drop_id = $1 AND (user_id = $2 OR discord_user_id = $3)',
      [drop.id, user.id, user.discord_user_id],
    );
    if (mine.rows[0]) return { result: refused('You have already claimed this code. The next one drops soon'), paid: false };
    if (drop.expired) return { result: refused('That code has expired. A new one drops in the Discord every few hours'), paid: false };
    // Held by the drop's row lock above, and by the unique index on (drop_id, network_hash) besides.
    const sameNetwork = await client.query(
      'SELECT 1 FROM discord_code_drop_claims WHERE drop_id = $1 AND network_hash = $2',
      [drop.id, network],
    );
    if (sameNetwork.rows[0]) {
      return {
        result: refused('This code was already claimed from your connection. One claim per connection on each drop'),
        paid: false,
      };
    }

    // The limit, held by the row lock above and this guard together.
    const counted = await client.query<{ claims: number }>(
      `UPDATE discord_code_drops SET claims = claims + 1
        WHERE id = $1 AND claims < max_claims RETURNING claims`,
      [drop.id],
    );
    const claims = counted.rows[0]?.claims;
    if (claims === undefined) {
      return {
        result: refused(`All ${drop.max_claims} claims on this code are gone. Be quicker on the next drop`),
        paid: false,
      };
    }

    const prize = BigInt(drop.prize_minor);
    const owed = requirementFor(prize, Number(drop.wager_multiplier));
    const claimId = randomUUID();
    await client.query(
      `INSERT INTO discord_code_drop_claims (id, drop_id, user_id, discord_user_id, prize_minor, wager_minor, network_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [claimId, drop.id, user.id, user.discord_user_id, prize.toString(), owed.toString(), network],
    );
    /* The ledger kind the daily codes used: a Discord code reward, as the history and the admin
     * totals already name it. Keyed on the claim, so no claim is ever paid twice. */
    await creditWallet(client, user.id, prize, 'daily_code_reward', claimId);
    await addWagerRequirement(client, user.id, owed);
    return {
      result: {
        status: 'paid',
        prizeMinor: prize.toString(),
        wagerMinor: owed.toString(),
        username: user.minecraft_username,
        claimsLeft: Number(drop.max_claims) - Number(claims),
        maxClaims: Number(drop.max_claims),
      },
      paid: true,
    };
  });

  // After the commit, so a card that refetches its balance sees the prize.
  if (outcome.paid) liveEvents.publish('balance', [input.userId]);
  return outcome.result;
}

/**
 * What the site shows about code drops: the figures the next drop will carry, when it drops, and how
 * many claims are left on the current one (never the code: that is the Discord post's to give).
 */
export async function codeDropStatus(
  db: Pick<Database, 'query'>,
  config: AppConfig,
  now: Date = new Date(),
): Promise<{
  readonly enabled: boolean;
  readonly prizeMinor: string;
  readonly maxClaims: number;
  readonly wagerMultiplier: number;
  readonly everyMinutes: number;
  readonly nextAt: string;
  readonly current: { readonly claimsLeft: number; readonly maxClaims: number; readonly expiresAt: string } | null;
}> {
  const every = config.codeDropEveryMinutes;
  const slot = slotStartOf(now, every);
  const current = config.codeDropsEnabled
    ? await db.query<{ claims: number; max_claims: number; expires_at: Date }>(
        `SELECT claims, max_claims, expires_at FROM discord_code_drops
          WHERE slot_start = $1 AND message_id IS NOT NULL AND expires_at > now()`,
        [slot],
      )
    : null;
  const row = current?.rows[0];
  return {
    enabled: config.codeDropsEnabled,
    prizeMinor: config.codeDropPrizeMinor.toString(),
    maxClaims: config.codeDropMaxClaims,
    wagerMultiplier: config.codeDropWagerMultiplier,
    everyMinutes: every,
    nextAt: new Date(slot.getTime() + every * 60_000).toISOString(),
    current: row
      ? {
          claimsLeft: Number(row.max_claims) - Number(row.claims),
          maxClaims: Number(row.max_claims),
          expiresAt: row.expires_at.toISOString(),
        }
      : null,
  };
}
