import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createAuthGuards } from '../src/lib/auth.js';
import { canonicalJson, sha256, sha256Hex } from '../src/lib/crypto.js';
import type { Database, DbClient } from '../src/lib/db.js';
import { AppError } from '../src/lib/errors.js';
import { registerAccountRoutes } from '../src/routes/account.js';
import { registerAdminRoutes } from '../src/routes/admin.js';
import { registerAuthRoutes } from '../src/routes/auth.js';

const configInput = {
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
  LOG_LEVEL: 'silent',
};

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function captureApp(): { app: FastifyInstance; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const route = (method: string) => (path: string, _options: unknown, handler: Handler) => {
    handlers.set(`${method} ${path}`, handler);
  };
  return {
    app: {
      get: route('GET'),
      patch: route('PATCH'),
      post: route('POST'),
      put: route('PUT'),
    } as unknown as FastifyInstance,
    handlers,
  };
}

function handlerFor(handlers: Map<string, Handler>, key: string): Handler {
  const handler = handlers.get(key);
  assert.ok(handler, `Missing route handler: ${key}`);
  return handler;
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

  setCookie(): this {
    return this;
  }

  clearCookie(): this {
    return this;
  }
}

function currentAdminTotp(secret: Buffer): string {
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
  return (value % 100_000_000).toString().padStart(8, '0');
}

