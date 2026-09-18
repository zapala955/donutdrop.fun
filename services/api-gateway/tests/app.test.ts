import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import { csrfCookieName, linkCookieName, sessionCookieName } from '../src/lib/auth.js';
import {
  botRequestSignaturePayload,
  botResponseSignaturePayload,
  type AuthenticatedBot,
} from '../src/lib/bot-auth.js';
import { hmacHex } from '../src/lib/crypto.js';
import type { Database } from '../src/lib/db.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000001': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  LOG_LEVEL: 'silent',
});

describe('API application', () => {
  it('starts, registers health routes, and applies baseline security headers', async () => {
    const queries: string[] = [];
    const database = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ ready: true }], rowCount: 1 };
      },
      close: async () => undefined,
    } as unknown as Database;
    const app = await buildApp(config, database);

    try {
      const live = await app.inject({ method: 'GET', url: '/health/live' });
      assert.equal(live.statusCode, 200);
      assert.deepEqual(live.json(), { status: 'ok' });
      assert.equal(live.headers['cache-control'], 'no-store');
      assert.equal(live.headers['x-content-type-options'], 'nosniff');
      assert.equal(live.headers['content-language'], 'en');

      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(ready.statusCode, 200);
      assert.deepEqual(ready.json(), { status: 'ready' });
      assert.ok(queries.includes('SELECT public.donut_schema_ready_v25() AS ready'));

      const missing = await app.inject({ method: 'GET', url: '/not-a-route' });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, 'NOT_FOUND');

      for (const origin of [undefined, 'https://attacker.invalid']) {
        const loginCsrf = await app.inject({
          method: 'POST',
          url: '/v1/auth/link/start',
          ...(origin ? { headers: { origin } } : {}),
          payload: { minecraftUsername: 'PlayerOne' },
        });
        assert.equal(loginCsrf.statusCode, 403);
        assert.equal(loginCsrf.json().error.code, 'INVALID_ORIGIN');
      }

      for (const clientSeed of ['bad\u0000seed', '🍩'.repeat(64)]) {
        const invalidSeed = await app.inject({
          method: 'POST',
          url: '/v1/fairness/verify',
          payload: { serverSeed: 'a'.repeat(64), clientSeed, nonce: 0 },
        });
        assert.equal(invalidSeed.statusCode, 400);
        assert.equal(invalidSeed.json().error.code, 'VALIDATION_ERROR');
        // The flattened schema issues name every accepted field, so they stay server-side.
        assert.equal(invalidSeed.json().error.details, undefined);
      }
    } finally {
      await app.close();
    }
  });

  it('fails readiness when the hardened schema marker is unavailable', async () => {
    const database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => undefined,
    } as unknown as Database;
    const app = await buildApp(config, database);

    try {
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      assert.equal(ready.statusCode, 503);
      assert.deepEqual(ready.json(), { status: 'not_ready' });
    } finally {
      await app.close();
    }
  });
});

void describe('browser cookie hardening', () => {
  const secure = { secureCookies: true } as AppConfig;
  const insecure = { secureCookies: false } as AppConfig;

  void it('pins every browser cookie to the host with __Host- once cookies are secure', () => {
    // The CSRF cookie is readable by the application, so without __Host- a sibling subdomain
    // could overwrite it and wedge the victim's session into permanent INVALID_CSRF.
    assert.deepEqual(
      [sessionCookieName(secure), linkCookieName(secure), csrfCookieName(secure)],
      ['__Host-du_session', '__Host-du_link', '__Host-du_csrf'],
    );
  });

  void it('drops the prefix only where cookies cannot be marked secure', () => {
    // __Host- requires the Secure attribute, so plain-HTTP local development must not claim it.
    assert.deepEqual(
      [sessionCookieName(insecure), linkCookieName(insecure), csrfCookieName(insecure)],
      ['du_session', 'du_link', 'du_csrf'],
    );
  });
});

describe('authenticated bot failure responses', () => {
  const botId = '10000000-0000-4000-8000-000000000001';
  const botSecret = Buffer.alloc(32, 2);
  const path = '/internal/v1/minecraft/events';

  it('signs error replies to a bot whose request signature verified', async () => {
    const database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => undefined,
    } as unknown as Database;
    const app = await buildApp(config, database);

    try {
      // Correctly signed, but the body fails schema validation inside the handler, which is
      // the first failure reachable after authentication succeeds.
      const body = { eventId: 'not-a-uuid' };
      const requestTimestamp = Date.now().toString();
      const signature = hmacHex(
        botSecret,
        botRequestSignaturePayload('POST', path, botId, requestTimestamp, body),
      );
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': botId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: body,
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, 'VALIDATION_ERROR');

      const responseTimestamp = response.headers['x-api-timestamp'];
      assert.equal(typeof responseTimestamp, 'string');
      const authenticated: AuthenticatedBot = {
        botId,
        secret: botSecret,
        expectedServerHost: 'donutsmp.net',
        expectedUsername: 'DonutBot',
        method: 'POST',
        path,
        requestTimestamp,
      };
      const expected = hmacHex(
        botSecret,
        botResponseSignaturePayload(
          authenticated,
          responseTimestamp as string,
          400,
          body,
          response.json(),
        ),
      );
      assert.equal(response.headers['x-api-signature'], expected);
    } finally {
      await app.close();
    }
  });

  it('never signs a reply to a caller that failed bot authentication', async () => {
    const database = {
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => undefined,
    } as unknown as Database;
    const app = await buildApp(config, database);

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': botId,
          'x-bot-timestamp': Date.now().toString(),
          'x-bot-signature': 'f'.repeat(64),
        },
        payload: { eventId: 'not-a-uuid' },
      });

      assert.equal(response.statusCode, 401);
      // Signing here would authenticate a reply to someone who never proved they hold the key.
      assert.equal(response.headers['x-api-signature'], undefined);
      assert.equal(response.headers['x-api-timestamp'], undefined);
    } finally {
      await app.close();
    }
  });
});
