import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/lib/db.js';
import { registerCashDepositRoutes } from '../src/routes/cash-deposits.js';

const botId = '20000000-0000-4000-8000-000000000002';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    [botId]: {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  GAME_CURRENCY_ONLY: 'true',
  LOG_LEVEL: 'silent',
});

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function captureApp(): { app: FastifyInstance; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const route = (method: string) => (routePath: string, _options: unknown, handler: Handler) => {
    handlers.set(`${method} ${routePath}`, handler);
  };
  return {
    app: { get: route('GET') } as unknown as FastifyInstance,
    handlers,
  };
}

function result<R>(rows: R[]) {
  return { rows, rowCount: rows.length };
}

function handlerFor(handlers: Map<string, Handler>, key: string): Handler {
  const handler = handlers.get(key);
  assert.ok(handler, `Missing route handler: ${key}`);
  return handler;
}

describe('cash payment deposits', () => {
  it('installs a passive receipt ledger and readiness marker', async () => {
    const sql = await readFile(
      path.resolve(
        import.meta.dirname,
        '../../../packages/db/migrations/027_passive_cash_receipts.sql',
      ),
      'utf8',
    );
    assert.match(sql, /CREATE TABLE cash_payment_receipts/);
    assert.match(sql, /PRIMARY KEY REFERENCES inbound_bot_events\(event_id\)/);
    assert.match(sql, /'credited', 'login_payment', 'unlinked', 'manual_review'/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE cash_payment_receipts/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v27\(\) RETURNS boolean/);
  });

  it('shows one permanent /pay instruction without calling the stats API', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('cash deposit info must not call the DonutSMP API');
    });
    const { app, handlers } = captureApp();
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database = {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push(values ? { sql, values } : { sql });
        if (sql.includes('FROM bot_accounts')) {
          return result([{ id: botId, username: 'DonutBot', server_host: 'donutsmp.net', role: 'teller', tracked_balance_minor: '0' }]);
        }
        return result([]);
      },
    } as unknown as Database;
    await registerCashDepositRoutes(app, database, config);

    const payload = (await handlerFor(handlers, 'GET /v1/cash-deposits/info')(
      { authUser: { id: '10000000-0000-4000-8000-000000000001' } } as unknown as FastifyRequest,
      {} as FastifyReply,
    )) as { botUsername: string; command: string; example: string; copy: string };

    assert.deepEqual(payload, {
      botUsername: 'DonutBot',
      command: '/pay DonutBot <amount>',
      example: '/pay DonutBot 1000000',
      /* What the copy button puts on the clipboard: no amount, and a trailing space so the paste
         lands with the cursor where the figure goes. Copying `example` pasted a literal 1000000
         that had to be deleted first, and forgetting to meant depositing exactly one million. */
      copy: '/pay DonutBot ',
    });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(
      statements.some(({ sql }) => sql.includes('cash_deposit_challenges')),
      false,
    );
  });
});
