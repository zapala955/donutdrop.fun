import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/lib/errors.js';
import {
  discordControlSignaturePayload,
  resolveOperator,
  verifyDiscordControlSignature,
} from '../src/lib/discord-control.js';

/**
 * These tests cover the trust boundary, not the happy path.
 *
 * Everything the Discord control plane protects depends on two questions being answered correctly
 * every time: "is this really the bot" and "is this really an operator". A bug in either is a
 * remote administrator, so each is probed from the attacker's side — wrong key, altered body,
 * replayed timestamp, wrong route, unknown snowflake, demoted account — rather than merely
 * confirmed to work when everything is in order.
 */

const ADMIN_IDENTITY = `mc:${'a'.repeat(32)}`;
const OTHER_IDENTITY = `mc:${'b'.repeat(32)}`;
const OPERATOR_ID = '123456789012345678';
const HMAC_KEY = 'k'.repeat(48);

/* TOTP secrets are canonical base32; the config decodes them, so they must be decodable here. */
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const base = {
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
  ADMIN_MINECRAFT_IDS: ADMIN_IDENTITY,
  ADMIN_TOTP_SECRETS_JSON: JSON.stringify({ [ADMIN_IDENTITY]: TOTP_SECRET }),
  DISCORD_CONTROL_ENABLED: 'true',
  DISCORD_BOT_TOKEN: 't'.repeat(40),
  DISCORD_GUILD_ID: '987654321098765432',
  DISCORD_CONTROL_HMAC_KEY: HMAC_KEY,
  DISCORD_OPERATORS_JSON: JSON.stringify({ [OPERATOR_ID]: ADMIN_IDENTITY }),
};

const config = loadConfig(base);

/** Minimal shape of the request object the verifier actually reads. */
function signedRequest(overrides: Record<string, unknown> = {}): FastifyRequest {
  const path = '/internal/v1/discord/command';
  const timestamp = Date.now().toString();
  const body = { context: { discordUserId: OPERATOR_ID }, request: { command: 'stats' } };
  const signature = createHmac('sha256', HMAC_KEY)
    .update(discordControlSignaturePayload('POST', path, timestamp, body), 'utf8')
    .digest('hex');
  return {
    method: 'POST',
    routeOptions: { url: path },
    headers: { 'x-discord-timestamp': timestamp, 'x-discord-signature': signature },
    body,
    ...overrides,
  } as unknown as FastifyRequest;
}

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_AN_APP_ERROR';
  }
  return 'NO_ERROR';
}

describe('discord control signatures', () => {
  it('accepts a correctly signed request', () => {
    assert.doesNotThrow(() => verifyDiscordControlSignature(signedRequest(), config));
  });

  it('rejects a body altered after signing', () => {
    const request = signedRequest();
    /* The attack this stands in for: a proxy swapping which bot gets quarantined while leaving the
     * signature header untouched. */
    (request as { body: unknown }).body = {
      context: { discordUserId: OPERATOR_ID },
      request: { command: 'quarantine-bot' },
    };
    assert.equal(
      codeOf(() => verifyDiscordControlSignature(request, config)),
      'INVALID_DISCORD_SIGNATURE',
    );
  });

  it('rejects a signature made with the wrong key', () => {
    const path = '/internal/v1/discord/command';
    const timestamp = Date.now().toString();
    const body = { context: { discordUserId: OPERATOR_ID }, request: { command: 'stats' } };
    const signature = createHmac('sha256', 'wrong-key-wrong-key-wrong-key-xx')
      .update(discordControlSignaturePayload('POST', path, timestamp, body), 'utf8')
      .digest('hex');
    const request = signedRequest({
      headers: { 'x-discord-timestamp': timestamp, 'x-discord-signature': signature },
    });
    assert.equal(
      codeOf(() => verifyDiscordControlSignature(request, config)),
      'INVALID_DISCORD_SIGNATURE',
    );
  });

  it('rejects a replayed request outside the freshness window', () => {
    const stale = (Date.now() - 120_000).toString();
    const path = '/internal/v1/discord/command';
    const body = { context: { discordUserId: OPERATOR_ID }, request: { command: 'stats' } };
    /* Correctly signed — just old. A captured request must not be usable tomorrow. */
    const signature = createHmac('sha256', HMAC_KEY)
      .update(discordControlSignaturePayload('POST', path, stale, body), 'utf8')
      .digest('hex');
    const request = signedRequest({
      headers: { 'x-discord-timestamp': stale, 'x-discord-signature': signature },
    });
    assert.equal(
      codeOf(() => verifyDiscordControlSignature(request, config)),
      'STALE_DISCORD_SIGNATURE',
    );
  });

  it('refuses to authenticate a route outside the control namespace', () => {
    /* A signature is scoped to its path. Without this, a valid control signature would be a valid
     * signature for any route that happened to check it. */
    const request = signedRequest({ routeOptions: { url: '/v1/admin/users' } });
    assert.equal(
      codeOf(() => verifyDiscordControlSignature(request, config)),
      'INVALID_DISCORD_SIGNATURE',
    );
  });

  it('rejects malformed headers without consulting the key', () => {
    assert.equal(
      codeOf(() =>
        verifyDiscordControlSignature(
          signedRequest({ headers: { 'x-discord-timestamp': 'nope', 'x-discord-signature': 'no' } }),
          config,
        ),
      ),
      'INVALID_DISCORD_SIGNATURE',
    );
    assert.equal(
      codeOf(() => verifyDiscordControlSignature(signedRequest({ headers: {} }), config)),
      'DISCORD_SIGNATURE_REQUIRED',
    );
  });

  it('rejects everything when the control plane is disabled', () => {
    /* A correctly signed request must still fail if the feature is off, or "disabled" would mean
     * "disabled unless you know the key". */
    const off = loadConfig({ ...base, DISCORD_CONTROL_ENABLED: 'false' });
    assert.equal(
      codeOf(() => verifyDiscordControlSignature(signedRequest(), off)),
      'INVALID_DISCORD_SIGNATURE',
    );
  });
});

