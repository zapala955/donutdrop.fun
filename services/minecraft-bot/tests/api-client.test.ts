import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiClient, botResponseSignaturePayload, type DepositLease } from '../src/api-client.js';
import { canonicalJson, hmacHex } from '../src/canonical.js';
import { loadBotConfig, type BotConfig } from '../src/config.js';

const environment = {
  NODE_ENV: 'test',
  MINECRAFT_HOST: 'donutsmp.net',
  MINECRAFT_USERNAME: 'bot-account@example.com',
  MINECRAFT_EXPECTED_USERNAME: 'DonutBot',
  MINECRAFT_PROFILES_FOLDER: '/tmp/minecraft-auth',
  BOT_ID: '10000000-0000-4000-8000-000000000001',
  API_INTERNAL_URL: 'http://api:3001/internal/v1/minecraft',
  BOT_WEBHOOK_SECRET: Buffer.alloc(32, 7).toString('base64'),
};

const lease: DepositLease = {
  leaseId: '20000000-0000-4000-8000-000000000001',
  depositId: '30000000-0000-4000-8000-000000000001',
  leaseToken: 'ab'.repeat(32),
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function signedFetch(
  config: BotConfig,
  response: unknown | ((requestBody: Record<string, unknown>) => unknown),
  inspectRequest: (path: string, body: Record<string, unknown>, init: RequestInit) => void = () =>
    undefined,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assert.ok(init);
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    const requestTimestamp = headers.get('x-bot-timestamp');
    assert.ok(requestTimestamp);
    const requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    inspectRequest(url.pathname, requestBody, init);
    const responseBody = typeof response === 'function' ? response(requestBody) : response;
    const responseTimestamp = Date.now().toString();
    const signature = hmacHex(
      config.webhookSecret,
      botResponseSignaturePayload(
        'POST',
        url.pathname,
        config.botId,
        requestTimestamp,
        responseTimestamp,
        200,
        requestBody,
        responseBody,
      ),
    );
    return new Response(canonicalJson(responseBody), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-api-timestamp': responseTimestamp,
        'x-api-signature': signature,
      },
    });
  }) as typeof fetch;
}

async function withFetch<T>(replacement: typeof fetch, operation: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = replacement;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('authenticated API client', () => {
  it('returns only a strict, lease-bound deposit authorization', async () => {
    const config = loadBotConfig(environment);
    const result = await withFetch(
      signedFetch(config, (requestBody: Record<string, unknown>) => ({
        authorized: true,
        lease: { ...lease, leaseId: requestBody['eventId'] },
        duplicate: false,
      })),
      () =>
        new ApiClient(config).authorizeDeposit('ABCDEFGHJKMN', 'PlayerOne', `mc:${'a'.repeat(32)}`),
    );

    assert.equal(result?.depositId, lease.depositId);
    assert.equal(result?.leaseToken, lease.leaseToken);
    assert.match(result?.leaseId ?? '', /^[a-f0-9-]{36}$/);
    assert.ok(Object.isFrozen(result));
  });

  it('maps an exact denied authorization to null', async () => {
    const config = loadBotConfig(environment);
    const responseBody = { authorized: false, lease: null, duplicate: true };
    const result = await withFetch(signedFetch(config, responseBody), () =>
      new ApiClient(config).authorizeDeposit('ABCDEFGHJKMN', 'PlayerOne', `mc:${'a'.repeat(32)}`),
    );

    assert.equal(result, null);
  });

  it('rejects a lease ID that is not the authorization event ID', async () => {
    const config = loadBotConfig(environment);
    const responseBody = { authorized: true, lease, duplicate: false };

    await assert.rejects(
      withFetch(signedFetch(config, responseBody), () =>
        new ApiClient(config).authorizeDeposit('ABCDEFGHJKMN', 'PlayerOne', `mc:${'a'.repeat(32)}`),
      ),
      /bound to another request/i,
    );
  });

  it('rejects signed authorization responses with extra fields', async () => {
    const config = loadBotConfig(environment);
    const responseBody = { authorized: true, lease, duplicate: false, unexpected: true };

    await assert.rejects(
      withFetch(signedFetch(config, responseBody), () =>
        new ApiClient(config).authorizeDeposit('ABCDEFGHJKMN', 'PlayerOne', `mc:${'a'.repeat(32)}`),
      ),
      /unrecognized_keys/i,
    );
  });

  it('rejects uppercase capability tokens and non-absolute expiries', async () => {
    const config = loadBotConfig(environment);
    for (const invalidLease of [
      { ...lease, leaseToken: lease.leaseToken.toUpperCase() },
      { ...lease, expiresAt: '2099-01-01T00:00:00' },
    ]) {
      const responseBody = { authorized: true, lease: invalidLease, duplicate: false };
      await assert.rejects(
        withFetch(signedFetch(config, responseBody), () =>
          new ApiClient(config).authorizeDeposit(
            'ABCDEFGHJKMN',
            'PlayerOne',
            `mc:${'a'.repeat(32)}`,
          ),
        ),
      );
    }
  });

  it('binds a deposit confirmation to the authorization lease and validates items', async () => {
    const config = loadBotConfig(environment);
    let captured: Record<string, unknown> | undefined;
    const responseBody = { accepted: true, duplicate: false };
    await withFetch(
      signedFetch(config, responseBody, (path, body) => {
        assert.equal(path, '/internal/v1/minecraft/events');
        captured = body;
      }),
      () =>
        new ApiClient(config).confirmDeposit(
          'ABCDEFGHJKMN',
          'PlayerOne',
          `mc:${'a'.repeat(32)}`,
          lease,
          [{ fingerprint: 'cd'.repeat(32), quantity: 2 }],
        ),
    );

    assert.equal(captured?.['type'], 'deposit_confirmed');
    assert.equal(captured?.['leaseId'], lease.leaseId);
    assert.equal(captured?.['leaseToken'], lease.leaseToken);
    assert.deepEqual(captured?.['items'], [{ fingerprint: 'cd'.repeat(32), quantity: 2 }]);

    await assert.rejects(
      new ApiClient(config).confirmDeposit(
        'ABCDEFGHJKMN',
        'PlayerOne',
        `mc:${'a'.repeat(32)}`,
        lease,
        [
          { fingerprint: 'cd'.repeat(32), quantity: 1 },
          { fingerprint: 'cd'.repeat(32), quantity: 1 },
        ],
      ),
      /duplicate fingerprints/i,
    );
  });
});
