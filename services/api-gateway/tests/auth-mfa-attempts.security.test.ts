import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import type { Database, DbClient } from '../src/lib/db.js';
import { AppError } from '../src/lib/errors.js';
import { registerAuthRoutes } from '../src/routes/auth.js';

const adminIdentity = 'mc:10000000000040008000000000000001';
const adminId = '10000000-0000-4000-8000-000000000050';
const challengeId = '10000000-0000-4000-8000-000000000051';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  PUBLIC_BASE_URL: 'http://localhost:3001',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  INTERNAL_WEBHOOK_SECRET: 'w'.repeat(32),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000099': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  ADMIN_MINECRAFT_IDS: adminIdentity,
  ADMIN_TOTP_SECRETS_JSON: JSON.stringify({
    [adminIdentity]: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  }),
  LOG_LEVEL: 'silent',
});

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function captureApp(): { app: FastifyInstance; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const route =
    (method: string) =>
    (...args: unknown[]) => {
      const path = args[0] as string;
      const handler = args.at(-1) as Handler;
      handlers.set(`${method} ${path}`, handler);
    };
  return {
    app: {
      get: route('GET'),
      post: route('POST'),
    } as unknown as FastifyInstance,
    handlers,
  };
}

function result<R>(rows: R[]) {
  return { rows, rowCount: rows.length };
}

class ReplyStub {
  send(payload?: unknown): unknown {
    return payload;
  }

  setCookie(): this {
    return this;
  }

  clearCookie(): this {
    return this;
  }
}

interface FakeState {
  attempts: number;
  expired: boolean;
  completed: boolean;
  lastAcceptedCounter: bigint | null;
}

class SerializedMfaDatabase {
  readonly state: FakeState;
  readonly statements: string[] = [];
  committedTransactions = 0;
  rolledBackTransactions = 0;
  userWrites = 0;
  sessionWrites = 0;
  challengeAttemptWrites = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(initial?: Partial<FakeState>) {
    this.state = {
      attempts: 0,
      expired: false,
      completed: false,
      lastAcceptedCounter: null,
      ...initial,
    };
  }

  async query(sql: string) {
    if (sql.includes('FROM auth_link_challenges')) return result([this.challengeRow()]);
    return result([]);
  }

  async transaction<T>(work: (client: DbClient) => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      const value = await work({ query: this.clientQuery.bind(this) } as unknown as DbClient);
      this.committedTransactions += 1;
      return value;
    } catch (error) {
      this.rolledBackTransactions += 1;
      throw error;
    } finally {
      release();
    }
  }

  private challengeRow() {
    return {
      id: challengeId,
      requested_username: 'Administrator',
      confirmed_identity: adminIdentity,
      confirmed_username: 'Administrator',
      confirmed_at: new Date(),
      completed_at: this.state.completed ? new Date() : null,
      attempts: this.state.attempts,
      expired: this.state.expired,
    };
  }

  private async clientQuery(sql: string, values?: unknown[]) {
    this.statements.push(sql);
    if (sql.includes('FROM auth_link_challenges') && sql.includes('FOR UPDATE')) {
      return result([this.challengeRow()]);
    }
    if (sql.includes('FROM users WHERE minecraft_identity')) {
      return result([
        {
          id: adminId,
          role: 'admin',
          admin_totp_last_counter:
            this.state.lastAcceptedCounter === null
              ? null
              : this.state.lastAcceptedCounter.toString(),
        },
      ]);
    }
    if (sql.includes('SET attempts = attempts + 1')) {
      this.state.attempts += 1;
      this.challengeAttemptWrites += 1;
      if (this.state.attempts >= Number(values?.[1])) this.state.expired = true;
      return result([]);
    }
    if (sql.includes('normalized_username = lower($1)')) return result([]);
    if (sql.includes('INSERT INTO users')) {
      this.userWrites += 1;
      return result([
        {
          id: adminId,
          minecraft_identity: adminIdentity,
          minecraft_username: 'Administrator',
          role: 'admin',
          status: 'pending_compliance',
        },
      ]);
    }
    if (sql.includes('UPDATE users SET admin_totp_last_counter')) {
      this.userWrites += 1;
      this.state.lastAcceptedCounter = BigInt(String(values?.[1]));
      return result([]);
    }
    if (sql.includes('UPDATE users') || sql.includes('INSERT INTO responsible_limits')) {
      this.userWrites += 1;
      return result([]);
    }
    if (sql.includes('INSERT INTO sessions') || sql.includes('UPDATE sessions')) {
      this.sessionWrites += 1;
      return result([]);
    }
    if (sql.includes('SET completed_at = now()')) {
      this.state.completed = true;
      return result([]);
    }
    return result([]);
  }
}

function request(body: unknown, ip: string): FastifyRequest {
  return {
    body,
    cookies: { du_link: 'signed-link-cookie' },
    headers: { 'user-agent': 'test' },
    ip,
    unsignCookie: () => ({ valid: true, renew: false, value: 'browser-token' }),
  } as unknown as FastifyRequest;
}

