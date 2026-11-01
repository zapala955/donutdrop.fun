import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  chooseReceivingNode,
  choosePayingNode,
  freeMinor,
  nodeShareMinor,
  planRebalance,
  type PoolNode,
} from '../src/lib/bot-nodes.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');

const M = 1_000_000n;
const node = (
  id: string,
  tracked: bigint,
  options: { owed?: bigint; online?: boolean } = {},
): PoolNode => ({
  id,
  username: `Node${id}`,
  online: options.online ?? true,
  trackedMinor: tracked,
  owedMinor: options.owed ?? 0n,
});
const rules = { skewBps: 5000, minMinor: 10n * M };

describe('node pool: shares', () => {
  it('gives every node an equal share of what the pool holds free', () => {
    const pool = [
      node('1', 100n * M),
      node('2', 100n * M),
      node('3', 100n * M),
      node('4', 100n * M),
      node('5', 100n * M),
    ];
    assert.equal(nodeShareMinor(pool), 100n * M);
    // Five nodes: a fifth each.
    assert.equal(nodeShareMinor(pool) * 5n, 500n * M);
  });

  it('counts what a node already owes as not free', () => {
    const owing = node('1', 100n * M, { owed: 30n * M });
    assert.equal(freeMinor(owing), 70n * M);
    // A node that owes more than it holds adds nothing to the pool, rather than taking from it.
    assert.equal(
      nodeShareMinor([node('1', 10n * M, { owed: 50n * M }), node('2', 90n * M)]),
      45n * M,
    );
  });
});

describe('node pool: where money goes', () => {
  it('sends a depositing player to the emptiest online node', () => {
    const pool = [
      node('1', 300n * M),
      node('2', 50n * M),
      node('3', 10n * M, { online: false }),
      node('4', 120n * M),
    ];
    assert.equal(chooseReceivingNode(pool)?.id, '2');
    assert.equal(chooseReceivingNode([node('1', 1n, { online: false })]), null);
  });

  it('pays a withdrawal from the fullest online node when it covers it', () => {
    const pool = [node('1', 300n * M), node('2', 50n * M), node('3', 900n * M, { online: false })];
    const plan = choosePayingNode(pool, 200n * M);
    assert.equal(plan?.payer.id, '1');
    assert.equal(plan?.source, null);
    assert.equal(plan?.shortfallMinor, 0n);
  });

  it('tops the payer up from the next-richest node when nobody covers it alone', () => {
    // The quiet node may still fund it: its release waits in the queue for it.
    const pool = [node('1', 300n * M), node('2', 50n * M), node('3', 900n * M, { online: false })];
    const plan = choosePayingNode(pool, 500n * M);
    assert.equal(plan?.payer.id, '1');
    assert.equal(plan?.source?.id, '3');
    assert.equal(plan?.shortfallMinor, 200n * M);
  });

  it('lets a payout wait for deposits when there is nobody to top up from', () => {
    const plan = choosePayingNode([node('1', 30n * M)], 50n * M);
    assert.equal(plan?.payer.id, '1');
    assert.equal(plan?.source, null);
    assert.equal(choosePayingNode([node('1', 30n * M, { online: false })], 1n), null);
  });
});

