import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import type { Database, DbClient } from '../src/lib/db.js';
import { registerCashDepositRoutes } from '../src/routes/cash-deposits.js';

const userId = '10000000-0000-4000-8000-000000000001';
const botId = '20000000-0000-4000-8000-000000000002';
const depositId = '30000000-0000-4000-8000-000000000003';
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
  DONUTSMP_API_BASE_URL: 'https://api.donutsmp.test',
  DONUTSMP_API_KEY: 'test-key',
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  GAME_CURRENCY_ONLY: 'true',
  LOG_LEVEL: 'silent',
});

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function captureApp(): { app: FastifyInstance; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const route = (method: string) => (path: string, _options: unknown, handler: Handler) => {
    handlers.set(`${method} ${path}`, handler);
  };
  return {
    app: { get: route('GET'), post: route('POST') } as unknown as FastifyInstance,
    handlers,
  };
}

function result<R>(rows: R[]) {
  return { rows, rowCount: rows.length };
}

class ReplyStub {
  statusCode = 200;
  payload: unknown;

  code(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  send(payload?: unknown): unknown {
    this.payload = payload;
    return payload;
  }
}

function handlerFor(handlers: Map<string, Handler>, key: string): Handler {
  const handler = handlers.get(key);
  assert.ok(handler, `Missing route handler: ${key}`);
  return handler;
}

function apiBalance(money: string): Response {
  return new Response(JSON.stringify({ result: { money } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('cash payment deposits', () => {
  it('installs an idempotent ledger-backed schema and readiness marker', async () => {
    const sql = await readFile(
      path.resolve(
        import.meta.dirname,
        '../../../packages/db/migrations/026_cash_payment_deposits.sql',
      ),
      'utf8',
    );
    assert.match(sql, /CREATE TABLE cash_deposit_challenges/);
    assert.match(sql, /UNIQUE \(user_id, idempotency_key\)/);
    assert.match(sql, /cash_deposit_challenges_active_bot_idx/);
    assert.match(sql, /'pay_login_deposit', 'cash_deposit'/);
    assert.match(
      sql,
      /GRANT SELECT, INSERT, UPDATE ON TABLE cash_deposit_challenges TO donut_api_runtime/,
    );
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v26\(\) RETURNS boolean/);
  });

  it('creates a one-time /pay challenge without requiring an item-transfer bot', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => apiBalance('5000000'));
    const { app, handlers } = captureApp();
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + 600_000);
    const database = {
      query: async (sql: string) => {
        if (sql.includes('idempotency_key')) return result([]);
        if (sql.includes('FROM bot_accounts')) {
          return result([
            {
              id: botId,
              username: 'DonutBot',
              server_host: 'donutsmp.net',
            },
          ]);
        }
        return result([]);
      },
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string, values?: readonly unknown[]) => {
            statements.push(values ? { sql, values } : { sql });
            if (sql.includes('idempotency_key = $2')) return result([]);
            if (sql.includes('FROM users account')) {
              return result([
                {
                  status: 'active',
                  country_code: null,
                  terms_accepted_at: null,
                  age_verified_at: null,
                  kyc_status: 'not_started',
                  cooldown_until: null,
                  self_excluded_until: null,
                },
              ]);
            }
            if (sql.includes('INSERT INTO cash_deposit_challenges')) {
              return result([
                {
                  id: depositId,
                  user_id: userId,
                  bot_id: botId,
                  amount_minor: '1000000',
                  bot_balance_before_minor: '500000000',
                  status: 'pending',
                  displayed_amount: null,
                  observed_at: null,
                  credited_at: null,
                  balance_after_minor: null,
                  expires_at: expiresAt,
                  created_at: createdAt,
                  bot_username: 'DonutBot',
                },
              ]);
            }
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    await registerCashDepositRoutes(app, database, config);

    const reply = new ReplyStub();
    await handlerFor(handlers, 'POST /v1/cash-deposits')(
      {
        body: { amountMinor: '1000000' },
        headers: { 'idempotency-key': 'one-payment' },
        authUser: { id: userId },
      } as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    assert.equal(reply.statusCode, 201);
    assert.equal((reply.payload as { instruction: string }).instruction, '/pay DonutBot 1000000');
    const insert = statements.find(({ sql }) =>
      sql.includes('INSERT INTO cash_deposit_challenges'),
    );
    assert.equal(insert?.values?.[3], '1000000');
    assert.equal(insert?.values?.[4], '500000000');
    assert.equal(
      statements.some(({ sql }) => sql.includes('transfer_capable')),
      false,
    );
  });

  it('credits the exact whole-dollar deposit once the receipt and API delta agree', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => apiBalance('6000000'));
    const { app, handlers } = captureApp();
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const row = {
      id: depositId,
      user_id: userId,
      bot_id: botId,
      amount_minor: '1000000',
      bot_balance_before_minor: '500000000',
      status: 'observed',
      displayed_amount: '1M',
      observed_at: new Date(),
      credited_at: null,
      balance_after_minor: null,
      expires_at: new Date(Date.now() + 600_000),
      created_at: new Date(),
      bot_username: 'DonutBot',
    } as const;
    const database = {
      query: async () => result([row]),
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string, values?: readonly unknown[]) => {
            statements.push(values ? { sql, values } : { sql });
            if (sql.includes('FOR UPDATE OF d')) return result([row]);
            if (sql.includes('UPDATE user_wallets')) {
              return result([{ balance_minor: '1000000' }]);
            }
            if (sql.includes('UPDATE cash_deposit_challenges')) {
              return result([
                {
                  ...row,
                  status: 'credited',
                  credited_at: new Date(),
                  balance_after_minor: '1000000',
                },
              ]);
            }
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    await registerCashDepositRoutes(app, database, config);

    const payload = (await handlerFor(handlers, 'GET /v1/cash-deposits/:id')(
      {
        params: { id: depositId },
        authUser: { id: userId },
      } as unknown as FastifyRequest,
      {} as FastifyReply,
    )) as { deposit: { status: string; balanceMinor: string } };

    assert.equal(payload.deposit.status, 'credited');
    assert.equal(payload.deposit.balanceMinor, '1000000');
    assert.ok(
      statements.some(
        ({ sql, values }) => sql.includes('UPDATE user_wallets') && values?.[1] === '1000000',
      ),
    );
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('INSERT INTO wallet_transactions') &&
          values?.[4] === 'cash_deposit' &&
          values?.[5] === depositId,
      ),
    );
  });
});
