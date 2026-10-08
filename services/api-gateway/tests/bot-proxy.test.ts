import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { loadConfig } from '../src/config.js';
import {
  botRequestSignaturePayload,
  botResponseSignaturePayload,
  type AuthenticatedBot,
} from '../src/lib/bot-auth.js';
import {
  PROXY_SUMMARY_COLUMNS,
  describeProxy,
  encryptProxyPassword,
  proxyForBot,
  proxyInputSchema,
  type BotProxyColumns,
} from '../src/lib/bot-proxy.js';
import { hmacHex } from '../src/lib/crypto.js';
import type { Database } from '../src/lib/db.js';
import { registerMinecraftInternalRoutes } from '../src/routes/minecraft-in.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

const firstId = '10000000-0000-4000-8000-000000000001';
const secondId = '20000000-0000-4000-8000-000000000002';
const firstKey = Buffer.from('first-bot-key-material-for-tests!!').subarray(0, 32);
const revision = '50000000-0000-4000-8000-000000000005';

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    APP_ORIGIN: 'http://localhost:3000',
    COOKIE_SECRET: 'cookie-secret-that-is-long-enough-for-tests',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    BOT_CREDENTIALS_JSON: JSON.stringify({
      [firstId]: { secret: firstKey.toString('base64'), serverHost: 'donutsmp.net', username: 'DonutBotOne' },
    }),
    AUDIT_LOG_HMAC_KEY: 'audit-secret-that-is-long-enough-for-tests',
    IP_HASH_KEY: 'ip-hash-secret-that-is-long-enough-for-tests',
    LOG_LEVEL: 'silent',
  });
}

function storedRow(key: Buffer, overrides: Partial<BotProxyColumns> = {}): BotProxyColumns {
  return {
    proxy_type: 'socks5',
    proxy_host: 'gate.example.net',
    proxy_port: 1080,
    proxy_username: 'session-7',
    proxy_password_encrypted: encryptProxyPassword('hunter2', key, firstId),
    proxy_revision: revision,
    proxy_updated_at: new Date(),
    ...overrides,
  };
}

/** Asks for the route as the first bot, signed the way the bot signs it. */
async function askForRoute(rows: BotProxyColumns[]) {
  const config = testConfig();
  const database = {
    query: async (sql: string) => {
      assert.match(sql, /FROM bot_accounts WHERE id = \$1/);
      return { rows, rowCount: rows.length };
    },
  } as unknown as Database;
  const app = Fastify({ logger: false });
  await registerMinecraftInternalRoutes(app, database, config);
  const url = '/internal/v1/minecraft/connection-route';
  const body = { eventId: '90b1771b-da27-44c1-9bf0-676b54d94471', botId: firstId };
  const timestamp = Date.now().toString();
  try {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: {
        'x-bot-id': firstId,
        'x-bot-timestamp': timestamp,
        'x-bot-signature': hmacHex(firstKey, botRequestSignaturePayload('POST', url, firstId, timestamp, body)),
      },
      payload: body,
    });
    const authenticated: AuthenticatedBot = {
      botId: firstId,
      secret: firstKey,
      expectedServerHost: 'donutsmp.net',
      expectedUsername: 'DonutBotOne',
      method: 'POST',
      path: url,
      requestTimestamp: timestamp,
    };
    const signed =
      response.headers['x-api-signature'] ===
      hmacHex(
        firstKey,
        botResponseSignaturePayload(
          authenticated,
          String(response.headers['x-api-timestamp']),
          response.statusCode,
          body,
          response.json(),
        ),
      );
    return { status: response.statusCode, body: response.json(), signed, config };
  } finally {
    await app.close();
  }
}

describe('a bot asking how to reach the server', () => {
  it('is sent its own proxy with the password decrypted, in a signed reply', async () => {
    const key = testConfig().dataEncryptionKey;
    const result = await askForRoute([storedRow(key)]);
    assert.equal(result.status, 200);
    assert.equal(result.signed, true);
    assert.deepEqual(result.body, {
      proxy: {
        revision,
        type: 'socks5',
        host: 'gate.example.net',
        port: 1080,
        username: 'session-7',
        password: 'hunter2',
      },
    });
  });

  it('connects directly when it has no proxy, or no row yet', async () => {
    const empty: BotProxyColumns = {
      proxy_type: null,
      proxy_host: null,
      proxy_port: null,
      proxy_username: null,
      proxy_password_encrypted: null,
      proxy_revision: null,
      proxy_updated_at: null,
    };
    assert.deepEqual((await askForRoute([empty])).body, { proxy: null });
    assert.deepEqual((await askForRoute([])).body, { proxy: null });
  });

  it('is refused, not sent "direct", when the saved password cannot be decrypted', async () => {
    const otherKey = Buffer.alloc(32, 9);
    const result = await askForRoute([storedRow(otherKey)]);
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'BOT_PROXY_UNREADABLE');
  });

  it('cannot read a password that was saved for a different bot', () => {
    const key = testConfig().dataEncryptionKey;
    const row = storedRow(key);
    assert.equal(proxyForBot(row, key, firstId)?.password, 'hunter2');
    assert.throws(() => proxyForBot(row, key, secondId));
  });
});

