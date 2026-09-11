import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/canonical.js';
import { loadBotConfig } from '../src/config.js';
import { DisabledTransferAdapter } from '../src/transfer-adapter.js';

const base = {
  NODE_ENV: 'test',
  MINECRAFT_HOST: 'donutsmp.net',
  MINECRAFT_USERNAME: 'bot-account@example.com',
  MINECRAFT_EXPECTED_USERNAME: 'DonutBot',
  MINECRAFT_PROFILES_FOLDER: '/tmp/minecraft-auth',
  BOT_ID: '10000000-0000-4000-8000-000000000001',
  API_INTERNAL_URL: 'http://api:3001/internal/v1/minecraft',
  BOT_WEBHOOK_SECRET: Buffer.alloc(32, 7).toString('base64'),
};

describe('Mineflayer security configuration', () => {
  it('loads one canonical per-bot webhook key', () => {
    const config = loadBotConfig(base);
    assert.equal(config.botId, base.BOT_ID);
    assert.equal(config.webhookSecret.length, 32);
  });

  it('rejects malformed keys and unsafe production authentication', () => {
    assert.throws(() =>
      loadBotConfig({ ...base, BOT_WEBHOOK_SECRET: `${base.BOT_WEBHOOK_SECRET}!!!!` }),
    );
    assert.throws(() =>
      loadBotConfig({ ...base, NODE_ENV: 'production', MINECRAFT_AUTH: 'offline' }),
    );
  });

  it('keeps the bundled transfer adapter incapable of accepting items', () => {
    assert.equal(new DisabledTransferAdapter().reviewedCapability, false);
  });

  it('rejects deeply nested signed data without overflowing the stack', () => {
    let value: unknown = null;
    for (let index = 0; index < 40; index += 1) value = { child: value };
    assert.throws(() => canonicalJson(value), /too deep/);
  });
});
