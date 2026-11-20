import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EVERYONE, HIGHROLLER, choosePayingNode, groupPool, type PoolNode } from '../src/lib/bot-nodes.js';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');
const M = 1_000_000n;
const node = (id: string, group: string, tracked: bigint, online = true): PoolNode => ({
  id,
  username: `Node${id}`,
  online,
  trackedMinor: tracked,
  owedMinor: 0n,
  group,
});

describe('bots for different players', () => {
  const pool = [node('a', EVERYONE, 500n * M), node('b', EVERYONE, 100n * M), node('h', HIGHROLLER, 50n * M)];

  it('serves a group from its own nodes only', () => {
    assert.deepEqual(groupPool(pool, HIGHROLLER).map((n) => n.id), ['h']);
    assert.deepEqual(groupPool(pool, EVERYONE).map((n) => n.id), ['a', 'b']);
    // A highroller is paid by the highroller bot, even though an everyone node holds more.
    assert.equal(choosePayingNode(groupPool(pool, HIGHROLLER), 10n * M)?.payer.id, 'h');
  });

  it('sends a group with no node online to everyone, so nobody is left without a bot', () => {
    const offline = [node('a', EVERYONE, 500n * M), node('h', HIGHROLLER, 50n * M, false)];
    assert.deepEqual(groupPool(offline, HIGHROLLER).map((n) => n.id), ['a']);
    assert.deepEqual(groupPool(pool, 'vip-club').map((n) => n.id), ['a', 'b']);
  });

  it('decides a player\u2019s group by hand first, then by what they have wagered', async () => {
    const nodes = await read('../src/lib/bot-nodes.ts');
    const fn = nodes.slice(nodes.indexOf('export async function playerBotGroup('));
    assert.match(fn, /if \(row\?\.bot_group\) return row\.bot_group;/);
    assert.match(fn, /config\.highrollerWagerMinor > 0n && BigInt\(row\.wagered\) >= config\.highrollerWagerMinor/);
  });

  it('routes deposits and withdrawals by the player, and balances each group on its own', async () => {
    const [deposits, withdrawals, nodes, migration, admin] = await Promise.all([
      read('../src/routes/cash-deposits.ts'),
      read('../src/routes/cash-withdrawals.ts'),
      read('../src/lib/bot-nodes.ts'),
      read('../../../packages/db/migrations/103_bot_player_groups.sql'),
      read('../src/routes/admin.ts'),
    ]);
    assert.match(deposits, /pickReceivingBot\(db, config, request\.authUser\?\.id \?\? null\)/);
    assert.match(withdrawals, /choosePayingNode\(groupPool\(await readPool\(client, config\), group\), amount\)/);
    assert.match(nodes, /\.filter\(\(node\) => node\.group === group\);/);
    assert.match(migration, /ADD COLUMN player_group varchar\(24\) NOT NULL DEFAULT 'everyone'/);
    assert.match(migration, /ADD COLUMN bot_group varchar\(24\)/);
    assert.match(admin, /app\.patch\('\/v1\/admin\/bots\/:id\/group'/);
    assert.match(admin, /app\.patch\('\/v1\/admin\/users\/:id\/bot-group'/);
  });
});
