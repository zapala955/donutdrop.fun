import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import { pickBot, queueVaultSweep, recordBotTransfer } from './bots.js';
import type { Database, DbClient } from './db.js';

/** How often the teller's reading is looked at. */
const INTERVAL_MS = 60_000;
/** A reading older than this says too little about now to act on. */
const READING_MAX_AGE_MS = 10 * 60_000;

/**
 * Empties the teller into the vault once it is holding enough to be worth taking.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHERE THE REAL BALANCE COMES FROM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DonutSMP's stats API used to answer that over HTTP. It was switched off, so the bots now ask the
 * server themselves with /bal and send the answer on their heartbeat (bot_accounts.observed_*).
 * DonutSMP abbreviates large figures and truncates them, so a reading is an interval -- the account
 * holds at least `low` and less than `low + step` -- and everything here works from `low`, which
 * under-sweeps rather than asking the teller for money it may not have.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHEN A READING CAN BE TRUSTED
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Only when it was taken AFTER the last money the platform booked on this bot. A deposit or a
 * payout that landed after the /bal is in the tracked figure and not in the reading, and
 * "correcting" the one by the other would book that movement a second time. Such a reading is
 * skipped, and the bot reads again a few seconds after every movement anyway.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND WHY IT CANNOT USE THE TRACKED FIGURE ALONE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `tracked_balance_minor` counts what has moved THROUGH the platform since the ledger began. On
 * an account that already held money when the feature was switched on it reads zero beside a real
 * balance of over a billion, so a sweep sized against it would move nothing at all and a float
 * check against it would send every withdrawal the long way round. The reading settles both. The
 * tracked figure is corrected as an `adjustment` row rather than overwritten, so the console's
 * Holding column and the withdrawal routing agree with the account itself.
 */
export function startTellerSweeper(
  db: Database,
  config: AppConfig,
  log: FastifyBaseLogger,
): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    await db.transaction(async (client) => {
      const teller = await pickBot(client, config, 'teller');
      // No teller online: there is nothing to read and nothing to sweep.
      if (!teller) return;
      const reading = await trustedReading(client, teller.id);
      // No reading yet, an old one, or one a booked movement has overtaken: wait for the next.
      if (!reading) return;

      /* Reconcile first, so the sweep about to be queued is sized against a balance the console
       * and the withdrawal router also believe. Booked rather than assigned: a corrected balance
       * that left no trace is a figure nobody can explain later. */
      const drift = reading.correctedTo - reading.tracked;
      if (drift !== 0n) {
        await recordBotTransfer(client, {
          botId: teller.id,
          direction: drift > 0n ? 'in' : 'out',
          counterparty: 'donutsmp',
          amountMinor: drift > 0n ? drift : -drift,
          reason: 'adjustment',
          note: `Balance read in game with /bal: ${reading.displayed}`,
        });
      }
      await queueVaultSweep(
        client,
        config,
        { id: teller.id, username: teller.username },
        reading.low,
      );
    });
  };

  const timer = setInterval(() => {
    /* Wrapped rather than passed as an async callback: setInterval discards the promise, so an
     * unhandled rejection in here would otherwise take the process down. */
    void (async () => {
      if (running) return;
      running = true;
      try {
        await tick();
      } catch (error) {
        /* Warn, not error: the next tick retries in a minute, and nothing about the platform is
         * broken meanwhile -- the money simply stays on the teller a little longer. */
        log.warn({ err: error }, 'Teller sweep check failed');
      } finally {
        running = false;
      }
    })();
  }, INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}

export interface TrustedReading {
  /** The least the account holds, per /bal. */
  low: bigint;
  /** What the tracked figure is. */
  tracked: bigint;
  /** What the tracked figure should be: unchanged if it already fits the reading, else `low`. */
  correctedTo: bigint;
  displayed: string;
}

/**
 * The bot's latest /bal, if it is fresh and was taken after the last booked movement on the bot.
 *
 * Read under the bot row's lock, in the caller's transaction, so no movement can be booked between
 * this check and the correction that follows it.
 */
export async function trustedReading(
  client: DbClient,
  botId: string,
): Promise<TrustedReading | undefined> {
  const row = await client.query<{
    tracked_balance_minor: string;
    observed_balance_low_minor: string | null;
    observed_balance_step_minor: string | null;
    observed_balance_display: string | null;
    fresh: boolean;
    after_last_movement: boolean;
  }>(
    `SELECT b.tracked_balance_minor, b.observed_balance_low_minor, b.observed_balance_step_minor,
            b.observed_balance_display,
            b.observed_balance_at > now() - ($2::integer * interval '1 millisecond') AS fresh,
            b.observed_balance_at > coalesce(
              (SELECT max(t.created_at) FROM bot_transfers t WHERE t.bot_id = b.id),
              '-infinity'::timestamptz) AS after_last_movement
       FROM bot_accounts b WHERE b.id = $1 FOR UPDATE`,
    [botId, READING_MAX_AGE_MS],
  );
  const bot = row.rows[0];
  if (!bot || bot.observed_balance_low_minor === null || bot.observed_balance_step_minor === null) {
    return undefined;
  }
  if (!bot.fresh || !bot.after_last_movement) return undefined;

  const low = BigInt(bot.observed_balance_low_minor);
  const step = BigInt(bot.observed_balance_step_minor);
  const tracked = BigInt(bot.tracked_balance_minor);
  /* Inside the reading's interval the tracked figure is as right as the reading can say, so it is
   * left alone -- otherwise every abbreviated reading would knock an exact figure down to the
   * floor of its band. Outside it, the floor is the one value the reading guarantees. */
  const fits = tracked >= low && tracked < low + step;
  return {
    low,
    tracked,
    correctedTo: fits ? tracked : low,
    displayed: bot.observed_balance_display ?? `$${low.toString()}`,
  };
}
