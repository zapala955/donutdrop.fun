import { randomUUID, randomInt } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';
import { creditWallet } from './wallet.js';

/**
 * jackpot.ts — the server-wide vault pot.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BAR COUNTS UP BECAUSE THE POT DOES, NOT THE OTHER WAY ROUND
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The obvious build for a jackpot bar is a number that ticks upward in the browser and a "winner"
 * chosen when it looks full. That is a slot machine with no slot in it. Here the bar is a readout
 * of `vault_jackpot.pot_minor`, a real balance that a real share of every wager's margin is added
 * to inside the same transaction that settles the wager — so the figure on screen is money the
 * house has actually set aside, and the payout comes out of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DRAW IS PROPORTIONAL TO THE WAGER, AND IT IS AUDITABLE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A flat per-round chance would pay the same odds to a $10 crate open and a $50M arena buy-in,
 * which makes the correct strategy "open the cheapest thing you can as fast as you can" and turns
 * the jackpot into a click contest. So the chance is the wager over a fixed divisor: stake twice as
 * much, get twice the chance, exactly.
 *
 *     threshold = min(wagerMinor, cap)      roll = uniform [0, divisor)      hit when roll < threshold
 *
 * Both numbers are written to `vault_jackpot_wins`. The divisor is published. Anyone can therefore
 * check that a win they were told about really cleared the bar it claimed to, which is the whole
 * difference between a jackpot and an announcement.
 *
 * The cap exists because without it a single wager larger than the divisor is a guaranteed win, and
 * the largest legal arena buy-in is not far off the kind of number an operator might set a divisor
 * to by mistake.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THE MONEY COMES FROM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The house margin, like rakeback, the VIP ladder and the referral share — not a surcharge on the
 * stake. `assertVipSolvency` counts this rate alongside those three and refuses to boot if the
 * combination exceeds the platform's thinnest edge.
 */

/** Accrual and draw for one wager. Both are no-ops when the feature is off. */
export interface JackpotOutcome {
  /** What this wager added to the pot. */
  readonly contributedMinor: bigint;
  /** Set only when the draw hit. The money is already in the winner's wallet by then. */
  readonly win: {
    readonly id: string;
    readonly amountMinor: bigint;
  } | null;
}

const NOTHING: JackpotOutcome = { contributedMinor: 0n, win: null };

/**
 * Adds a wager's share to the pot and draws for it, inside the caller's transaction.
 *
 * Called from `recordWager`, which every game mode settles through, so a mode cannot be added that
 * contributes to the pot without being able to win it or vice versa.
 *
 * The row is locked with `FOR UPDATE` before it is read. Two crate opens settling at the same
 * instant would otherwise both read the same pot, both add to it, and the second write would
 * clobber the first — a read-then-write on a single shared counter is the textbook version of this
 * bug and the one place on this platform where every player's money is in one row.
 */
export async function accrueAndDrawJackpot(
  client: DbClient,
  config: AppConfig,
  userId: string,
  wagerMinor: bigint,
  marginMinor: bigint,
  source: string,
  referenceId: string,
): Promise<JackpotOutcome> {
  if (!config.vaultJackpotEnabled || wagerMinor <= 0n) return NOTHING;

  /* A share of VOLUME — the brief's "0.1% of all platform volume" — which against the thinnest
   * configured edge is about a fifth of the round's margin. It is funded BY the house out of that
   * margin rather than added to the stake: the player pays exactly what the game says it costs and
   * the pot is the house's own money set aside. `marginMinor` is carried into the wager log beside
   * it so the two can be reconciled without re-deriving an edge the mode may not charge. */
  void marginMinor;
  const contributed = (wagerMinor * BigInt(config.vaultJackpotContributionBps)) / 10_000n;

  const locked = await client.query<{ pot_minor: string; seed_minor: string }>(
    'SELECT pot_minor, seed_minor FROM vault_jackpot WHERE id = true FOR UPDATE',
  );
  const row = locked.rows[0];
  if (!row) return NOTHING;

  const potAfterContribution = BigInt(row.pot_minor) + contributed;
  /* The seed is read from CONFIGURATION and mirrored onto the row, not read back off it. The column
   * exists so the bar can show what the pot will reset to without the client being told the whole
   * configuration; making it the source of truth would mean an operator changing the seed had no
   * effect until somebody won, which is the one moment nobody wants a surprise. */
  const seed = config.vaultJackpotSeedMinor;

  /* The divisor is bounded to 1e15 by configuration, which keeps it inside both a double's exact
   * integer range and randomInt's own 2^48 ceiling, so neither conversion below can lose a bit. */
  const divisor = config.vaultJackpotOddsDivisorMinor;
  const cap = divisor / 2n; // no single wager may be better than even money
  const threshold = wagerMinor < cap ? wagerMinor : cap;
  /* randomInt is the CSPRNG, not Math.random. This decides who gets the whole pot, and a
   * predictable draw is one somebody times their wagers against. */
  const roll = BigInt(randomInt(0, Number(divisor)));
  const hit = roll < threshold && potAfterContribution > 0n;

  if (!hit) {
    await client.query(
      `UPDATE vault_jackpot
          SET pot_minor = $1, seed_minor = $3,
              lifetime_contributed_minor = lifetime_contributed_minor + $2,
              updated_at = now()
        WHERE id = true`,
      [potAfterContribution.toString(), contributed.toString(), seed.toString()],
    );
    return { contributedMinor: contributed, win: null };
  }

  /* The pot is paid WHOLE and reset to its seed. A partial payout would leave the bar looking like
   * it had barely moved after somebody won, which reads as a rigged bar to everyone watching. */
  const amount = potAfterContribution;
  const winId = randomUUID();
  await client.query(
    `UPDATE vault_jackpot
        SET pot_minor = $1, seed_minor = $1,
            lifetime_contributed_minor = lifetime_contributed_minor + $2,
            lifetime_paid_minor = lifetime_paid_minor + $3,
            updated_at = now()
      WHERE id = true`,
    [seed.toString(), contributed.toString(), amount.toString()],
  );
  await client.query(
    `INSERT INTO vault_jackpot_wins
       (id, user_id, amount_minor, source, reference_id, wager_minor, roll, threshold)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      winId,
      userId,
      amount.toString(),
      source,
      referenceId,
      wagerMinor.toString(),
      roll.toString(),
      threshold.toString(),
    ],
  );
  await creditWallet(client, userId, amount, 'jackpot_win', winId);

  return { contributedMinor: contributed, win: { id: winId, amountMinor: amount } };
}

/** The pot, for the header bar. Readable logged out. */
export async function readJackpot(client: DbClient): Promise<{
  potMinor: string;
  seedMinor: string;
  lifetimePaidMinor: string;
}> {
  const result = await client.query<{
    pot_minor: string;
    seed_minor: string;
    lifetime_paid_minor: string;
  }>('SELECT pot_minor, seed_minor, lifetime_paid_minor FROM vault_jackpot WHERE id = true');
  const row = result.rows[0];
  return {
    potMinor: row?.pot_minor ?? '0',
    seedMinor: row?.seed_minor ?? '0',
    lifetimePaidMinor: row?.lifetime_paid_minor ?? '0',
  };
}