describe('identity and compliance hardening', () => {
  it('activates only pending-compliance sessions in game-currency-only mode', async () => {
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database = {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push(values ? { sql, values } : { sql });
        if (sql.includes('FROM sessions s')) {
          return result([
            {
              session_id: 'game-session-id',
              user_id: 'game-user-id',
              minecraft_identity: 'game-player-identity',
              minecraft_username: 'GamePlayer',
              role: 'player',
              status: 'pending_compliance',
              csrf_hash: Buffer.alloc(32),
              admin_mfa_verified_at: null,
              admin_mfa_key_fingerprint: null,
            },
          ]);
        }
        if (sql.includes("SET status = 'active'")) return result([{ status: 'active' }]);
        return result([]);
      },
    } as unknown as Database;
    const guards = createAuthGuards(
      database,
      loadConfig({ ...configInput, GAME_CURRENCY_ONLY: 'true' }),
    );
    const request = {
      cookies: { du_session: 'signed-cookie' },
      unsignCookie: () => ({ valid: true, renew: false, value: 'session-token' }),
    } as unknown as FastifyRequest;

    await guards.authenticate(request);

    assert.equal(request.authUser?.status, 'active');
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes("WHERE id = $1 AND status = 'pending_compliance'") &&
          values?.[0] === 'game-user-id',
      ),
    );
  });

  it('demotes an admin removed from the allowlist and revokes every stale session', async () => {
    const statements: string[] = [];
    const database = {
      query: async () =>
        result([
          {
            session_id: 'session-id',
            user_id: 'user-id',
            minecraft_identity: 'minecraft-uuid',
            minecraft_username: 'Player',
            role: 'admin',
            status: 'active',
            csrf_hash: Buffer.alloc(32),
          },
        ]),
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string) => {
            statements.push(sql);
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    const guards = createAuthGuards(database, loadConfig(configInput));
    const request = {
      cookies: { du_session: 'signed-cookie' },
      unsignCookie: () => ({ valid: true, renew: false, value: 'session-token' }),
    } as unknown as FastifyRequest;

    await assert.rejects(
      guards.authenticate(request),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'SESSION_PRIVILEGES_CHANGED' &&
        error.statusCode === 401,
    );
    assert.ok(statements.some((sql) => sql.includes('UPDATE users SET role = $2')));
    assert.ok(statements.some((sql) => sql.includes('UPDATE sessions SET revoked_at = now()')));
  });

  it('denies every admin operation when the administrator account is restricted', async () => {
    const csrfToken = 'csrf-token';
    const adminIdentity = 'mc:10000000000040008000000000000001';
    const restrictedConfig = loadConfig({
      ...configInput,
      ADMIN_MINECRAFT_IDS: adminIdentity,
      ADMIN_TOTP_SECRETS_JSON: JSON.stringify({
        [adminIdentity]: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
      }),
    });
    const restrictedAdminSecret = restrictedConfig.adminTotpSecrets.get(adminIdentity);
    assert.ok(restrictedAdminSecret);
    const restrictedMfaFingerprint = sha256Hex(restrictedAdminSecret);
    const restrictedDatabase = {
      query: async () =>
        result([
          {
            session_id: 'session-id',
            user_id: 'user-id',
            minecraft_identity: adminIdentity,
            minecraft_username: 'Administrator',
            role: 'admin',
            status: 'self_excluded',
            csrf_hash: sha256(csrfToken),
            admin_mfa_verified_at: new Date(),
            admin_mfa_key_fingerprint: restrictedMfaFingerprint,
          },
        ]),
    } as unknown as Database;
    const guards = createAuthGuards(restrictedDatabase, restrictedConfig);
    const request = {
      cookies: { du_session: 'signed-cookie' },
      headers: { origin: restrictedConfig.appOrigin, 'x-csrf-token': csrfToken },
      unsignCookie: () => ({ valid: true, renew: false, value: 'session-token' }),
    } as unknown as FastifyRequest;

    await assert.rejects(
      guards.requireAdmin(request),
      (error: unknown) => error instanceof AppError && error.code === 'ADMIN_REQUIRED',
    );
  });

  it('revokes an administrator session after its TOTP key is rotated', async () => {
    const adminIdentity = 'mc:10000000000040008000000000000001';
    const oldSecret = Buffer.alloc(20, 1);
    const rotatedConfig = loadConfig({
      ...configInput,
      ADMIN_MINECRAFT_IDS: adminIdentity,
      ADMIN_TOTP_SECRETS_JSON: JSON.stringify({ [adminIdentity]: 'A'.repeat(32) }),
    });
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database = {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push(values ? { sql, values } : { sql });
        if (sql.includes('FROM sessions s')) {
          return result([
            {
              session_id: 'rotated-session-id',
              user_id: 'admin-user-id',
              minecraft_identity: adminIdentity,
              minecraft_username: 'Administrator',
              role: 'admin',
              status: 'active',
              csrf_hash: Buffer.alloc(32),
              admin_mfa_verified_at: new Date(),
              admin_mfa_key_fingerprint: sha256Hex(oldSecret),
            },
          ]);
        }
        return result([]);
      },
    } as unknown as Database;
    const guards = createAuthGuards(database, rotatedConfig);
    const request = {
      cookies: { du_session: 'signed-cookie' },
      unsignCookie: () => ({ valid: true, renew: false, value: 'session-token' }),
    } as unknown as FastifyRequest;

    await assert.rejects(
      guards.authenticate(request),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'ADMIN_MFA_REQUIRED' &&
        error.statusCode === 401,
    );
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('UPDATE sessions SET revoked_at = now()') &&
          values?.[0] === 'rotated-session-id',
      ),
    );
    assert.equal(request.authUser, undefined);
  });

  it('releases a recycled username and revokes the previous owner during account linking', async () => {
    const { app, handlers } = captureApp();
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const challengeId = '10000000-0000-4000-8000-000000000001';
    const newUserId = '10000000-0000-4000-8000-000000000002';
    const database = {
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string, values?: readonly unknown[]) => {
            statements.push(values ? { sql, values } : { sql });
            if (sql.includes('FROM auth_link_challenges') && sql.includes('FOR UPDATE')) {
              return result([
                {
                  id: challengeId,
                  requested_username: 'RecycledName',
                  confirmed_identity: 'new-minecraft-uuid',
                  confirmed_username: 'RecycledName',
                  confirmed_at: new Date(),
                  completed_at: null,
                  expired: false,
                },
              ]);
            }
            if (sql.includes('normalized_username = lower($1)')) {
              return result([{ id: 'old-user-id', minecraft_identity: 'old-minecraft-uuid' }]);
            }
            if (sql.includes('SELECT 1 FROM users WHERE normalized_username')) return result([]);
            if (sql.includes('SELECT id, role FROM users')) return result([]);
            if (sql.includes('INSERT INTO users')) {
              return result([
                {
                  id: newUserId,
                  minecraft_identity: 'new-minecraft-uuid',
                  minecraft_username: 'RecycledName',
                  role: 'player',
                  status: 'pending_compliance',
                },
              ]);
            }
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    await registerAuthRoutes(app, database, loadConfig(configInput));
    const complete = handlerFor(handlers, 'POST /v1/auth/link/complete');
    const reply = new ReplyStub();
    await complete(
      {
        body: { challengeId },
        cookies: { du_link: 'signed-link-cookie' },
        headers: { 'user-agent': 'test' },
        ip: '192.0.2.1',
        unsignCookie: () => ({ valid: true, renew: false, value: 'browser-token' }),
      } as unknown as FastifyRequest,
      reply as unknown as FastifyReply,
    );

    const displacedUpdate = statements.find(({ sql }) =>
      sql.includes('UPDATE users SET minecraft_username = $2'),
    );
    assert.ok(displacedUpdate);
    assert.match(String(displacedUpdate.values?.[1]), /^~[a-f0-9]{15}$/);
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('UPDATE sessions SET revoked_at = now()') && values?.[0] === 'old-user-id',
      ),
    );
  });

  it('completes and credits every confirmed payment after its timer expires', async () => {
    const { app, handlers } = captureApp();
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const challengeId = '10000000-0000-4000-8000-000000000061';
    const earlierChallengeId = '10000000-0000-4000-8000-000000000060';
    const userId = '10000000-0000-4000-8000-000000000062';
    const database = {
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string, values?: readonly unknown[]) => {
            statements.push(values ? { sql, values } : { sql });
            if (sql.includes("method = 'payment' AND confirmed_identity")) {
              return result([
                { id: earlierChallengeId, pay_amount: 170 },
                { id: challengeId, pay_amount: 160 },
              ]);
            }
            if (sql.includes('FROM auth_link_challenges') && sql.includes('FOR UPDATE')) {
              return result([
                {
                  id: challengeId,
                  method: 'payment',
                  requested_username: 'PayingPlayer',
                  pay_amount: 160,
                  confirmed_identity: 'paying-player-uuid',
                  confirmed_username: 'PayingPlayer',
                  confirmed_at: new Date(),
                  completed_at: null,
                  attempts: 0,
                  expired: true,
                },
              ]);
            }
            if (sql.includes('FROM users WHERE minecraft_identity')) return result([]);
            if (sql.includes('normalized_username = lower($1)')) return result([]);
            if (sql.includes('INSERT INTO users')) {
              return result([
                {
                  id: userId,
                  minecraft_identity: 'paying-player-uuid',
                  minecraft_username: 'PayingPlayer',
                  role: 'player',
                  status: 'pending_compliance',
                },
              ]);
            }
            if (sql.includes('UPDATE user_wallets')) {
              return result([{ balance_minor: '16000' }]);
            }
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    await registerAuthRoutes(app, database, loadConfig(configInput));
    const complete = handlerFor(handlers, 'POST /v1/auth/link/complete');

    await complete(
      {
        body: { challengeId },
        cookies: { du_link: 'signed-link-cookie' },
        headers: { 'user-agent': 'test' },
        ip: '192.0.2.61',
        unsignCookie: () => ({ valid: true, renew: false, value: 'browser-token' }),
      } as unknown as FastifyRequest,
      new ReplyStub() as unknown as FastifyReply,
    );

    const userInsert = statements.find(({ sql }) => sql.includes('INSERT INTO users'));
    assert.match(userInsert?.sql ?? '', /\$3::varchar\(16\).*lower\(\$3::varchar\(16\)\)/s);
    /* 160, not 16000. This assertion previously carried the scaled figure, which is how a login
     * nonce of $160 came to be paid out as $16,000 with a green suite: the expectation was written
     * from the code rather than from the unit the wallet actually counts, which is whole dollars. */
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('UPDATE user_wallets') && values?.[0] === userId && values?.[1] === '160',
      ),
    );
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('WHERE id = ANY($1::uuid[])') &&
          Array.isArray(values?.[0]) &&
          values[0].includes(challengeId) &&
          values[0].includes(earlierChallengeId),
      ),
    );
    /* The amount, not merely the presence of a row. A credit of the right kind against the right
     * challenge for the wrong number is the shape the 100x pay-login overpayment took, and every
     * assertion here passed throughout it. Both nonces are credited one for one. */
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('INSERT INTO wallet_transactions') &&
          values?.[4] === 'pay_login_deposit' &&
          values?.[5] === challengeId &&
          values?.[2] === '160',
      ),
    );
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('INSERT INTO wallet_transactions') &&
          values?.[4] === 'pay_login_deposit' &&
          values?.[5] === earlierChallengeId &&
          values?.[2] === '170',
      ),
    );
    const creditIndex = statements.findIndex(({ sql }) => sql.includes('UPDATE user_wallets'));
    const completedIndex = statements.findIndex(({ sql }) => sql.includes('SET completed_at'));
    assert.ok(creditIndex >= 0 && completedIndex > creditIndex);
  });

  it('requires and atomically persists administrator MFA during account linking', async () => {
    const { app, handlers } = captureApp();
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const adminIdentity = 'mc:10000000000040008000000000000001';
    const adminId = '10000000-0000-4000-8000-000000000050';
    const challengeId = '10000000-0000-4000-8000-000000000051';
    const adminConfig = loadConfig({
      ...configInput,
      ADMIN_MINECRAFT_IDS: adminIdentity,
      ADMIN_TOTP_SECRETS_JSON: JSON.stringify({
        [adminIdentity]: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      }),
    });
    const database = {
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string, values?: readonly unknown[]) => {
            statements.push(values ? { sql, values } : { sql });
            if (sql.includes('FROM auth_link_challenges') && sql.includes('FOR UPDATE')) {
              return result([
                {
                  id: challengeId,
                  requested_username: 'Administrator',
                  confirmed_identity: adminIdentity,
                  confirmed_username: 'Administrator',
                  confirmed_at: new Date(),
                  completed_at: null,
                  expired: false,
                },
              ]);
            }
            if (sql.includes('normalized_username = lower($1)')) return result([]);
            if (sql.includes('admin_totp_last_counter')) {
              return result([{ id: adminId, role: 'admin', admin_totp_last_counter: null }]);
            }
            if (sql.includes('INSERT INTO users')) {
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
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    await registerAuthRoutes(app, database, adminConfig);
    const complete = handlerFor(handlers, 'POST /v1/auth/link/complete');
    const request = (body: unknown) =>
      ({
        body,
        cookies: { du_link: 'signed-link-cookie' },
        headers: { 'user-agent': 'test' },
        ip: '192.0.2.10',
        unsignCookie: () => ({ valid: true, renew: false, value: 'browser-token' }),
      }) as unknown as FastifyRequest;

    await assert.rejects(
      complete(request({ challengeId }), new ReplyStub() as unknown as FastifyReply),
      (error: unknown) => error instanceof AppError && error.code === 'ADMIN_MFA_REQUIRED',
    );
    statements.length = 0;
    const secret = adminConfig.adminTotpSecrets.get(adminIdentity);
    assert.ok(secret);
    await complete(
      request({ challengeId, adminTotpCode: currentAdminTotp(secret) }),
      new ReplyStub() as unknown as FastifyReply,
    );
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('UPDATE users SET admin_totp_last_counter') &&
          typeof values?.[1] === 'string',
      ),
    );
    assert.ok(
      statements.some(
        ({ sql, values }) => sql.includes('INSERT INTO sessions') && values?.[7] === true,
      ),
    );
    assert.ok(
      statements.some(
        ({ sql, values }) =>
          sql.includes('INSERT INTO sessions') && values?.[8] === sha256Hex(secret),
      ),
    );
  });

  it('uses atomic non-shortening updates for cooldown and self-exclusion', async () => {
    const { app, handlers } = captureApp();
    const statements: string[] = [];
    const database = {
      query: async (sql: string) => {
        statements.push(sql);
        return result([
          {
            id: 'user-id',
            status: 'pending_compliance',
            age_verified_at: null,
            kyc_status: 'not_started',
          },
        ]);
      },
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string) => {
            statements.push(sql);
            if (sql.includes('RETURNING cooldown_until')) {
              return result([{ cooldown_until: new Date(), self_excluded_until: null }]);
            }
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    await registerAccountRoutes(app, database, loadConfig(configInput));
    const requestBase = {
      authUser: { id: 'user-id', sessionId: 'session-id' },
    };

    await handlerFor(handlers, 'PATCH /v1/account')(
      {
        ...requestBase,
        body: { countryCode: 'gb', dateOfBirth: '1990-01-01', acceptTerms: true },
      } as unknown as FastifyRequest,
      {} as FastifyReply,
    );
    await handlerFor(handlers, 'PUT /v1/account/limits')(
      { ...requestBase, body: { cooldownHours: 24 } } as unknown as FastifyRequest,
      {} as FastifyReply,
    );
    await handlerFor(handlers, 'POST /v1/account/self-exclusion')(
      { ...requestBase, body: { durationDays: 30 } } as unknown as FastifyRequest,
      {} as FastifyReply,
    );

    assert.ok(
      statements.some(
        (sql) => sql.includes('age_verified_at = CASE') && sql.includes("THEN 'not_started'"),
      ),
    );
    assert.equal(statements.filter((sql) => sql.includes('GREATEST(')).length, 2);
    assert.ok(
      statements.some(
        (sql) =>
          sql.includes("ELSE 'self_excluded'") && sql.includes("status IN ('suspended', 'closed')"),
      ),
    );
  });

  it('binds admin stock idempotency keys to the canonical request body', async () => {
    const body = {
      catalogItemId: '10000000-0000-4000-8000-000000000010',
      botId: '10000000-0000-4000-8000-000000000011',
      quantity: 2,
      reason: 'Manual inventory recovery',
    };
    const response = { inventoryLotId: '10000000-0000-4000-8000-000000000012', ...body };
    const storedHash = sha256Hex(canonicalJson(body));
    const { app, handlers } = captureApp();
    const database = {
      transaction: async (work: (client: DbClient) => Promise<unknown>) =>
        work({
          query: async (sql: string) => {
            if (sql.includes('SELECT command_type, request_hash, result')) {
              return result([
                { command_type: 'stock.import', request_hash: storedHash, result: response },
              ]);
            }
            return result([]);
          },
        } as unknown as DbClient),
    } as unknown as Database;
    await registerAdminRoutes(app, database, loadConfig(configInput));
    const stock = handlerFor(handlers, 'POST /v1/admin/stock');
    const request = {
      body,
      headers: { 'idempotency-key': 'same-key' },
      authUser: { id: 'admin-id' },
    } as unknown as FastifyRequest;
    const reply = new ReplyStub();

    await stock(request, reply as unknown as FastifyReply);
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(reply.payload, response);

    await assert.rejects(
      stock(
        { ...request, body: { ...body, quantity: 3 } } as unknown as FastifyRequest,
        new ReplyStub() as unknown as FastifyReply,
      ),
      (error: unknown) => error instanceof AppError && error.code === 'IDEMPOTENCY_KEY_REUSED',
    );
  });
});