describe('node pool: rebalancing is rare', () => {
  it('moves nothing while every node is inside its band', () => {
    // Share 100M, band ±50M: 140M and 60M are fine.
    const pool = [
      node('1', 140n * M),
      node('2', 60n * M),
      node('3', 100n * M),
      node('4', 100n * M),
      node('5', 100n * M),
    ];
    assert.equal(planRebalance(pool, rules), null);
  });

  it('moves one transfer, richest to poorest, never past either share, when the pool skews heavily', () => {
    const pool = [
      node('1', 300n * M),
      node('2', 10n * M),
      node('3', 100n * M),
      node('4', 100n * M),
      node('5', 90n * M),
    ];
    const plan = planRebalance(pool, rules);
    assert.equal(nodeShareMinor(pool), 120n * M);
    assert.equal(plan?.from.id, '1');
    assert.equal(plan?.to.id, '2');
    // min(300 - 120, 120 - 10) = 110M: the poorest lands exactly on its share.
    assert.equal(plan?.amountMinor, 110n * M);
  });

  it('never sends money to a node that is not online, and needs two online nodes', () => {
    const pool = [node('1', 500n * M), node('2', 0n, { online: false })];
    assert.equal(planRebalance(pool, rules), null);
  });

  it('skips a transfer too small to be worth a /pay', () => {
    const pool = [node('1', 12n * M), node('2', 2n * M)];
    assert.equal(planRebalance(pool, rules), null);
  });

  it('holds the skew, waits out the cooldown, and allows one transfer in flight', async () => {
    const source = await read('../src/lib/bot-nodes.ts');
    const fn = source.slice(source.indexOf('export async function rebalanceNodes('));
    assert.match(fn, /await lockPool\(client\);/);
    assert.match(
      fn,
      /if \(now - watch\.since < config\.nodeRebalanceHoldMinutes \* 60_000\) return null;/,
    );
    assert.match(fn, /status IN \('queued', 'leased'\)/);
    assert.match(
      fn,
      /kind = 'vault_sweep' AND created_at > now\(\) - make_interval\(mins => \$2\)/,
    );
    assert.match(fn, /VALUES \(\$1, \$2, 'vault_sweep', \$3, \$4\)/);
  });
});

describe('node pool: wiring', () => {
  it('routes withdrawals through the pool under the pool lock, and leaves a held payout where it is', async () => {
    const route = await read('../src/routes/cash-withdrawals.ts');
    assert.match(
      route,
      /if \(await routeThroughNodePool\(client, config, withdrawal, amount, payPlayerDirectly\)\) return;/,
    );
    const fn = route.slice(route.indexOf('async function routeThroughNodePool('));
    assert.match(fn, /"SELECT id FROM bot_jobs WHERE kind = 'cash_payout' AND reference_id = \$1"/);
    assert.ok(
      fn.indexOf('await lockPool(client);') < fn.indexOf('choosePayingNode('),
      'chosen before the lock',
    );
    assert.match(fn, /UPDATE cash_withdrawals SET bot_id = \$2, funding = \$3/);
    assert.match(fn, /VALUES \(\$1, \$2, 'vault_release', \$3, \$4\)/);
  });

  it('checks every node against its /bal and rebalances from the sweeper', async () => {
    const sweeper = await read('../src/lib/teller-sweeper.ts');
    assert.match(sweeper, /for \(const node of pool\) \{/);
    assert.match(sweeper, /rebalanceNodes\(client, config, skew\)/);
  });

  it('keeps the rebalance rules live in the admin panel', () => {
    for (const key of [
      'nodeRebalanceSkewBps',
      'nodeRebalanceHoldMinutes',
      'nodeRebalanceCooldownMinutes',
      'nodeRebalanceMinMinor',
    ] as const) {
      assert.equal(runtimeSettingDefinitions[key].group, 'bots', key);
    }
  });

  it('lets an operator make a bot a node, and shows the pool', async () => {
    const admin = await read('../src/routes/admin.ts');
    assert.match(admin, /role: z\.enum\(\['teller', 'vault', 'node'\]\)/);
    assert.match(admin, /pool: await describePool\(db, config\)/);
    const page = await read('../../../DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    assert.match(page, /function renderNodePool\(pool\)/);
    assert.match(page, /node: \{\s*label: 'Node: one of the pool/);
  });
});

describe('node pool: migration 086', () => {
  it('only widens the role check', async () => {
    const sql = await read('../../../packages/db/migrations/086_bot_nodes.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|UPDATE bot_accounts/i);
    assert.match(sql, /CHECK \(role IN \('teller', 'vault', 'node'\)\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v86\(\) RETURNS boolean/);
  });
});
