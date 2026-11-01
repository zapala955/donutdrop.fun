import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { pickBot, VAULT_RELEASE_SILENCE_SECONDS, type SelectedBot } from './bots.js';
import type { DbClient } from './db.js';

/**
 * The node pool: several equal accounts, each a teller and a vault at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A POOL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * With a teller and one vault, the vault holds nearly everything, so losing that one account
 * loses nearly everything -- and on 2026-10-07 the vault account was banned from DonutSMP. A pool
 * of N nodes holds about 1/N on each (20% with five), so losing one account costs its share and
 * the others keep taking deposits and paying withdrawals.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THE SHARES STAY EVEN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Mostly through the players' own traffic. A deposit is sent to the online node holding the
 * least, and a withdrawal is paid by the online node holding the most, so ordinary flow pulls
 * every node toward its share without any transfer between them.
 *
 * A node-to-node /pay happens only when the pool is skewed heavily: a node more than
 * `nodeRebalanceSkewBps` away from its share, for at least `nodeRebalanceHoldMinutes` in a row
 * (a burst of deposits evens itself out within that time), and no rebalance inside
 * `nodeRebalanceCooldownMinutes`. Then exactly one transfer goes, richest to poorest, sized to bring
 * the nearer of the two back to its share. The rebalance is a `vault_sweep` job and a withdrawal a
 * node cannot cover alone is funded by a `vault_release`, so the bots run the same two jobs they
 * already know: a bot is never told which role it has.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * OPT-IN, LIKE THE VAULT WAS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A node is a bot with role 'node' (migration 086). With none, every function here comes back
 * empty and the teller/vault path runs exactly as before.
 */

/** A node in the pool, as the routing sees it. */
export interface PoolNode {
  readonly id: string;
  readonly username: string;
  /** Heard from inside 45 seconds and online: may be shown to a player or given a payout now. */
  readonly online: boolean;
  /** What the platform believes the account holds (bot_accounts.tracked_balance_minor). */
  readonly trackedMinor: bigint;
  /** What it is already due to pay: payouts and transfers queued on it or in flight. */
  readonly owedMinor: bigint;
}

/** What a node holds that nothing has a claim on yet. Can be negative while a payout is queued. */
export function freeMinor(node: PoolNode): bigint {
  return node.trackedMinor - node.owedMinor;
}

/** What each node is meant to hold: an equal share of what the nodes hold free between them. */
export function nodeShareMinor(nodes: readonly PoolNode[]): bigint {
  if (!nodes.length) return 0n;
  let total = 0n;
  for (const node of nodes) {
    const free = freeMinor(node);
    if (free > 0n) total += free;
  }
  return total / BigInt(nodes.length);
}