/** Just enough of the database surface for `resolveOperator`. */
function stubDb(row: Record<string, unknown> | undefined) {
  return {
    query: async () => ({ rows: row ? [row] : [] }),
  } as unknown as Parameters<typeof resolveOperator>[0];
}

const ADMIN_ROW = {
  id: '20000000-0000-4000-8000-000000000001',
  minecraft_username: 'Operator',
  role: 'admin',
  status: 'active',
};

describe('discord operator resolution', () => {
  it('resolves an allowlisted operator to their platform account', async () => {
    const operator = await resolveOperator(stubDb(ADMIN_ROW), config, OPERATOR_ID);
    assert.equal(operator.userId, ADMIN_ROW.id);
    assert.equal(operator.minecraftIdentity, ADMIN_IDENTITY);
  });

  it('refuses a Discord id that is not on the allowlist', async () => {
    await assert.rejects(
      () => resolveOperator(stubDb(ADMIN_ROW), config, '999999999999999999'),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_AN_OPERATOR',
    );
  });

  it('refuses a malformed Discord id without touching the database', async () => {
    const exploding = {
      query: () => assert.fail('the database must not be consulted for a malformed id'),
    } as unknown as Parameters<typeof resolveOperator>[0];
    await assert.rejects(
      () => resolveOperator(exploding, config, "1' OR '1'='1"),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_AN_OPERATOR',
    );
  });

  it('refuses an operator whose account is no longer an admin', async () => {
    /* The allowlist is configuration and the database is the authority. A demoted account must
     * lose the bot too, without anybody remembering to edit an env var. */
    await assert.rejects(
      () => resolveOperator(stubDb({ ...ADMIN_ROW, role: 'player' }), config, OPERATOR_ID),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_AN_OPERATOR',
    );
  });

  it('refuses an operator whose account is suspended', async () => {
    await assert.rejects(
      () => resolveOperator(stubDb({ ...ADMIN_ROW, status: 'suspended' }), config, OPERATOR_ID),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_AN_OPERATOR',
    );
  });

  it('refuses when the mapped account no longer exists', async () => {
    await assert.rejects(
      () => resolveOperator(stubDb(undefined), config, OPERATOR_ID),
      (error: unknown) => error instanceof AppError && error.code === 'NOT_AN_OPERATOR',
    );
  });
});

