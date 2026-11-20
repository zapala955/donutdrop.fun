import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import { appendAudit } from './audit.js';
import type { Database } from './db.js';

/** Who receives the money when a bot goes down and another one is still online. */
export const FAILOVER_PAYEE = 'misterofthex';
/** How long a bot must have been unable to connect before the failover fires. */
export const FAILOVER_DOWN_AFTER_SECONDS = 180;
/** How often the bots are checked. */
const INTERVAL_MS = 30_000;
/** A /bal reading older than this is not trusted to size the payout. */
const READING_MAX_AGE_SECONDS = 10 * 60;

interface BotStateRow {
  id: string;
  username: string;
  server_host: string;
  tracked_balance_minor: string;
  observed_low: string | null;
  last_heartbeat_at: Date | null;
  live: boolean;
  down: boolean;
}

/**
 * Empties a still-connected bot into FAILOVER_PAYEE when another bot has been down for 3 minutes.
 *
 * "Down" means no heartbeat for FAILOVER_DOWN_AFTER_SECONDS. A connected bot heartbeats every 15
 * seconds and stops the moment its connection ends (and sends none while it cannot reconnect), so
 * a heartbeat that old means the account has not been on the server for that long. Only the
 * money-holding roles count (teller, vault, node): the stats bot holds nothing. A parked bot is
 * being played by hand and is skipped on both sides, and a bot that has never sent a heartbeat is
 * not counted as down because there is no outage to measure.
 *
 * The payout is an ordinary `admin_payout` job -- one /pay, confirmed by the server's receipt --
 * so it goes through the same worker code and the same completion path (including booking the
 * bot's out leg) as an operator payout, and shows up in the admin console's payout list.
 *
 * It fires ONCE per outage. The idempotency key names the down bot's last heartbeat, which does not
 * move until that bot comes back, so later ticks during the same outage find the row and skip. A
 * fresh outage after a reconnect has a new last heartbeat and therefore a new key.
 */
export function startBotFailover(
  db: Database,
  config: AppConfig,
  log: FastifyBaseLogger,
): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    const provisioned = [...config.botCredentials.keys()];
    // Failover needs at least one bot to be down and another to pay from.
    if (provisioned.length < 2) return;

    const state = await db.query<BotStateRow>(
      `SELECT id, username, server_host, tracked_balance_minor, last_heartbeat_at,
              CASE WHEN observed_balance_at > now() - make_interval(secs => $3)
                   THEN observed_balance_low_minor::text END AS observed_low,
              (status = 'online' AND last_heartbeat_at > now() - interval '45 seconds') AS live,
              (last_heartbeat_at IS NOT NULL
                AND last_heartbeat_at <= now() - make_interval(secs => $2)) AS down
         FROM bot_accounts
        WHERE id = ANY($1::uuid[]) AND role IN ('teller', 'vault', 'node')
          AND status <> 'quarantined' AND parked_at IS NULL
        ORDER BY id`,
      [provisioned, FAILOVER_DOWN_AFTER_SECONDS, READING_MAX_AGE_SECONDS],
    );
    /* Only rows that still match their provisioned identity count, on either side -- the same test
     * pickBot applies. A row whose name or server drifted is not trusted to be the account we
     * think it is, so it is neither paid from nor treated as an outage. */
    const trusted = state.rows.filter((row) => {
      const credentials = config.botCredentials.get(row.id);
      return (
        credentials &&
        row.username.toLowerCase() === credentials.username.toLowerCase() &&
        row.server_host.toLowerCase().replace(/\.$/, '') === credentials.serverHost
      );
    });
    const downBot = trusted.find((row) => row.down);
    if (!downBot?.last_heartbeat_at) return;
    const downSince = downBot.last_heartbeat_at;
    const payers = trusted.filter((row) => row.live && row.id !== downBot.id);

    for (const payer of payers) {
      const key = `failover:${downBot.id}:${downSince.getTime()}:${payer.id}`;
      /* The least the account is known to hold: its own fresh /bal when there is one, else the
       * tracked figure. Paying more than it holds would leave the payout unconfirmed. */
      const amount =
        payer.observed_low !== null
          ? BigInt(payer.observed_low)
          : BigInt(payer.tracked_balance_minor);
      if (amount <= 0n) continue;

      const queued = await db.transaction(async (client) => {
        const replay = await client.query(
          'SELECT 1 FROM admin_payouts WHERE idempotency_key = $1',
          [key],
        );
        if (replay.rowCount) return false;
        // One live payout per payee is enforced by a unique index; wait instead of raising.
        const live = await client.query(
          `SELECT 1 FROM admin_payouts
            WHERE lower(payee_username) = lower($1) AND status IN ('queued', 'processing')`,
          [FAILOVER_PAYEE],
        );
        if (live.rowCount) return false;
        const payee = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE normalized_username = lower($1)',
          [FAILOVER_PAYEE],
        );
        const payoutId = randomUUID();
        const reason = `Failover: ${downBot.username} could not connect for 3 minutes`;
        await client.query(
          `INSERT INTO admin_payouts
             (id, bot_id, actor_user_id, payee_username, payee_user_id, amount_minor, reason,
              idempotency_key)
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
          [
            payoutId,
            payer.id,
            FAILOVER_PAYEE,
            payee.rows[0]?.id ?? null,
            amount.toString(),
            reason,
            key,
          ],
        );
        await client.query(
          `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload)
           VALUES ($1, $2, 'admin_payout', $3, $4)`,
          [
            randomUUID(),
            payer.id,
            payoutId,
            JSON.stringify({ payoutId, payee: FAILOVER_PAYEE, amountMinor: amount.toString() }),
          ],
        );
        await appendAudit(client, config, {
          actorUserId: null,
          action: 'bot.failover_pay',
          targetType: 'admin_payout',
          targetId: payoutId,
          details: {
            reason,
            bot: payer.username,
            downBot: downBot.username,
            downSince: downSince.toISOString(),
            payee: FAILOVER_PAYEE,
            amountMinor: amount.toString(),
          },
        });
        return true;
      });
      if (queued) {
        log.warn(
          {
            bot: payer.username,
            down: downBot.username,
            payee: FAILOVER_PAYEE,
            amountMinor: amount.toString(),
          },
          'Bot failover payout queued',
        );
      }
    }
  };

  const timer = setInterval(() => {
    void (async () => {
      if (running) return;
      running = true;
      try {
        await tick();
      } catch (error) {
        log.error({ err: error }, 'Bot failover check failed');
      } finally {
        running = false;
      }
    })();
  }, INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
