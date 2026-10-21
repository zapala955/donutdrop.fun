import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { describeTracedPacket } from '../src/worker.js';

/* 2026-10-20, about 20:05 UTC: DonutSMP moved to 26.3 and from then on neither bot's /pay or /bal got
 * any reply in chat, while payments to them still arrived. The trace records what the server sends
 * back instead, so the fix can be written from what it actually does. */

describe('what the server sends after a command', () => {
  it('is logged as one bounded line, whatever the packet holds', () => {
    assert.equal(
      describeTracedPacket('open_window', { windowId: 3, inventoryType: 2, windowTitle: '{"text":"Confirm"}' }),
      '{"windowId":3,"inventoryType":2,"windowTitle":"{\\"text\\":\\"Confirm\\"}"}',
    );
    // Numbers too big for JSON, and raw bytes, do not throw the line away.
    assert.equal(
      describeTracedPacket('show_dialog', { id: 7n, blob: new Uint8Array(40), buf: { type: 'Buffer', data: [1] } }),
      '{"id":"7","blob":"<40 bytes>","buf":"<bytes>"}',
    );
    assert.equal(describeTracedPacket('set_title_text', { text: 'x'.repeat(5_000) }).length, 1_200);
    assert.equal(
      describeTracedPacket('system_chat', { content: 'You have $5', isActionBar: true }),
      'actionbar "You have $5"',
    );
  });

  it('starts at every command the bot sends and at every join', async () => {
    const source = (await readFile(path.resolve(import.meta.dirname, '../src/worker.ts'), 'utf8')).replace(/\r\n/g, '\n');
    assert.match(source, /private sendCommand\(bot: Bot, command: string\): void \{\n\s*this\.lastCommandAt = Date\.now\(\);\n\s*this\.traceReplies\(/);
    assert.match(source, /'where the bot spawned',\n\s*\);\n\s*this\.traceReplies\('join'\);/);
    // Menus, dialogs and titles are among the packets logged in full.
    for (const name of ['open_window', 'show_dialog', 'set_title_text', 'system_chat']) {
      assert.ok(source.includes(`'${name}',`), name);
    }
  });
});