/** Least free first; ties by id, so the same pool always routes the same way. */
function byFree(a: PoolNode, b: PoolNode): number {
  const left = freeMinor(a);
  const right = freeMinor(b);
  if (left !== right) return left < right ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Where a player is sent to pay: the online node holding the least. */
export function chooseReceivingNode(nodes: readonly PoolNode[]): PoolNode | null {
  return nodes.filter((node) => node.online).sort(byFree)[0] ?? null;
}

export interface NodePayoutPlan {
  /** The node that pays the player: the online node holding the most. */
  readonly payer: PoolNode;
  /** The node that tops the payer up first, when the payer cannot cover the payout alone. */
  readonly source: PoolNode | null;
  /** How much the payer is short of the payout. Zero when it covers it. */
  readonly shortfallMinor: bigint;
}

/**
 * Who pays a withdrawal.
 *
 * The online node holding the most, which is also the node furthest above its share, so every
 * withdrawal is a small step back toward an even pool. If even that node cannot cover it, the
 * next-richest node sends it the difference first. That node may be offline for a moment: the
 * transfer waits in the queue for it, as a vault release always has. With no node to send it, the
 * payout simply waits in the payer's funds queue until deposits cover it.
 */
export function choosePayingNode(
  nodes: readonly PoolNode[],
  amountMinor: bigint,
): NodePayoutPlan | null {
  const payer = nodes
    .filter((node) => node.online)
    .sort(byFree)
    .at(-1);
  if (!payer) return null;
  const free = freeMinor(payer);
  if (free >= amountMinor) return { payer, source: null, shortfallMinor: 0n };
  const source =
    nodes
      .filter((node) => node.id !== payer.id && freeMinor(node) > 0n)
      .sort(byFree)
      .at(-1) ?? null;
  return { payer, source, shortfallMinor: amountMinor - (free > 0n ? free : 0n) };
}

export interface RebalanceRules {
  /** How far from its share a node may drift before the pool counts as skewed, in basis points. */
  readonly skewBps: number;
  /** Below this a transfer is not worth a /pay. */
  readonly minMinor: bigint;
}

export interface RebalancePlan {
  readonly from: PoolNode;
  readonly to: PoolNode;
  readonly amountMinor: bigint;
  readonly shareMinor: bigint;
}

/**
 * The one transfer a heavily skewed pool would make, or null when it is even enough.
 *
 * Only online nodes take part: money is never sent to an account that may not be there. The
 * amount is the smaller of what the richest holds above its share and what the poorest lacks,
 * so no transfer pushes the receiver past its share or the sender below it.
 */
export function planRebalance(
  nodes: readonly PoolNode[],
  rules: RebalanceRules,
): RebalancePlan | null {
  const online = nodes.filter((node) => node.online).sort(byFree);
  if (online.length < 2) return null;
  const share = nodeShareMinor(online);
  if (share <= 0n) return null;
  const band = (share * BigInt(rules.skewBps)) / 10_000n;
  const poorest = online[0]!;
  const richest = online.at(-1)!;
  const over = freeMinor(richest) - share;
  const under = share - freeMinor(poorest);
  if (over <= band && under <= band) return null;
  const amount = over < under ? over : under;
  if (amount <= 0n || amount < rules.minMinor) return null;
  return { from: richest, to: poorest, amountMinor: amount, shareMinor: share };
}

/**
 * The pool, read fresh.
 *
 * A node counts while it has been heard from inside `VAULT_RELEASE_SILENCE_SECONDS`, the same
 * window a vault is given: a reconnect does not drop its money from the share, and an account gone
 * quiet for good (banned) drops out instead of holding the share up forever. Quarantined and
 * parked nodes are out, and so is a row whose identity has drifted from BOT_CREDENTIALS_JSON.
 */
export async function readPool(client: DbClient, config: AppConfig): Promise<PoolNode[]> {
  const provisioned = [...config.botCredentials.keys()];
  if (!provisioned.length) return [];
  const result = await client.query<{
    id: string;
    username: string;
    server_host: string;
    tracked: string;
    online: boolean;
    owed: string;
  }>(
    `SELECT b.id, b.username, b.server_host, b.tracked_balance_minor::text AS tracked,
            (b.status = 'online' AND b.last_heartbeat_at > now() - interval '45 seconds') AS online,
            COALESCE((SELECT SUM((j.payload->>'amountMinor')::numeric)
                        FROM bot_jobs j
                       WHERE j.bot_id = b.id
                         AND j.kind IN ('cash_payout', 'admin_payout', 'vault_sweep', 'vault_release')
                         AND j.status IN ('queued', 'leased')
                         AND j.payload->>'amountMinor' ~ '^[0-9]{1,19}$'), 0)::text AS owed
       FROM bot_accounts b
      WHERE b.id = ANY($1::uuid[]) AND b.role = 'node' AND b.status <> 'quarantined'
        AND b.parked_at IS NULL
        AND b.last_heartbeat_at > now() - make_interval(secs => $2)
      ORDER BY b.id`,
    [provisioned, VAULT_RELEASE_SILENCE_SECONDS],
  );
  return result.rows
    .filter((row) => {
      const credentials = config.botCredentials.get(row.id);
      return (
        credentials &&
        row.username.toLowerCase() === credentials.username.toLowerCase() &&
        row.server_host.toLowerCase().replace(/\.$/, '') === credentials.serverHost
      );
    })
    .map((row) => ({
      id: row.id,
      username: row.username,
      online: row.online,
      trackedMinor: BigInt(row.tracked),
      owedMinor: BigInt(row.owed),
    }));
}

/**
 * Serialises every decision that reads the pool and then queues money against it.
 *
 * Two withdrawals routed at the same instant would otherwise both see the richest node free and
 * both be given to it. A transaction-scoped advisory lock rather than row locks on every node: the
 * job results that book a node-to-node transfer lock sender then receiver, in whatever order the
 * transfer ran, and locking the whole pool here could deadlock against them.
 */
export async function lockPool(client: DbClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bot-node-pool', 0))");
}

/**
 * The account a player is told to pay: the emptiest online node, or the teller without a pool.
 *
 * Only ever a node or a teller, both of which are public by design. The vault's name cannot come
 * out of here.
 */
export async function pickReceivingBot(
  client: DbClient,
  config: AppConfig,
): Promise<SelectedBot | null> {
  const node = chooseReceivingNode(await readPool(client, config));
  if (node) return { id: node.id, username: node.username, trackedBalanceMinor: node.trackedMinor };
  return pickBot(client, config, 'teller');
}

/**
 * The pool for the admin console: each node's holding against its share, the transfer a skewed
 * pool would make, and when the last one went. Read-only.
 */
export async function describePool(client: DbClient, config: AppConfig) {
  const nodes = await readPool(client, config);
  const online = nodes.filter((node) => node.online);
  const plan = planRebalance(nodes, {
    skewBps: config.nodeRebalanceSkewBps,
    minMinor: config.nodeRebalanceMinMinor,
  });
  const last = nodes.length
    ? await client.query<{ at: Date | null }>(
        `SELECT max(created_at) AS at FROM bot_jobs
          WHERE kind = 'vault_sweep' AND bot_id = ANY($1::uuid[])`,
        [nodes.map((node) => node.id)],
      )
    : null;
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      username: node.username,
      online: node.online,
      trackedMinor: node.trackedMinor.toString(),
      owedMinor: node.owedMinor.toString(),
      freeMinor: freeMinor(node).toString(),
    })),
    shareMinor: nodeShareMinor(online).toString(),
    skewBps: config.nodeRebalanceSkewBps,
    holdMinutes: config.nodeRebalanceHoldMinutes,
    cooldownMinutes: config.nodeRebalanceCooldownMinutes,
    minMinor: config.nodeRebalanceMinMinor.toString(),
    wouldRebalance: plan
      ? { from: plan.from.username, to: plan.to.username, amountMinor: plan.amountMinor.toString() }
      : null,
    lastRebalanceAt: last?.rows[0]?.at ?? null,
  };
}

