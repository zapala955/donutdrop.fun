import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import { pickBot, queueVaultSweep, recordBotTransfer } from './bots.js';
import type { Database } from './db.js';
import { DonutSmpApi, MONEY_MINOR_SCALE } from './donutsmp-api.js';

/** How often the teller's real balance is read. */
const INTERVAL_MS = 60_000;

/**
 * Empties the teller into the vault once it is holding enough to be worth taking.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A TIMER AND NOT PART OF THE DEPOSIT PATH
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The decision needs the bot's REAL in-game balance, and the only source for that is an HTTP call
 * to DonutSMP. Making that call from inside the transaction that credits a deposit would hold row
 * locks open across a network round trip with an eight second timeout, on the hottest path the
 * platform has. So the sweep moved out here, where it can take as long as it takes and a slow or
 * unreachable stats API delays a transfer instead of stalling somebody's deposit.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * AND WHY IT CANNOT USE THE TRACKED FIGURE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `tracked_balance_minor` counts what has moved THROUGH the platform since the ledger began. On
 * an account that already held money when the feature was switched on it reads zero beside a real
 * balance of over a billion, so a sweep sized against it would move nothing at all and a float
 * check against it would send every withdrawal the long way round. The real balance settles both.
 *
 * The tracked figure is corrected here too, as an `adjustment` row rather than an overwrite, so
 * the console's Holding column and the withdrawal routing agree with the account itself.
 */
export function startTellerSweeper(
  db: Database,
  config: AppConfig,
  log: FastifyBaseLogger,
): () => void {
  const donutsmp = new DonutSmpApi(config);
  let running = false;

  const tick = async (): Promise<void> => {
    if (!donutsmp.configured) return;
    const teller = await db.transaction((client) => pickBot(client, config, 'teller'));
    // No teller online: there is nothing to read a balance from and nothing to sweep.
    if (!teller) return;

    /* Outside any transaction, deliberately. This is the slow part. */
    const hundredths = await donutsmp.fetchMoneyMinor(teller.username);
    // DonutSMP reports hundredths; every figure in this ledger is a whole dollar.
    const real = hundredths / MONEY_MINOR_SCALE;

    await db.transaction(async (client) => {
      /* Reconcile first, so the sweep about to be queued is sized against a balance the console
       * and the withdrawal router also believe. The difference is booked rather than assigned --
       * a corrected balance that left no trace is a figure nobody can explain later. */
      const drift = real - teller.trackedBalanceMinor;
      if (drift !== 0n) {
        await recordBotTransfer(client, {
          botId: teller.id,
          direction: drift > 0n ? 'in' : 'out',
          counterparty: 'donutsmp',
          amountMinor: drift > 0n ? drift : -drift,
          reason: 'adjustment',
          note: 'Balance read from the DonutSMP stats API',
        });
      }
      await queueVaultSweep(client, config, { id: teller.id, username: teller.username }, real);
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
        /* Warn, not error. A stats API that is rate-limiting or briefly down is ordinary, the
         * next tick retries in a minute, and nothing about the platform is broken meanwhile --
         * the money simply stays on the teller a little longer. */
        log.warn({ err: error }, 'Teller sweep check failed');
      } finally {
        running = false;
      }
    })();
  }, INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
