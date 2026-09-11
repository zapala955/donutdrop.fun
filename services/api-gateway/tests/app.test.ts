import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
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
      assert.ok(queries.includes('SELECT public.donut_schema_ready_v7() AS ready'));

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
