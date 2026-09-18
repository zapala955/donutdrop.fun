import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import {
  botRequestSignaturePayload as apiRequestPayload,
  botResponseSignaturePayload as apiResponsePayload,
  deriveDepositLeaseToken,
  requireMatchingBotId,
  type AuthenticatedBot,
  verifyBotSignature,
} from '../src/lib/bot-auth.js';
import {
  canonicalJson as apiCanonicalJson,
  hmacHex as apiHmacHex,
  sha256 as apiSha256,
  sha256Hex as apiSha256Hex,
} from '../src/lib/crypto.js';
import type { Database, DbClient } from '../src/lib/db.js';
import { registerMinecraftInternalRoutes } from '../src/routes/minecraft-in.js';
import {
  canonicalJson as botCanonicalJson,
  hmacHex as botHmacHex,
} from '../../minecraft-bot/src/canonical.js';
import {
  botRequestSignaturePayload as botRequestPayload,
  botResponseSignaturePayload as botResponsePayload,
} from '../../minecraft-bot/src/api-client.js';

const firstId = '10000000-0000-4000-8000-000000000001';
const secondId = '20000000-0000-4000-8000-000000000002';
const firstKey = Buffer.from('first-bot-key-material-for-tests!!').subarray(0, 32);
const secondKey = Buffer.from('second-bot-key-material-for-tests!').subarray(0, 32);

function protocolConfig(transfersEnabled = false) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    APP_ORIGIN: 'http://localhost:3000',
    COOKIE_SECRET: 'cookie-secret-that-is-long-enough-for-tests',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    BOT_CREDENTIALS_JSON: JSON.stringify({
      [firstId]: {
        secret: firstKey.toString('base64'),
        serverHost: 'donutsmp.net',
        username: 'DonutBotOne',
      },
      [secondId]: {
        secret: secondKey.toString('base64'),
        serverHost: 'donutsmp.net',
        username: 'DonutBotTwo',
      },
    }),
    AUDIT_LOG_HMAC_KEY: 'audit-secret-that-is-long-enough-for-tests',
    IP_HASH_KEY: 'ip-hash-secret-that-is-long-enough-for-tests',
    MINECRAFT_TRANSFERS_ENABLED: transfersEnabled ? 'true' : 'false',
    LOG_LEVEL: 'silent',
  });
}

