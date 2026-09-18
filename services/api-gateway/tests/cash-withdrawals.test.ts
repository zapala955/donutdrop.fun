import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/lib/db.js';
import { registerCashWithdrawalRoutes } from '../src/routes/cash-withdrawals.js';

const botId = '20000000-0000-4000-8000-000000000002';
const userId = '30000000-0000-4000-8000-000000000003';

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
    app: { get: route('GET'), post: route('POST') } as unknown as FastifyInstance,
    handlers,
  };
}

function result<R>(rows: R[]) {
  return { rows, rowCount: rows.length };
}

interface Statement {
  sql: string;
  values: unknown[];
}

/**
 * A database that answers the shapes this route asks for and records everything it was asked.
 *
 * `balance` is what the wallet UPDATE will hand back, and setting it below the requested amount is
 * how the overdraft case is reproduced without a server.
 */
function fakeDb(options: { balance: bigint; botOnline?: boolean; insertConflict?: boolean }) {
  const statements: Statement[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes('FROM bot_accounts')) {
      return options.botOnline === false
        ? result([])
        : result([{ id: botId, username: 'DonutBot', server_host: 'donutsmp.net' }]);
    }
    if (sql.includes('FROM cash_withdrawals WHERE user_id = $1 AND idempotency_key')) {
      return result([]);
    }
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
    if (sql.includes('UPDATE user_wallets SET balance_minor = balance_minor - $2')) {
      const asked = BigInt(String(values[1]));
      return asked > options.balance
        ? result([])
        : result([{ balance_minor: (options.balance - asked).toString() }]);
    }
    if (sql.includes('INSERT INTO cash_withdrawals')) {
      if (options.insertConflict) throw Object.assign(new Error('duplicate'), { code: '23505' });
      const row = {
        id: '40000000-0000-4000-8000-000000000004',
        amount_minor: String(values[4]),
        payee_username: String(values[3]),
        status: String(values[5]),
        error_code: null,
        created_at: new Date(),
        paid_at: null,
      };
      return result([row]);
    }
    return result([]);
  };
  const db = {
    query,
    transaction: async <T>(run: (client: unknown) => Promise<T>) => run({ query }),
  } as unknown as Database;
  return { db, statements };
}

function request(amountMinor: string): FastifyRequest {
  return {
    body: { amountMinor },
    headers: { 'idempotency-key': 'b'.repeat(24) },
    authUser: { id: userId, minecraftUsername: 'zapalka_955' },
  } as unknown as FastifyRequest;
}

function reply(): FastifyReply {
  return {
    code() {
      return this;
    },
  } as unknown as FastifyReply;
}

async function post(options: Parameters<typeof fakeDb>[0], amount: string) {
  const { app, handlers } = captureApp();
  const { db, statements } = fakeDb(options);
  await registerCashWithdrawalRoutes(app, db, config);
  const handler = handlers.get('POST /v1/cash-withdrawals');
  assert.ok(handler, 'route not registered');
  const response = await handler(request(amount), reply());
  return { response: response as { withdrawal: { status: string } }, statements };
}

