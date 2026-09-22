import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { RuntimeSettings } from '../src/lib/runtime-settings.js';
import type { DbClient } from '../src/lib/db.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
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

describe('audited runtime settings', () => {
  it('persists only primitive non-secret settings and advances readiness', async () => {
    const [migration, health, route] = await Promise.all([
      read('packages/db/migrations/041_runtime_settings.sql'),
      read('services/api-gateway/src/routes/health.ts'),
      read('services/api-gateway/src/routes/admin-operations.ts'),
    ]);
    assert.match(migration, /CREATE TABLE runtime_settings/);
    assert.match(migration, /jsonb_typeof\(value\) IN \('boolean', 'number', 'string'\)/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v41\(\)/);
    assert.match(health, /donut_schema_ready_v41\(\)/);
    assert.match(route, /'\/v1\/admin\/runtime-settings'/);
    assert.match(route, /guards\.requireAdmin/);
    assert.match(route, /runtime_settings\.update/);
    assert.doesNotMatch(route, /dataEncryptionKey.*runtimeSettings/);
  });

  it('overlays deployment defaults immediately and preserves the frozen base config', () => {
    const settings = new RuntimeSettings(config);
    const original = config.rouletteRoundSeconds;
    const parsed = settings.validate({
      rouletteRoundSeconds: 25,
      rouletteMinStakeMinor: '100000',
      rouletteMaxStakeMinor: '1000000000',
      chatEnabled: false,
      roulettePaused: true,
    });
    settings.apply(parsed, '10000000-0000-4000-8000-000000000001');
    assert.equal(settings.config.rouletteRoundSeconds, 25);
    assert.equal(settings.config.chatEnabled, false);
    assert.equal(settings.roulettePaused, true);
    assert.equal(config.rouletteRoundSeconds, original);
    assert.equal(Object.isFrozen(config), true);
  });

  it('rejects unknown controls and inconsistent roulette limits', () => {
    const settings = new RuntimeSettings(config);
    assert.throws(() => settings.validate({ secretKey: 'nope' } as never), /runtime-manageable/);
    assert.throws(
      () =>
        settings.validate({
          rouletteMinStakeMinor: '2000000',
          rouletteMaxStakeMinor: '1000000',
        }),
      /minimum cannot exceed maximum/,
    );
  });

  it('loads persisted values and ignores obsolete unknown keys', async () => {
    const settings = new RuntimeSettings(config);
    const client = {
      query: async () => ({
        rows: [
          { key: 'chatSlowModeSeconds', value: 12 },
          { key: 'referralBonusMinor', value: '10000000' },
          { key: 'removedSetting', value: true },
        ],
        rowCount: 3,
      }),
    } as unknown as DbClient;
    await settings.load(client);
    assert.equal(settings.config.chatSlowModeSeconds, 12);
    assert.equal(settings.config.referralBonusMinor, 10_000_000n);
  });
});

describe('schema-drift regression coverage', () => {
  it('keeps live SQL and session types on the post-compliance schema', async () => {
    const [discord, minecraft, types] = await Promise.all([
      read('services/api-gateway/src/routes/discord-control.ts'),
      read('services/api-gateway/src/routes/minecraft-in.ts'),
      read('services/api-gateway/src/types/fastify.d.ts'),
    ]);
    const removed = /kyc_status|country_code|age_verified_at|cooldown_until|self_excluded_until/;
    assert.doesNotMatch(discord, removed);
    assert.doesNotMatch(minecraft, removed);
    assert.doesNotMatch(types, /pending_compliance|self_excluded/);
  });
});