describe('internal bot protocol', () => {
  it('canonicalizes and signs bodies identically in both processes', () => {
    const body = {
      type: 'inventory_snapshot',
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94471',
      totals: [
        { quantity: 64, fingerprint: 'a'.repeat(64), metadata: 0, minecraftName: 'diamond' },
      ],
    };
    const apiBody = apiCanonicalJson(body);
    const botBody = botCanonicalJson(body);
    assert.equal(apiBody, botBody);
    const path = '/internal/v1/minecraft/events';
    const timestamp = '1700000000000';
    assert.equal(
      apiRequestPayload('POST', path, '10000000-0000-4000-8000-000000000001', timestamp, body),
      botRequestPayload('POST', path, '10000000-0000-4000-8000-000000000001', timestamp, body),
    );
    assert.equal(apiHmacHex('shared-secret', apiBody), botHmacHex('shared-secret', botBody));
  });

  it('canonicalizes response authentication identically and binds its route', () => {
    const path = '/internal/v1/minecraft/deposits/authorize';
    const requestTimestamp = '1700000000000';
    const responseTimestamp = '1700000000100';
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94471',
      botId: firstId,
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
    };
    const responseBody = {
      authorized: true,
      lease: {
        leaseId: requestBody.eventId,
        depositId: '40000000-0000-4000-8000-000000000004',
        leaseToken: 'b'.repeat(64),
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
      duplicate: false,
    };
    const authenticated: AuthenticatedBot = {
      botId: firstId,
      secret: firstKey,
      expectedServerHost: 'donutsmp.net',
      expectedUsername: 'DonutBotOne',
      method: 'POST',
      path,
      requestTimestamp,
    };

    const apiPayload = apiResponsePayload(
      authenticated,
      responseTimestamp,
      200,
      requestBody,
      responseBody,
    );
    assert.equal(
      apiPayload,
      botResponsePayload(
        'POST',
        path,
        firstId,
        requestTimestamp,
        responseTimestamp,
        200,
        requestBody,
        responseBody,
      ),
    );
    assert.notEqual(
      apiPayload,
      botResponsePayload(
        'POST',
        '/internal/v1/minecraft/jobs/claim',
        firstId,
        requestTimestamp,
        responseTimestamp,
        200,
        requestBody,
        responseBody,
      ),
    );
  });

  it('records abbreviated cash receipts for the matching active player deposit', async () => {
    const config = protocolConfig();
    const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: readonly unknown[]) => {
        statements.push(values ? { sql, values } : { sql });
        if (sql.includes('INSERT INTO inbound_bot_events')) {
          return { rows: [{ event_id: '90b1771b-da27-44c1-9bf0-676b54d94479' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/events';
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94479',
      botId: firstId,
      type: 'cash_payment_observed',
      payer: 'PlayerOne',
      displayedAmount: '1M',
    };
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 200);
      assert.ok(
        statements.some(
          ({ sql, values }) =>
            sql.includes('UPDATE cash_deposit_challenges deposit') &&
            values?.[0] === firstId &&
            values?.[1] === 'PlayerOne' &&
            values?.[2] === '1M',
        ),
      );
    } finally {
      await app.close();
    }
  });

  it('binds each signature to its provisioned bot identity', () => {
    const config = protocolConfig();
    const body = { eventId: '30000000-0000-4000-8000-000000000003', botId: firstId };
    const timestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', '/internal/v1/minecraft/jobs/claim', firstId, timestamp, body),
    );
    const request = {
      body,
      method: 'POST',
      routeOptions: { url: '/internal/v1/minecraft/jobs/claim' },
      headers: {
        'x-bot-id': firstId,
        'x-bot-timestamp': timestamp,
        'x-bot-signature': signature,
      },
    } as unknown as FastifyRequest;

    assert.equal(verifyBotSignature(request, config).botId, firstId);
    assert.throws(() =>
      verifyBotSignature(
        {
          ...request,
          headers: { ...request.headers, 'x-bot-id': secondId },
        } as FastifyRequest,
        config,
      ),
    );
    assert.throws(() =>
      verifyBotSignature(
        {
          ...request,
          routeOptions: { url: '/internal/v1/minecraft/events' },
        } as FastifyRequest,
        config,
      ),
    );
    assert.throws(() => requireMatchingBotId(firstId, secondId));
  });

  it('signs successful authorization responses against the exact request body', async () => {
    const config = protocolConfig(true);
    const depositId = '40000000-0000-4000-8000-000000000004';
    const leaseExpiresAt = new Date(Date.now() + 120_000);
    let storedResponse = '';
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('SELECT body_hash, event_type, response_body')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM deposit_intents d')) {
          return {
            rows: [
              {
                id: depositId,
                bot_id: firstId,
                normalized_username: 'playerone',
                minecraft_identity: `mc:${'a'.repeat(32)}`,
                deposit_status: 'pending',
                expires_at: new Date(Date.now() + 300_000),
                status: 'active',
                country_code: 'pl',
                terms_accepted_at: new Date(),
                age_verified_at: new Date(),
                kyc_status: 'verified',
                cooldown_until: null,
                self_excluded_until: null,
                bot_status: 'online',
                reconciliation_status: 'matched',
                transfer_capable: true,
                last_heartbeat_at: new Date(),
                last_snapshot_at: new Date(),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO deposit_authorization_leases')) {
          return { rows: [{ deposit_id: depositId, expires_at: leaseExpiresAt }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO inbound_bot_events')) {
          storedResponse = String(values?.[4] ?? '');
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/deposits/authorize';
    const requestBody = {
      // This is valid input but is normalized by the API schema for database use.
      eventId: '90B1771B-DA27-44C1-9BF0-676B54D94471',
      botId: firstId,
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
    };
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 200);
      const responseBody = response.json<{
        authorized: boolean;
        lease: { leaseId: string; depositId: string; leaseToken: string; expiresAt: string };
        duplicate: boolean;
      }>();
      assert.equal(responseBody.authorized, true);
      assert.equal(responseBody.lease.leaseId, requestBody.eventId.toLowerCase());
      assert.equal(responseBody.lease.depositId, depositId);
      assert.equal(responseBody.lease.expiresAt, leaseExpiresAt.toISOString());
      assert.equal(
        responseBody.lease.leaseToken,
        deriveDepositLeaseToken(firstKey, firstId, requestBody.eventId.toLowerCase(), depositId),
      );
      assert.doesNotMatch(storedResponse, /leaseToken/);
      const responseTimestamp = response.headers['x-api-timestamp'];
      assert.equal(typeof responseTimestamp, 'string');
      const authenticated: AuthenticatedBot = {
        botId: firstId,
        secret: firstKey,
        expectedServerHost: 'donutsmp.net',
        expectedUsername: 'DonutBotOne',
        method: 'POST',
        path,
        requestTimestamp,
      };
      assert.equal(
        response.headers['x-api-signature'],
        apiHmacHex(
          firstKey,
          apiResponsePayload(
            authenticated,
            responseTimestamp as string,
            response.statusCode,
            requestBody,
            responseBody,
          ),
        ),
      );
    } finally {
      await app.close();
    }
  });

  it('replays the same authorization capability without storing its plaintext token', async () => {
    const config = protocolConfig();
    const path = '/internal/v1/minecraft/deposits/authorize';
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94471',
      botId: firstId,
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
    };
    const depositId = '40000000-0000-4000-8000-000000000004';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const client = {
      query: async (sql: string) => {
        if (sql.includes('SELECT body_hash, event_type, response_body')) {
          return {
            rows: [
              {
                body_hash: apiSha256Hex(apiCanonicalJson(requestBody)),
                event_type: 'deposit_authorization',
                response_body: {
                  authorized: true,
                  lease: { leaseId: requestBody.eventId, depositId, expiresAt },
                },
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        authorized: true,
        lease: {
          leaseId: requestBody.eventId,
          depositId,
          expiresAt,
          leaseToken: deriveDepositLeaseToken(firstKey, firstId, requestBody.eventId, depositId),
        },
        duplicate: true,
      });
    } finally {
      await app.close();
    }
  });

  it('denies a distinct authorization request after the deposit lease is already claimed', async () => {
    const config = protocolConfig(true);
    let storedResponse = '';
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('SELECT body_hash, event_type, response_body')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM deposit_intents d')) {
          return {
            rows: [
              {
                id: '40000000-0000-4000-8000-000000000004',
                bot_id: firstId,
                normalized_username: 'playerone',
                minecraft_identity: `mc:${'a'.repeat(32)}`,
                deposit_status: 'pending',
                expires_at: new Date(Date.now() + 300_000),
                status: 'active',
                country_code: 'pl',
                terms_accepted_at: new Date(),
                age_verified_at: new Date(),
                kyc_status: 'verified',
                cooldown_until: null,
                self_excluded_until: null,
                bot_status: 'online',
                reconciliation_status: 'matched',
                transfer_capable: true,
                last_heartbeat_at: new Date(),
                last_snapshot_at: new Date(),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO deposit_authorization_leases')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO inbound_bot_events')) {
          storedResponse = String(values?.[4] ?? '');
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/deposits/authorize';
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94472',
      botId: firstId,
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
    };
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { authorized: false, lease: null, duplicate: false });
      assert.equal(storedResponse, JSON.stringify({ authorized: false, lease: null }));
    } finally {
      await app.close();
    }
  });

  it('rejects extra authorization fields before opening a database transaction', async () => {
    const config = protocolConfig();
    let transactionOpened = false;
    const database = {
      transaction: async () => {
        transactionOpened = true;
        throw new Error('unexpected transaction');
      },
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/deposits/authorize';
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94471',
      botId: firstId,
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
      authorizeEverything: true,
    };
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(transactionOpened, false);
    } finally {
      await app.close();
    }
  });

  it('does not replay a claim journal entry as a deposit authorization', async () => {
    const config = protocolConfig();
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94471',
      botId: firstId,
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
    };
    const client = {
      query: async (sql: string) => {
        if (sql.includes('SELECT body_hash, event_type, response_body')) {
          return {
            rows: [
              {
                body_hash: apiSha256Hex(apiCanonicalJson(requestBody)),
                event_type: 'job_claim',
                response_body: { authorized: true },
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/deposits/authorize';
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 409);
    } finally {
      await app.close();
    }
  });

  it('rejects replay IDs already journaled under another event type', async () => {
    const config = protocolConfig();
    let submittedBodyHash = '';
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO inbound_bot_events')) {
          submittedBodyHash = String(values?.[3] ?? '');
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT body_hash, event_type FROM inbound_bot_events')) {
          return {
            rows: [{ body_hash: submittedBodyHash, event_type: 'deposit_authorization' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/events';
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94471',
      botId: firstId,
      type: 'heartbeat',
      username: 'DonutBotOne',
      serverHost: 'donutsmp.net',
      online: true,
      snapshotHealthy: true,
      transferCapable: false,
    };
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 409);
    } finally {
      await app.close();
    }
  });

  it('accepts a valid lease-bound deposit confirmation exactly once', async () => {
    const config = protocolConfig(true);
    const eventId = '90b1771b-da27-44c1-9bf0-676b54d94473';
    const leaseId = '80b1771b-da27-44c1-9bf0-676b54d94473';
    const leaseToken = 'c'.repeat(64);
    const fingerprint = 'b'.repeat(64);
    let journaled = false;
    let journalHash = '';
    let inventoryInserts = 0;
    let custodyInserts = 0;
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO inbound_bot_events')) {
          if (journaled) return { rows: [], rowCount: 0 };
          journaled = true;
          journalHash = String(values?.[3] ?? '');
          return { rows: [{ event_id: eventId }], rowCount: 1 };
        }
        if (sql.includes('SELECT body_hash, event_type FROM inbound_bot_events')) {
          return {
            rows: [{ body_hash: journalHash, event_type: 'deposit_confirmed' }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM deposit_intents d')) {
          return {
            rows: [
              {
                id: '40000000-0000-4000-8000-000000000004',
                user_id: '50000000-0000-4000-8000-000000000005',
                bot_id: firstId,
                normalized_username: 'playerone',
                minecraft_identity: `mc:${'a'.repeat(32)}`,
                deposit_status: 'pending',
                expires_at: new Date(Date.now() + 60_000),
                status: 'active',
                country_code: 'pl',
                terms_accepted_at: new Date(),
                age_verified_at: new Date(),
                kyc_status: 'verified',
                cooldown_until: null,
                self_excluded_until: null,
                bot_status: 'online',
                reconciliation_status: 'matched',
                transfer_capable: true,
                last_heartbeat_at: new Date(),
                last_snapshot_at: new Date(),
                lease_id: leaseId,
                lease_bot_id: firstId,
                lease_token_hash: apiSha256(leaseToken),
                lease_expires_at: new Date(Date.now() + 60_000),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT id, fingerprint FROM catalog_items')) {
          return {
            rows: [{ id: '60000000-0000-4000-8000-000000000006', fingerprint }],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO inventory_lots')) inventoryInserts += 1;
        if (sql.includes('INSERT INTO custody_movements')) custodyInserts += 1;
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/events';
    const requestBody = {
      eventId,
      botId: firstId,
      type: 'deposit_confirmed',
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
      leaseId,
      leaseToken,
      items: [{ fingerprint, quantity: 2 }],
    };
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const first = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      const replay = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });

      assert.equal(first.statusCode, 200);
      assert.deepEqual(first.json(), { accepted: true, duplicate: false });
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(replay.json(), { accepted: true, duplicate: true });
      assert.equal(inventoryInserts, 1);
      assert.equal(custodyInserts, 1);
    } finally {
      await app.close();
    }
  });

  it('quarantines a pending deposit with an invalid lease token without crediting it', async () => {
    const config = protocolConfig(true);
    const queries: string[] = [];
    const leaseId = '80b1771b-da27-44c1-9bf0-676b54d94474';
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('INSERT INTO inbound_bot_events')) {
          return { rows: [{ event_id: '90b1771b-da27-44c1-9bf0-676b54d94474' }], rowCount: 1 };
        }
        if (sql.includes('FROM deposit_intents d')) {
          return {
            rows: [
              {
                id: '40000000-0000-4000-8000-000000000004',
                user_id: '50000000-0000-4000-8000-000000000005',
                bot_id: firstId,
                normalized_username: 'playerone',
                minecraft_identity: `mc:${'a'.repeat(32)}`,
                deposit_status: 'pending',
                expires_at: new Date(Date.now() + 60_000),
                status: 'active',
                country_code: 'pl',
                terms_accepted_at: new Date(),
                age_verified_at: new Date(),
                kyc_status: 'verified',
                cooldown_until: null,
                self_excluded_until: null,
                bot_status: 'online',
                reconciliation_status: 'matched',
                transfer_capable: true,
                last_heartbeat_at: new Date(),
                last_snapshot_at: new Date(),
                lease_id: leaseId,
                lease_bot_id: firstId,
                lease_token_hash: apiSha256('d'.repeat(64)),
                lease_expires_at: new Date(Date.now() + 60_000),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE bot_jobs')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as DbClient;
    const database = {
      transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) => work(client),
    } as unknown as Database;
    const app = Fastify({ logger: false });
    await registerMinecraftInternalRoutes(app, database, config);
    const path = '/internal/v1/minecraft/events';
    const requestBody = {
      eventId: '90b1771b-da27-44c1-9bf0-676b54d94474',
      botId: firstId,
      type: 'deposit_confirmed',
      depositCode: 'ABCDEFGHJKMN',
      username: 'PlayerOne',
      identity: `mc:${'a'.repeat(32)}`,
      leaseId,
      leaseToken: 'c'.repeat(64),
      items: [{ fingerprint: 'b'.repeat(64), quantity: 1 }],
    };
    const requestTimestamp = Date.now().toString();
    const signature = apiHmacHex(
      firstKey,
      apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          'x-bot-id': firstId,
          'x-bot-timestamp': requestTimestamp,
          'x-bot-signature': signature,
        },
        payload: requestBody,
      });
      assert.equal(response.statusCode, 200);
      assert.ok(queries.some((sql) => sql.includes("SET status = 'manual_review'")));
      assert.ok(queries.some((sql) => sql.includes("status = 'quarantined'")));
      assert.equal(
        queries.some((sql) => sql.includes('INSERT INTO inventory_lots')),
        false,
      );
      assert.equal(
        queries.some((sql) => sql.includes('INSERT INTO custody_movements')),
        false,
      );
    } finally {
      await app.close();
    }
  });

  it('journals late physical deposits without crediting resolved intents', async () => {
    const config = protocolConfig();
    const statuses = ['expired', 'cancelled', 'confirmed'] as const;

    for (const [index, depositStatus] of statuses.entries()) {
      const leaseId = `80b1771b-da27-44c1-9bf0-676b54d9447${index + 1}`;
      const leaseToken = 'c'.repeat(64);
      const queries: string[] = [];
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes('FROM deposit_intents d')) {
            return {
              rows: [
                {
                  id: '40000000-0000-4000-8000-000000000004',
                  user_id: '50000000-0000-4000-8000-000000000005',
                  bot_id: firstId,
                  normalized_username: 'playerone',
                  minecraft_identity: `mc:${'a'.repeat(32)}`,
                  deposit_status: depositStatus,
                  expires_at: new Date(Date.now() + 60_000),
                  status: 'active',
                  country_code: 'pl',
                  terms_accepted_at: new Date(),
                  age_verified_at: new Date(),
                  kyc_status: 'verified',
                  cooldown_until: null,
                  self_excluded_until: null,
                  bot_status: 'online',
                  reconciliation_status: 'matched',
                  transfer_capable: true,
                  last_heartbeat_at: new Date(),
                  last_snapshot_at: new Date(),
                  lease_id: leaseId,
                  lease_bot_id: firstId,
                  lease_token_hash: apiSha256(leaseToken),
                  lease_expires_at: new Date(Date.now() + 60_000),
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes('UPDATE bot_jobs')) return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: 1 };
        },
      } as unknown as DbClient;
      const database = {
        transaction: async (work: (transactionClient: DbClient) => Promise<unknown>) =>
          work(client),
      } as unknown as Database;
      const app = Fastify({ logger: false });
      await registerMinecraftInternalRoutes(app, database, config);
      const path = '/internal/v1/minecraft/events';
      const requestBody = {
        eventId: `90b1771b-da27-44c1-9bf0-676b54d9447${index + 1}`,
        botId: firstId,
        type: 'deposit_confirmed',
        depositCode: 'ABCDEFGHJKMN',
        username: 'PlayerOne',
        identity: `mc:${'a'.repeat(32)}`,
        leaseId,
        leaseToken,
        items: [{ fingerprint: 'b'.repeat(64), quantity: 1 }],
      };
      const requestTimestamp = Date.now().toString();
      const signature = apiHmacHex(
        firstKey,
        apiRequestPayload('POST', path, firstId, requestTimestamp, requestBody),
      );

      try {
        const response = await app.inject({
          method: 'POST',
          url: path,
          headers: {
            'x-bot-id': firstId,
            'x-bot-timestamp': requestTimestamp,
            'x-bot-signature': signature,
          },
          payload: requestBody,
        });
        assert.equal(response.statusCode, 200, depositStatus);
        assert.deepEqual(response.json(), { accepted: true, duplicate: false });
        assert.ok(queries.some((sql) => sql.includes('UPDATE deposit_intents')));
        assert.ok(queries.some((sql) => sql.includes('UPDATE bot_accounts')));
        assert.ok(queries.some((sql) => sql.includes('INSERT INTO inbound_bot_events')));
        assert.equal(
          queries.some((sql) => sql.includes('INSERT INTO inventory_lots')),
          false,
        );
        assert.equal(
          queries.some((sql) => sql.includes('INSERT INTO custody_movements')),
          false,
        );
      } finally {
        await app.close();
      }
    }
  });
});