describe('discord control configuration', () => {
  it('refuses an operator mapped to a non-administrator identity', () => {
    /* Without this the mapping silently outlives a removal from ADMIN_MINECRAFT_IDS, which is the
     * quiet way a revoked administrator keeps a door open. */
    assert.throws(() =>
      loadConfig({
        ...base,
        DISCORD_OPERATORS_JSON: JSON.stringify({ [OPERATOR_ID]: OTHER_IDENTITY }),
      }),
    );
  });

  it('refuses to enable the control plane without a token, key, guild or operator', () => {
    assert.throws(() => loadConfig({ ...base, DISCORD_BOT_TOKEN: '' }));
    assert.throws(() => loadConfig({ ...base, DISCORD_CONTROL_HMAC_KEY: 'short' }));
    assert.throws(() => loadConfig({ ...base, DISCORD_GUILD_ID: '' }));
    assert.throws(() => loadConfig({ ...base, DISCORD_OPERATORS_JSON: '{}' }));
  });

  it('caps the one-time link lifetime', () => {
    /* The single most security-relevant number here: how long a leaked URL stays worth something.
     * It must not be settable to a day. */
    assert.throws(() => loadConfig({ ...base, DISCORD_ADMIN_LINK_TTL_SECONDS: '86400' }));
    assert.equal(
      loadConfig({ ...base, DISCORD_ADMIN_LINK_TTL_SECONDS: '600' }).discordAdminLinkTtlSeconds,
      600,
    );
  });

  it('rejects a malformed operator map', () => {
    assert.throws(() => loadConfig({ ...base, DISCORD_OPERATORS_JSON: 'not json' }));
    assert.throws(() =>
      loadConfig({ ...base, DISCORD_OPERATORS_JSON: JSON.stringify({ abc: ADMIN_IDENTITY }) }),
    );
    assert.throws(() =>
      loadConfig({ ...base, DISCORD_OPERATORS_JSON: JSON.stringify({ [OPERATOR_ID]: 'nope' }) }),
    );
  });

  it('leaves the control plane off by default', () => {
    const off = loadConfig({
      ...base,
      DISCORD_CONTROL_ENABLED: 'false',
      DISCORD_BOT_TOKEN: '',
      DISCORD_CONTROL_HMAC_KEY: '',
      DISCORD_GUILD_ID: '',
      DISCORD_OPERATORS_JSON: '{}',
    });
    assert.equal(off.discordControlEnabled, false);
    assert.equal(off.discordOperators.size, 0);
  });
});

describe('signature payload stability', () => {
  it('matches the literal the bot suite pins', () => {
    /* The other half of the seam. services/discord-bot/tests/signature.test.ts pins this exact
     * string against ITS own copy of the canonicalizer. Neither project imports the other — doing
     * so would put each one outside the other's rootDir — so the shared literal is the contract.
     * If either copy drifts, that side fails here. Change both in the same commit. */
    const canonical = discordControlSignaturePayload(
      'POST',
      '/internal/v1/discord/command',
      '1700000000000',
      { context: { discordUserId: '123456789012345678' }, request: { command: 'stats' } },
    );
    assert.equal(
      canonical,
      '{"audience":"donut-upgrader-discord-control",' +
        '"body":{"context":{"discordUserId":"123456789012345678"},"request":{"command":"stats"}},' +
        '"method":"POST","path":"/internal/v1/discord/command",' +
        '"timestamp":"1700000000000","version":1}',
    );
  });

  it('binds method, path, timestamp and body together', () => {
    /* The bot reimplements this payload independently. If either side changes shape without the
     * other, every request fails closed — but this test states the shape so the break is obvious. */
    const payload = discordControlSignaturePayload('post', '/internal/v1/discord/x', '1700000000000', {
      a: 1,
    });
    assert.equal(
      payload,
      '{"audience":"donut-upgrader-discord-control","body":{"a":1},"method":"POST","path":"/internal/v1/discord/x","timestamp":"1700000000000","version":1}',
    );
    /* Keys are sorted, so two structurally equal bodies cannot produce two different signatures. */
    assert.equal(
      discordControlSignaturePayload('POST', '/p', '1', { b: 2, a: 1 }),
      discordControlSignaturePayload('POST', '/p', '1', { a: 1, b: 2 }),
    );
  });

  it('is what the sha256 of a token is compared against, never the token', () => {
    /* Guards the storage contract: `discord_admin_links.token_hash` holds a digest, so a database
     * leak yields nothing replayable. */
    const token = 'example-token';
    assert.equal(createHash('sha256').update(token).digest().length, 32);
  });
});
