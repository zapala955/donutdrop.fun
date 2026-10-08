import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

/**
 * A bot is retired by removing its credentials. Its row stays, because its ledger is append-only
 * and its history is still the platform's, but it stops being one of the bots: the console does
 * not list it, and the overview and the Discord health check do not count it. The banned vault
 * (2026-10-07) otherwise read as "1 quarantined bot" and "1 stale bot" on every check forever.
 */
describe('a retired bot', () => {
  it('is not listed in the console', async () => {
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const list = admin.slice(admin.indexOf("'/v1/admin/bots'"), admin.indexOf('floatTargetMinor'));
    assert.match(list, /WHERE b\.id = ANY\(\$1::uuid\[\]\)/);
    assert.match(list, /\[provisionedBotIds\],/);
    const payouts = await read('services/api-gateway/src/routes/admin-payouts.ts');
    assert.match(payouts, /FROM bot_accounts WHERE id = ANY\(\$1::uuid\[\]\) ORDER BY role, username/);
  });

  it('is not counted on the overview or by the Discord health check', async () => {
    const operations = await read('services/api-gateway/src/routes/admin-operations.ts');
    assert.match(
      operations,
      /FROM bot_accounts WHERE status = 'quarantined' AND id = ANY\(\$1::uuid\[\]\)\)::text\s+AS bots_quarantined/,
    );
    const discord = await read('services/api-gateway/src/routes/discord-control.ts');
    for (const query of discord.match(/\(SELECT count\(\*\) FROM bot_accounts[\s\S]*?\)::text/g) ?? []) {
      assert.match(query, /id = ANY\(\$1::uuid\[\]\)/, `unfiltered: ${query}`);
    }
    assert.match(discord, /FROM bot_accounts b WHERE b\.id = ANY\(\$1::uuid\[\]\) ORDER BY b\.username/);
  });
});
