import { randomUUID } from 'node:crypto';
import { creditWallet } from './cash-settlement.js';
import type { DbClient } from './db.js';

/**
 * creator-royalties.ts — paying the author of a community crate.
 *
 * One implementation, called from both places a crate can be opened: a solo open in
 * routes/cases.ts and a battle reel in routes/battles.ts. It lived inside the battle route first,
 * which meant a creator earned from battles and nothing at all from someone opening their crate
 * on the crates page — the commoner of the two by far.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ROYALTY COMES OUT OF THE HOUSE MARGIN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Never off the top of the price. A community crate is priced at EV / 0.90 exactly like a
 * first-party one, so the player faces the same 90% return either way; the creator's basis points
 * are carved from the ten the platform keeps. A player cannot pay more, or win less, because the
 * crate they opened happened to be written by somebody else.
 *
 * Every payment is keyed on the event that caused it, so a retried settlement collides on the
 * ledger's UNIQUE (kind, reference_id) rather than paying the creator twice.
 */

export type RoyaltySource = 'case_open' | 'battle';

export interface RoyaltyResult {
  readonly paid: boolean;
  readonly amountMinor: bigint;
  readonly creatorUserId: string | null;
}

interface CrateRow {
  creator_user_id: string | null;
  royalty_bps: number;
  price_minor: string;
}

/**
 * Pays the creator for one or more opens of one crate, and moves the marketplace counters.
 *
 * @param client        the transaction the open is already running in — the royalty must commit
 *                      or roll back with the open, never separately
 * @param caseId        the crate that was opened
 * @param payerUserId   who opened it, recorded for the creator's own breakdown
 * @param source        where the open happened
 * @param referenceId   a DETERMINISTIC uuid for the causing event. Same event, same id, so a
 *                      retry is a no-op instead of a second payment.
 * @param openCount     how many times the crate was opened by this event. A battle rolls one
 *                      crate once per seat, and each of those is an open.
 */
export async function payCreatorRoyalty(
  client: DbClient,
  caseId: string,
  payerUserId: string | null,
  source: RoyaltySource,
  referenceId: string,
  openCount = 1,
): Promise<RoyaltyResult> {
  if (!Number.isInteger(openCount) || openCount < 1) {
    throw new RangeError(`openCount must be a positive integer, received ${openCount}`);
  }

  const crate = await client.query<CrateRow>(
    `SELECT creator_user_id, royalty_bps, price_minor FROM cases WHERE id = $1`,
    [caseId],
  );
  const row = crate.rows[0];

  /* A first-party crate has no creator and no royalty. The counters still move: "most opened"
   * should mean most opened, whoever wrote it. */
  const price = BigInt(row?.price_minor ?? '0');
  const volume = price * BigInt(openCount);

  if (!row?.creator_user_id || row.royalty_bps <= 0) {
    if (row) await bumpCounters(client, caseId, 0n, openCount, volume);
    return { paid: false, amountMinor: 0n, creatorUserId: null };
  }

  const amount = (volume * BigInt(row.royalty_bps)) / 10_000n;
  if (amount <= 0n) {
    await bumpCounters(client, caseId, 0n, openCount, volume);
    return { paid: false, amountMinor: 0n, creatorUserId: row.creator_user_id };
  }

  /* Insert first and let the unique constraint arbitrate. Checking for an existing row and then
   * inserting would be a read-then-write race: two concurrent retries could both find nothing and
   * both pay. Nothing inserted means this event already paid, so there is nothing more to do. */
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO creator_royalties
       (id, case_id, creator_user_id, payer_user_id, case_price_minor, royalty_bps,
        amount_minor, source, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (reference_id) DO NOTHING
     RETURNING id`,
    [
      randomUUID(), caseId, row.creator_user_id, payerUserId, row.price_minor,
      row.royalty_bps, amount.toString(), source, referenceId,
    ],
  );
  if (inserted.rows.length === 0) {
    return { paid: false, amountMinor: 0n, creatorUserId: row.creator_user_id };
  }

  await creditWallet(client, row.creator_user_id, amount, 'creator_royalty', referenceId);
  await bumpCounters(client, caseId, amount, openCount, volume);

  return { paid: true, amountMinor: amount, creatorUserId: row.creator_user_id };
}

/**
 * The marketplace's denormalised counters.
 *
 * Kept on the row rather than recomputed, because "most opened" and "highest volume" are the two
 * default sorts and deriving them from case_rounds on every marketplace load would scan the whole
 * round history. They move inside the open's own transaction, so they cannot drift from it.
 */
async function bumpCounters(
  client: DbClient,
  caseId: string,
  royaltyMinor: bigint,
  openCount: number,
  volumeMinor: bigint,
): Promise<void> {
  await client.query(
    `UPDATE cases
        SET opens_count = opens_count + $2,
            volume_minor = volume_minor + $3,
            royalties_paid_minor = royalties_paid_minor + $4,
            updated_at = now()
      WHERE id = $1`,
    [caseId, openCount, volumeMinor.toString(), royaltyMinor.toString()],
  );
}