describe('cash withdrawals', () => {
  it('installs the payout ledger, the one-live guard and the readiness marker', async () => {
    const sql = await readFile(
      path.join(process.cwd(), '../../packages/db/migrations/028_cash_withdrawals.sql'),
      'utf8',
    );
    assert.match(sql, /CREATE TABLE cash_withdrawals/);
    assert.match(sql, /CREATE UNIQUE INDEX cash_withdrawals_one_live_idx/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v28\(\) RETURNS boolean/);
    // The bot has to be allowed to be told about a payout, and the ledger to record one.
    assert.match(sql, /'withdrawal', 'inventory_resync', 'cash_payout'/);
    assert.match(sql, /'cash_withdrawal', 'cash_withdrawal_refund'/);
    assert.match(
      sql,
      /GRANT SELECT, INSERT, UPDATE ON TABLE cash_withdrawals TO donut_api_runtime/,
    );
  });

  it('reads the restriction timestamps from the table that actually has them', async () => {
    /* cooldown_until and self_excluded_until are on responsible_limits. Selecting them from users
     * parses fine in TypeScript and fails only against a real database, which is exactly how it
     * reached production: every test here used a fake that answered whatever it was asked. */
    const { statements } = await post({ balance: 5_000_000n }, '1000000');
    const eligibility = statements.find(({ sql }) => sql.includes('cooldown_until'));
    assert.ok(eligibility, 'no eligibility query was issued');
    assert.match(eligibility.sql, /JOIN responsible_limits/);
    assert.match(eligibility.sql, /limits\.cooldown_until/);
    assert.match(eligibility.sql, /limits\.self_excluded_until/);
  });

  it('offers a payout to a bot that cannot move items', async () => {
    /* The claim route used to require transfer_capable before handing out ANY job, so a bot with
     * item transfers deliberately off received { job: null } on every poll forever, with no error
     * at either end: a queued payout was indistinguishable from an empty queue. Liveness is all a
     * /pay needs; item capability now only decides which kinds are visible. */
    const source = await readFile(path.join(process.cwd(), 'src/routes/minecraft-in.ts'), 'utf8');
    assert.match(source, /AS live,/);
    assert.match(source, /AS item_capable/);
    assert.match(source, /AND \(kind = 'cash_payout' OR \$2::boolean\)/);
  });

  it('debits the wallet before the bot is ever told to pay', async () => {
    const { statements } = await post({ balance: 5_000_000n }, '1000000');
    const debit = statements.findIndex(({ sql }) =>
      sql.includes('UPDATE user_wallets SET balance_minor = balance_minor - $2'),
    );
    const job = statements.findIndex(({ sql }) => sql.includes('INSERT INTO bot_jobs'));
    assert.ok(debit >= 0, 'no debit was issued');
    assert.ok(job > debit, 'the payout job was queued before the money was taken');
  });

  it('writes the debit to the ledger as a negative amount against the payout', async () => {
    const { statements } = await post({ balance: 5_000_000n }, '1000000');
    const ledger = statements.find(
      ({ sql }) =>
        sql.includes('INSERT INTO wallet_transactions') && sql.includes('cash_withdrawal'),
    );
    assert.ok(ledger, 'no ledger row');
    assert.equal(ledger.values[2], '-1000000');
  });

  it('refuses to send more than the balance, and queues nothing when it does', async () => {
    await assert.rejects(() => post({ balance: 100_000n }, '1000000'), /Not enough balance/);
  });

  it('refuses an amount below the floor before touching the wallet', async () => {
    await assert.rejects(() => post({ balance: 5_000_000n }, '500'), /smallest withdrawal/);
  });

  it('holds anything over the ceiling for approval and queues no job for it', async () => {
    const { response, statements } = await post({ balance: 900_000_000n }, '600000000');
    assert.equal(response.withdrawal.status, 'pending_approval');
    assert.ok(
      !statements.some(({ sql }) => sql.includes('INSERT INTO bot_jobs')),
      'a payout awaiting approval must not reach the bot',
    );
  });

  it('queues the bot job itself when the amount is under the ceiling', async () => {
    const { response, statements } = await post({ balance: 900_000_000n }, '500000000');
    assert.equal(response.withdrawal.status, 'queued');
    const job = statements.find(({ sql }) => sql.includes('INSERT INTO bot_jobs'));
    assert.ok(job, 'no job queued');
    assert.match(String(job.values[3]), /"amountMinor":"500000000"/);
  });

  it('turns the one-live-payout index into a conflict rather than a 500', async () => {
    await assert.rejects(
      () => post({ balance: 5_000_000n, insertConflict: true }, '1000000'),
      /already have a withdrawal/,
    );
  });

  it('refuses when no bot is online, before any money moves', async () => {
    const { statements } = await post({ balance: 5_000_000n, botOnline: false }, '1000000').catch(
      (error: Error) => {
        assert.match(error.message, /No payment bot/);
        return { statements: [] as Statement[] };
      },
    );
    assert.ok(
      !statements.some(({ sql }) => sql.includes('balance_minor - $2')),
      'the wallet was debited with nowhere to send the money',
    );
  });
});
