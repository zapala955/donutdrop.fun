import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Bot } from 'mineflayer';
import { describeTracedPacket, sendPlainCommand } from '../src/worker.js';

/* 2026-10-20, about 20:05 UTC: DonutSMP moved to 26.3 and from then on neither bot's /pay or /bal got
 * any reply in chat, while payments to them still arrived. The trace records what the server sends
 * back instead, so the fix can be written from what it actually does. */

describe('a command the bot sends', () => {
  const fakeBot = (features: boolean | undefined) => {
    const written: Array<[string, unknown]> = [];
    const chatted: string[] = [];
    const bot = {
      supportFeature: features === undefined ? undefined : () => features,
      _client: { write: (name: string, data: unknown) => written.push([name, data]) },
      chat: (text: string) => chatted.push(text),
    } as unknown as Bot;
    return { bot, written, chatted };
  };

  it('goes as the plain chat_command packet, as the game client sends /pay and /bal', () => {
    const { bot, written, chatted } = fakeBot(true);
    sendPlainCommand(bot, '/pay Sfouga55 24000000');
    sendPlainCommand(bot, '/bal');
    assert.deepEqual(written, [
      ['chat_command', { command: 'pay Sfouga55 24000000' }],
      ['chat_command', { command: 'bal' }],
    ]);
    assert.deepEqual(chatted, []);
  });

  it('keeps mineflayer\'s own path on versions without the separate signed packet', () => {
    for (const features of [false, undefined]) {
      const { bot, written, chatted } = fakeBot(features);
      sendPlainCommand(bot, '/bal');
      assert.deepEqual(written, []);
      assert.deepEqual(chatted, ['/bal']);
    }
  });
});

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