/** When the pool first looked skewed in a row of checks, held by the sweeper between ticks. */
export interface SkewWatch {
  since: number | null;
}

/**
 * Queues one node-to-node transfer if the pool has been heavily skewed long enough.
 *
 * Returns what it queued, or null. Holds the pool lock, so a withdrawal being routed at the same
 * moment sees this transfer as owed by the sender.
 */
export async function rebalanceNodes(
  client: DbClient,
  config: AppConfig,
  watch: SkewWatch,
  now: number = Date.now(),
): Promise<RebalancePlan | null> {
  await lockPool(client);
  const pool = await readPool(client, config);
  const plan = planRebalance(pool, {
    skewBps: config.nodeRebalanceSkewBps,
    minMinor: config.nodeRebalanceMinMinor,
  });
  if (!plan) {
    watch.since = null;
    return null;
  }
  watch.since ??= now;
  // Delayed on purpose: player traffic evens out most bursts on its own, for free.
  if (now - watch.since < config.nodeRebalanceHoldMinutes * 60_000) return null;

  /* Rare on purpose: one at a time, and none inside the cooldown of the last. A release funding a
   * withdrawal is in flight too counts, since it is moving the same money. */
  const busy = await client.query<{ busy: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM bot_jobs
        WHERE bot_id = ANY($1::uuid[]) AND kind IN ('vault_sweep', 'vault_release')
          AND (status IN ('queued', 'leased')
               OR (kind = 'vault_sweep' AND created_at > now() - make_interval(mins => $2)))
     ) AS busy`,
    [pool.map((node) => node.id), config.nodeRebalanceCooldownMinutes],
  );
  if (busy.rows[0]?.busy) return null;

  await client.query(
    `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload)
     VALUES ($1, $2, 'vault_sweep', $3, $4)`,
    [
      randomUUID(),
      plan.from.id,
      randomUUID(),
      JSON.stringify({
        payee: plan.to.username,
        amountMinor: plan.amountMinor.toString(),
        toBotId: plan.to.id,
      }),
    ],
  );
  watch.since = null;
  return plan;
}
