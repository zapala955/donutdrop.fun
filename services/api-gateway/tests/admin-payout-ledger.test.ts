import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const route = async () =>
  (await readFile(path.join(here, '../src/routes/minecraft-in.ts'), 'utf8')).replace(/\r\n/g, '\n');

/* 2026-10-28: every operator payout from the admin console left the bot without touching its
 * tracked balance, so the next /bal booked it as a nameless "donutsmp" adjustment (2M to
 * 7_donutluxe_com at 10:22:54, an adjustment out of 2M at 10:23:32, and so on back to 10-26). */
describe('an operator payout the bot confirmed', () => {
  it('is booked on the paying bot, under its payee, once', async () => {
    const source = await route();
    const branch = source.slice(source.indexOf("if (job.kind === 'admin_payout') {\n      const paid"));
    assert.ok(branch.length > 0, 'the admin payout completion branch moved');
    const body = branch.slice(0, branch.indexOf('\n    }\n'));
    // Only the first transition to paid books anything.
    assert.match(body, /WHERE id = \$1 AND status IN \('queued', 'processing'\)\s+RETURNING payee_username, amount_minor/);
    assert.match(body, /if \(row\) \{\s+await recordBotTransfer\(client, \{/);
    assert.match(body, /botId: event\.botId,/);
    assert.match(body, /direction: 'out',/);
    assert.match(body, /counterparty: row\.payee_username,/);
    assert.match(body, /reason: 'admin_payout',/);
    // The leg index is (bot, direction, reason, reference): the job id makes a replay a no-op.
    assert.match(body, /referenceId: job\.id,/);
  });
});