describe('what the console may save as a proxy', () => {
  const parse = (value: unknown) => proxyInputSchema.safeParse(value);

  it('takes a hostname or an IP, a port, and optional credentials', () => {
    const named = parse({ type: 'socks5', host: ' Gate.Example.NET ', port: 1080 });
    assert.equal(named.success, true);
    assert.equal(named.data?.host, 'gate.example.net');
    assert.equal(named.data?.username, null);
    assert.equal(parse({ type: 'http', host: '203.0.113.7', port: 8080, username: 'u', password: 'p w' }).success, true);
    assert.equal(parse({ type: 'socks5', host: '2001:db8::1', port: 1080 }).success, true);
  });

  it('refuses what a bot could not connect through', () => {
    assert.equal(parse({ type: 'socks4', host: 'gate.example.net', port: 1080 }).success, false);
    assert.equal(parse({ type: 'socks5', host: 'gate example.net', port: 1080 }).success, false);
    assert.equal(parse({ type: 'socks5', host: 'http://gate.example.net', port: 1080 }).success, false);
    assert.equal(parse({ type: 'socks5', host: 'gate.example.net', port: 0 }).success, false);
    assert.equal(parse({ type: 'socks5', host: 'gate.example.net', port: 65_536 }).success, false);
    // A password with nobody to send it as, and an HTTP username Basic auth would cut at the colon.
    assert.equal(parse({ type: 'socks5', host: 'gate.example.net', port: 1080, password: 'p' }).success, false);
    assert.equal(
      parse({ type: 'http', host: 'gate.example.net', port: 8080, username: 'a:b', password: 'p' }).success,
      false,
    );
    assert.equal(parse({ type: 'socks5', host: 'gate.example.net', port: 1080, extra: 1 }).success, false);
  });
});

describe('one proxy, one bot, and the password stays out of the console', () => {
  it('enforces one bot per proxy in the database, telling sessions apart by username', async () => {
    const migration = await read('packages/db/migrations/060_bot_proxies.sql');
    assert.match(
      migration,
      /CREATE UNIQUE INDEX bot_accounts_one_bot_per_proxy\s+ON bot_accounts \(lower\(proxy_host\), proxy_port, coalesce\(proxy_username, ''\)\)\s+WHERE proxy_host IS NOT NULL;/,
    );
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const route = admin.slice(admin.indexOf("'/v1/admin/bots/:id/proxy'"));
    assert.match(route, /conflict\('PROXY_IN_USE', `That proxy is already assigned to \$\{taken\.rows\[0\]\.username\}`\)/);
    assert.match(route, /code === '23505'/);
  });

  it('never selects the encrypted password for the console', async () => {
    assert.doesNotMatch(PROXY_SUMMARY_COLUMNS, /proxy_password_encrypted\s*,/);
    assert.match(PROXY_SUMMARY_COLUMNS, /\(b\.proxy_password_encrypted IS NOT NULL\) AS proxy_has_password/);
    const admin = await read('services/api-gateway/src/routes/admin.ts');
    const reads = admin.match(/SELECT[\s\S]*?FROM bot_accounts/g) ?? [];
    for (const query of reads) assert.doesNotMatch(query, /proxy_password_encrypted/);
    const described = describeProxy({
      proxy_type: 'http',
      proxy_host: 'gate.example.net',
      proxy_port: 8080,
      proxy_username: 'u',
      proxy_has_password: true,
      proxy_revision: revision,
      proxy_updated_at: null,
    });
    assert.equal(described?.hasPassword, true);
    assert.equal(JSON.stringify(described).includes('password"'), false);
  });

  it('records on the heartbeat which assignment the bot is connected with', async () => {
    const route = await read('services/api-gateway/src/routes/minecraft-in.ts');
    const schema = route.slice(route.indexOf('const heartbeatEvent'), route.indexOf('const linkEvent'));
    assert.match(schema, /proxyRevision: normalizedUuid\.optional\(\),/);
    const beat = route.slice(
      route.indexOf('async function processHeartbeat('),
      route.indexOf('async function processLinkConfirmation('),
    );
    assert.match(beat, /connected_proxy_revision = \$8,/);
    assert.match(beat, /event\.online \? \(event\.proxyRevision \?\? null\) : null,/);
  });
});
