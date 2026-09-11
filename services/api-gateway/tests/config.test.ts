import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

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
};

const generated = (label: string): string => createHash('sha256').update(label).digest('base64');

describe('configuration', () => {
  it('loads strict typed values', () => {
    const config = loadConfig(base);
    assert.equal(config.houseEdgeBps, 500);
    assert.equal(config.secureCookies, false);
    assert.equal(config.dataEncryptionKey.length, 32);
    assert.equal(config.minecraftTransfersEnabled, false);
  });

  it('requires HTTPS in production', () => {
    assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }));
  });

  it('rejects short and incorrectly encoded secrets', () => {
    assert.throws(() => loadConfig({ ...base, COOKIE_SECRET: 'short' }));
    assert.throws(() =>
      loadConfig({ ...base, DATA_ENCRYPTION_KEY: Buffer.alloc(31).toString('base64') }),
    );
    assert.throws(() =>
      loadConfig({
        ...base,
        DATA_ENCRYPTION_KEY: `${Buffer.alloc(32, 1).toString('base64')}!!!!`,
      }),
    );
  });

  it('validates bot identities, proxy CIDRs, and bigint limits', () => {
    assert.throws(() => loadConfig({ ...base, BOT_CREDENTIALS_JSON: '{}' }));
    assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: 'true' }));
    assert.throws(() =>
      loadConfig({ ...base, MAX_DAILY_WAGER_MINOR: '9223372036854775808' }),
    );
    assert.throws(() => loadConfig({ ...base, ADMIN_MINECRAFT_IDS: 'NotAUuid' }));
    assert.throws(() => loadConfig({ ...base, AUDIT_LOG_KEY_ID: 'legacy-v1' }));
    assert.throws(() => loadConfig({ ...base, REDIS_URL: 'https://redis.invalid' }));
    assert.throws(() => loadConfig({ ...base, APP_ORIGIN: 'http://localhost:3000/path' }));
    assert.throws(() => loadConfig({ ...base, APP_ORIGIN: 'http://user@localhost:3000' }));
  });

  it('requires one canonical TOTP secret for every administrator identity', () => {
    const identity = 'mc:10000000000040008000000000000001';
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.doesNotThrow(() =>
      loadConfig({
        ...base,
        ADMIN_MINECRAFT_IDS: identity,
        ADMIN_TOTP_SECRETS_JSON: JSON.stringify({ [identity]: secret }),
      }),
    );
    assert.throws(() => loadConfig({ ...base, ADMIN_MINECRAFT_IDS: identity }));
    assert.throws(() =>
      loadConfig({ ...base, ADMIN_TOTP_SECRETS_JSON: JSON.stringify({ [identity]: secret }) }),
    );
    assert.throws(() =>
      loadConfig({
        ...base,
        ADMIN_MINECRAFT_IDS: identity,
        ADMIN_TOTP_SECRETS_JSON: JSON.stringify({ [identity]: secret.toLowerCase() }),
      }),
    );
  });

  it('accepts distinct generated production secrets and rejects secret reuse', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      DATABASE_URL:
        'postgresql://donut_api_login:7VXq0Nw3Kz8P4Yt6Rm2Hs9Bd5Lf1JcUa@postgres:5432/donut_upgrader',
      APP_ORIGIN: 'https://upgrader.example',
      REDIS_URL: 'redis://:strong-ci-password-7Vq9Lm4Xs2@redis:6379/0',
      COOKIE_SECRET: generated('cookie-secret'),
      DATA_ENCRYPTION_KEY: generated('encryption-key'),
      BOT_CREDENTIALS_JSON: JSON.stringify({
        '10000000-0000-4000-8000-000000000001': {
          secret: generated('bot-key'),
          serverHost: 'donutsmp.net',
          username: 'DonutBot',
        },
      }),
      AUDIT_LOG_HMAC_KEY: generated('audit-key'),
      AUDIT_LOG_KEY_ID: 'production-2026-09',
      IP_HASH_KEY: generated('ip-hash-key'),
      ALLOWED_COUNTRIES: 'PL',
    };
    assert.doesNotThrow(() => loadConfig(production));
    assert.throws(() =>
      loadConfig({ ...production, IP_HASH_KEY: production.AUDIT_LOG_HMAC_KEY }),
    );
    assert.throws(() =>
      loadConfig({
        ...production,
        COOKIE_SECRET: 'strong-ci-password-7Vq9Lm4Xs2',
      }),
    );
    assert.throws(() =>
      loadConfig({ ...production, TRUSTED_PROXY_CIDRS: '0.0.0.0/0' }),
    );
    assert.throws(() =>
      loadConfig({ ...production, MINECRAFT_TRANSFERS_ENABLED: 'true' }),
    );
    assert.throws(() => loadConfig({ ...production, ALLOWED_COUNTRIES: ',,,' }));
    assert.throws(() => loadConfig({ ...production, ALLOWED_COUNTRIES: 'PL,,DE' }));
  });
});
