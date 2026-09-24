import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pendingChannelId } from '../src/features/tickets.js';

/**
 * Every ticket failed in production with Postgres 22001, "value too long", because the
 * placeholder written before the channel exists did not fit the column. The handler's tests ran
 * against no database at all, so the width is read from the migration here rather than restated:
 * a test that hard-codes 32 would keep passing after somebody narrowed the column.
 */
async function channelIdWidth(): Promise<number> {
  const sql = await readFile(
    path.resolve(import.meta.dirname, '../../../packages/db/migrations/046_community_bot.sql'),
    'utf8',
  );
  const table = sql.slice(sql.indexOf('CREATE TABLE discord_tickets ('));
  const width = /\n\s+channel_id varchar\((\d+)\)/.exec(table)?.[1];
  assert.ok(width, 'discord_tickets.channel_id is no longer a varchar(n)');
  return Number(width);
}

describe('the channel id a ticket holds before its channel exists', () => {
  it('fits discord_tickets.channel_id', async () => {
    const width = await channelIdWidth();
    for (let i = 0; i < 200; i += 1) {
      assert.ok(pendingChannelId(randomUUID()).length <= width);
    }
  });

  it('can never be mistaken for a real channel id', () => {
    assert.doesNotMatch(pendingChannelId(randomUUID()), /^\d+$/);
  });

  it('differs between tickets, since channel_id is unique', () => {
    assert.notEqual(pendingChannelId(randomUUID()), pendingChannelId(randomUUID()));
  });
});
