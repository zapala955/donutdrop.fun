import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Bot } from 'mineflayer';
import { answerCookiePacket, describeTracedPacket, sendPlainCommand, sendTickEnds } from '../src/worker.js';

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

describe('what the bot answers that a game client answers', () => {
  const fakeBot = (features: Record<string, boolean> | undefined) => {
    const written: Array<[string, unknown]> = [];
    const bot = Object.assign(new EventEmitter(), {
      supportFeature: undefined as ((name: string) => boolean) | undefined,
      _client: { write: (name: string, data: unknown) => written.push([name, data]) },
    });
    // The version, and so the features, only arrive once the server has answered the ping.
    const learnVersion = () => {
      if (features) bot.supportFeature = (name: string) => features[name] === true;
    };
    return { bot: bot as unknown as Bot, emitter: bot, written, learnVersion };
  };

  it('ends every physics tick with tick_end from 1.21.2 on', () => {
    const { bot, emitter, written, learnVersion } = fakeBot({ sendsClientTickEndPacket: true });
    sendTickEnds(bot);
    learnVersion();
    emitter.emit('physicsTick');
    emitter.emit('physicsTick');
    assert.deepEqual(written, [
      ['tick_end', {}],
      ['tick_end', {}],
    ]);
  });

  it('sends no tick_end on versions without the packet', () => {
    for (const features of [{ sendsClientTickEndPacket: false }, undefined]) {
      const { bot, emitter, written, learnVersion } = fakeBot(features);
      sendTickEnds(bot);
      learnVersion();
      emitter.emit('physicsTick');
      assert.deepEqual(written, []);
    }
  });

  it('answers a cookie request with what the server stored, or with nothing', () => {
    const { bot, written } = fakeBot({});
    const cookies = new Map<string, Buffer>();
    assert.equal(answerCookiePacket(bot, cookies, 'cookie_request', { cookie: 'donut:session' }), 'donut:session');
    const stored = Buffer.from([1, 2, 3]);
    assert.equal(answerCookiePacket(bot, cookies, 'store_cookie', { key: 'donut:session', value: stored }), 'donut:session');
    assert.equal(answerCookiePacket(bot, cookies, 'cookie_request', { cookie: 'donut:session' }), 'donut:session');
    assert.deepEqual(written, [
      ['cookie_response', { key: 'donut:session', value: undefined }],
      ['cookie_response', { key: 'donut:session', value: stored }],
    ]);
  });

  it('leaves every other packet alone', () => {
    const { bot, written } = fakeBot({});
    const cookies = new Map<string, Buffer>();
    assert.equal(answerCookiePacket(bot, cookies, 'system_chat', { content: 'hi' }), undefined);
    assert.equal(answerCookiePacket(bot, cookies, 'cookie_request', {}), undefined);
    assert.equal(answerCookiePacket(bot, cookies, 'store_cookie', { value: Buffer.alloc(1) }), undefined);
    assert.deepEqual(written, []);
    assert.equal(cookies.size, 0);
  });

  it('is wired into every connection, before it spawns', async () => {
    const source = (await readFile(path.resolve(import.meta.dirname, '../src/worker.ts'), 'utf8')).replace(/\r\n/g, '\n');
    assert.match(source, /this\.bot = bot;\n\n\s*sendTickEnds\(bot\);/);
    assert.match(source, /const cookieKey = answerCookiePacket\(bot, cookies, name, data\);/);
    assert.match(source, /this\.traceReplies\('join'\);\n\s*spawned = true;/);
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
