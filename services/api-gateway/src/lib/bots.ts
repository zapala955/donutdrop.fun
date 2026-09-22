import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { DbClient } from './db.js';

/**
 * Which of the two bots does what.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE VAULT'S USERNAME IS NEVER RENDERED TO A PLAYER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * That is the entire reason this split exists. The teller is the name on the deposit screen, the
 * name a login nonce is paid to and the name a withdrawal arrives from; the vault is where the
 * balance actually sits. Anything that returns a username to a browser asks for a teller, and
 * only the job payloads the bots read among themselves ever carry the vault's.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A DEPLOYMENT WITH ONE BOT IS A SUPPORTED DEPLOYMENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `role` defaults to 'teller', so a platform that has never provisioned a second account has a
 * teller and no vault. Every function here returns null for a missing vault rather than throwing,
 * and every caller treats that as "pay directly, as before". The second bot is opt-in and the
 * site keeps working until the day it is switched on.
 */
export type BotRole = 'teller' | 'vault';

export interface SelectedBot {
  readonly id: string;
  readonly username: string;
  readonly trackedBalanceMinor: bigint;
}

interface BotRow {
  id: string;
  username: string;
  server_host: string;
  tracked_balance_minor: string;
}

/**
 * The online bot holding this role, or null.
 *
 * "Online" is the same test the rest of the platform uses -- a live heartbeat AND an identity
 * that matches what BOT_CREDENTIALS_JSON says it should be. A row whose username has drifted from
 * its provisioned identity is not trusted to be the account we think it is, so it is skipped
 * rather than used.
 */
export async function pickBot(
  client: DbClient,
  config: AppConfig,
  role: BotRole,
): Promise<SelectedBot | null> {
  const provisioned = [...config.botCredentials.keys()];
  if (!provisioned.length) return null;
  const result = await client.query<BotRow>(
    `SELECT id, username, server_host, tracked_balance_minor
       FROM bot_accounts
      WHERE id = ANY($1::uuid[]) AND role = $2 AND status = 'online'
        AND last_heartbeat_at > now() - interval '45 seconds'
      ORDER BY last_heartbeat_at DESC`,
    [provisioned, role],
  );
  const match = result.rows.find((candidate) => {
    const credentials = config.botCredentials.get(candidate.id);
    return (
      credentials &&
      candidate.username.toLowerCase() === credentials.username.toLowerCase() &&
      candidate.server_host.toLowerCase().replace(/\.$/, '') === credentials.serverHost
    );
  });
  return match
    ? {
        id: match.id,
        username: match.username,
        trackedBalanceMinor: BigInt(match.tracked_balance_minor),
      }
    : null;
}

/**
 * The vault, online or not.
 *
 * A withdrawal that needs the vault queues its job whatever the vault is currently doing: the row
 * sits in `bot_jobs` until the vault reconnects and claims it, which is what a job queue is for.
 * Requiring the vault to be online at the moment somebody presses withdraw would turn a delay
 * into a refusal, and the player's money is already debited by then.
 */
export async function findVaultBot(
  client: DbClient,
  config: AppConfig,
): Promise<SelectedBot | null> {
  const provisioned = [...config.botCredentials.keys()];
  if (!provisioned.length) return null;
  const result = await client.query<BotRow>(
    `SELECT id, username, server_host, tracked_balance_minor
       FROM bot_accounts
      WHERE id = ANY($1::uuid[]) AND role = 'vault'
      ORDER BY last_heartbeat_at DESC NULLS LAST
      LIMIT 1`,
    [provisioned],
  );
  const row = result.rows[0];
  if (!row) return null;
  const credentials = config.botCredentials.get(row.id);
  if (!credentials || row.username.toLowerCase() !== credentials.username.toLowerCase()) {
    return null;
  }
  return {
    id: row.id,
    username: row.username,
    trackedBalanceMinor: BigInt(row.tracked_balance_minor),
  };
}

export type TransferReason =
  | 'deposit'
  | 'login'
  | 'sweep'
  | 'release'
  | 'withdrawal'
  | 'admin_payout'
  | 'adjustment';

export interface BotTransferInput {
  readonly botId: string;
  readonly direction: 'in' | 'out';
  readonly counterparty: string;
  readonly counterpartyBotId?: string | null;
  readonly amountMinor: bigint;
  readonly reason: TransferReason;
  readonly referenceId?: string | null;
  readonly userId?: string | null;
  readonly note?: string | null;
  readonly actorUserId?: string | null;
}