function currentAdminTotp(secret: Buffer): { code: string; counter: bigint } {
  const counter = BigInt(Math.floor(Date.now() / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha256', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) >>>
    0;
  return { code: (value % 100_000_000).toString().padStart(8, '0'), counter };
}

async function completionHandler(database: SerializedMfaDatabase): Promise<Handler> {
  const { app, handlers } = captureApp();
  await registerAuthRoutes(app, database as unknown as Database, config);
  const handler = handlers.get('POST /v1/auth/link/complete');
  assert.ok(handler);
  return handler;
}

describe('administrator MFA challenge attempt budget', () => {
  it('serializes attempts from different IPs, commits each failure, and locks at five', async () => {
    const database = new SerializedMfaDatabase();
    const complete = await completionHandler(database);
    const attempts = await Promise.allSettled([
      complete(request({ challengeId }, '192.0.2.1'), new ReplyStub() as unknown as FastifyReply),
      complete(
        request({ challengeId, adminTotpCode: 'malformed' }, '192.0.2.2'),
        new ReplyStub() as unknown as FastifyReply,
      ),
      complete(
        request({ challengeId, adminTotpCode: 'malformed' }, '192.0.2.3'),
        new ReplyStub() as unknown as FastifyReply,
      ),
      complete(
        request({ challengeId, adminTotpCode: 'malformed' }, '192.0.2.4'),
        new ReplyStub() as unknown as FastifyReply,
      ),
      complete(
        request({ challengeId, adminTotpCode: 'malformed' }, '192.0.2.5'),
        new ReplyStub() as unknown as FastifyReply,
      ),
    ]);

    assert.ok(attempts.every((attempt) => attempt.status === 'rejected'));
    assert.equal(database.state.attempts, 5);
    assert.equal(database.state.expired, true);
    assert.equal(database.challengeAttemptWrites, 5);
    assert.equal(database.committedTransactions, 5);
    assert.equal(database.rolledBackTransactions, 0);
    assert.equal(database.userWrites, 0);
    assert.equal(database.sessionWrites, 0);
    assert.equal(
      attempts.filter(
        (attempt) =>
          attempt.status === 'rejected' &&
          attempt.reason instanceof AppError &&
          attempt.reason.code === 'ADMIN_MFA_CHALLENGE_LOCKED',
      ).length,
      1,
    );

    const secret = config.adminTotpSecrets.get(adminIdentity);
    assert.ok(secret);
    await assert.rejects(
      complete(
        request({ challengeId, adminTotpCode: currentAdminTotp(secret).code }, '198.51.100.9'),
        new ReplyStub() as unknown as FastifyReply,
      ),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 423 &&
        error.code === 'ADMIN_MFA_CHALLENGE_LOCKED',
    );
    assert.equal(database.state.attempts, 5);
    assert.equal(database.userWrites, 0);
    assert.equal(database.sessionWrites, 0);
  });

  it('allows a valid code before the cap and persists the replay counter atomically', async () => {
    const database = new SerializedMfaDatabase({ attempts: 4 });
    const complete = await completionHandler(database);
    const secret = config.adminTotpSecrets.get(adminIdentity);
    assert.ok(secret);
    const current = currentAdminTotp(secret);

    await complete(
      request({ challengeId, adminTotpCode: current.code }, '203.0.113.10'),
      new ReplyStub() as unknown as FastifyReply,
    );

    assert.equal(database.state.attempts, 4);
    assert.equal(database.state.completed, true);
    assert.equal(database.state.lastAcceptedCounter, current.counter);
    assert.ok(database.userWrites >= 2);
    assert.equal(database.sessionWrites, 1);
    assert.equal(database.committedTransactions, 1);
    assert.equal(database.rolledBackTransactions, 0);
  });

  it('counts a replayed administrator code without any account or session side effects', async () => {
    const secret = config.adminTotpSecrets.get(adminIdentity);
    assert.ok(secret);
    const current = currentAdminTotp(secret);
    const database = new SerializedMfaDatabase({ lastAcceptedCounter: current.counter });
    const complete = await completionHandler(database);

    await assert.rejects(
      complete(
        request({ challengeId, adminTotpCode: current.code }, '203.0.113.20'),
        new ReplyStub() as unknown as FastifyReply,
      ),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ADMIN_MFA',
    );

    assert.equal(database.state.attempts, 1);
    assert.equal(database.challengeAttemptWrites, 1);
    assert.equal(database.userWrites, 0);
    assert.equal(database.sessionWrites, 0);
    assert.equal(database.committedTransactions, 1);
    assert.equal(database.rolledBackTransactions, 0);
    assert.equal(
      database.statements.some((sql) => sql.includes('normalized_username = lower($1)')),
      false,
    );
  });
});