/**
 * Books one movement of money into or out of a bot, and returns the balance it produced.
 *
 * The running total on `bot_accounts` and the row in `bot_transfers` are written in one statement
 * pair under the bot's own row lock, so the balance a transfer records is the balance that
 * transfer created -- the same arrangement `user_wallets` and `wallet_transactions` have.
 *
 * Idempotent on (bot, direction, reason, reference). A bot re-reporting a receipt after a
 * reconnect, or a job result replayed against an expired lease, books nothing the second time and
 * returns null to say so. Callers use that to avoid queueing a follow-up twice.
 */
export async function recordBotTransfer(
  client: DbClient,
  input: BotTransferInput,
): Promise<bigint | null> {
  const signed = input.direction === 'in' ? input.amountMinor : -input.amountMinor;
  const updated = await client.query<{ tracked_balance_minor: string }>(
    `UPDATE bot_accounts SET tracked_balance_minor = tracked_balance_minor + $2,
            updated_at = now()
      WHERE id = $1
      RETURNING tracked_balance_minor`,
    [input.botId, signed.toString()],
  );
  const balanceAfter = updated.rows[0]?.tracked_balance_minor;
  if (balanceAfter === undefined) throw new Error('Bot transfer targeted a bot that does not exist');

  const inserted = await client.query(
    `INSERT INTO bot_transfers
       (id, bot_id, direction, counterparty, counterparty_bot_id, amount_minor,
        balance_after_minor, reason, reference_id, user_id, note, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      input.botId,
      input.direction,
      input.counterparty,
      input.counterpartyBotId ?? null,
      input.amountMinor.toString(),
      balanceAfter,
      input.reason,
      input.referenceId ?? null,
      input.userId ?? null,
      input.note ?? null,
      input.actorUserId ?? null,
    ],
  );
  if (!inserted.rowCount) {
    /* The leg was already booked. Undo the balance move this call just made -- the first booking
     * already applied it, and leaving both would double the figure the console prints. */
    await client.query(
      `UPDATE bot_accounts SET tracked_balance_minor = tracked_balance_minor - $2
        WHERE id = $1`,
      [input.botId, signed.toString()],
    );
    return null;
  }
  return BigInt(balanceAfter);
}

/**
 * Moves everything above the configured float from the teller to the vault.
 *
 * Called after money lands on the teller. The teller keeps `tellerFloatTargetMinor` so ordinary
 * withdrawals can be paid without a round trip to the vault, and the excess is swept out -- the
 * public-facing account is the one most likely to be targeted, so what it holds is bounded by a
 * number an administrator sets rather than by how busy the day was.
 *
 * Queues a job. It does not wait for one: if the vault is offline the sweep sits in the queue,
 * and if a sweep is already queued this adds nothing, because a second sweep would be sized
 * against a balance the first one has not yet moved.
 */
export async function queueVaultSweep(
  client: DbClient,
  config: AppConfig,
  teller: { id: string; username: string },
  /* What the teller is really holding, when the caller knows.
   *
   * The tracked figure only counts what has moved THROUGH the site since the ledger started, so
   * on an account that already held money it reads zero beside millions. The background sweeper
   * reads the real balance from DonutSMP and passes it here; callers inside a request
   * transaction leave it out and the tracked figure is used, which is the conservative
   * direction -- it under-sweeps rather than asking for money that is not there. */
  availableMinor?: bigint,
): Promise<void> {
  const vault = await findVaultBot(client, config);
  // No vault provisioned: this is a teller-only deployment and there is nowhere to sweep to.
  if (!vault) return;

  const existing = await client.query(
    `SELECT 1 FROM bot_jobs
      WHERE bot_id = $1 AND kind = 'vault_sweep' AND status IN ('queued', 'leased') LIMIT 1`,
    [teller.id],
  );
  if (existing.rowCount) return;

  let held = availableMinor;
  if (held === undefined) {
    const balance = await client.query<{ tracked_balance_minor: string }>(
      'SELECT tracked_balance_minor FROM bot_accounts WHERE id = $1 FOR UPDATE',
      [teller.id],
    );
    held = BigInt(balance.rows[0]?.tracked_balance_minor ?? '0');
  }

  /* A threshold, not a trickle. Below it nothing moves, so an in-game transfer does not ride
   * behind every single deposit; above it the account is emptied in one go. */
  if (held < config.tellerSweepThresholdMinor) return;

  const excess = held - config.tellerFloatTargetMinor;
  /* Nothing above the float, nothing to do. Also the guard against a negative balance producing
   * a "sweep" that would ask the teller to pay a negative amount. */
  if (excess <= 0n) return;

  const reference = randomUUID();
  await client.query(
    `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload)
     VALUES ($1, $2, 'vault_sweep', $3, $4)`,
    [
      randomUUID(),
      teller.id,
      reference,
      JSON.stringify({
        payee: vault.username,
        amountMinor: excess.toString(),
        toBotId: vault.id,
      }),
    ],
  );
}
