import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { RuntimeSettings, runtimeSettingKeys } from '../src/lib/runtime-settings.js';
import type { DbClient } from '../src/lib/db.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
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
  LOG_LEVEL: 'silent',
};
const config = loadConfig(base);

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

  /* The whole point of widening the allow-list. Every one of these is a real dial in the console,
   * and a dial that moves without reaching the code behind it is worse than no dial at all. */
  it('carries every group of control through to the config the routes read', () => {
    const settings = new RuntimeSettings(config);
    settings.apply(
      settings.validate({
        houseEdgeBps: 1200,
        itemSellRateBps: 8500,
        tipMaxMinor: '250000000',
        skillDuelRakeBps: 500,
        vaultJackpotContributionBps: 5,
        lavaRainClaimMinutes: 9,
        sideBetMaxStakeMinor: '75000000',
        rouletteMaxRoundStakeMinor: '7000000000',
        cashOnlyPlay: true,
        raceLeaderboardSize: 25,
      }),
      '10000000-0000-4000-8000-000000000001',
    );
    assert.equal(settings.config.houseEdgeBps, 1200);
    assert.equal(settings.config.itemSellRateBps, 8500);
    assert.equal(settings.config.tipMaxMinor, 250_000_000n);
    assert.equal(settings.config.skillDuelRakeBps, 500);
    assert.equal(settings.config.vaultJackpotContributionBps, 5);
    assert.equal(settings.config.lavaRainClaimMinutes, 9);
    assert.equal(settings.config.sideBetMaxStakeMinor, 75_000_000n);
    assert.equal(settings.config.rouletteMaxRoundStakeMinor, 7_000_000_000n);
    assert.equal(settings.config.cashOnlyPlay, true);
    assert.equal(settings.config.raceLeaderboardSize, 25);
  });

  /* The four rakeback rates hang off a nested frozen object, which a Proxy does not see through.
   * Each is its own key and the composite is rebuilt on read, so this is the one control whose
   * plumbing is not shared with the other fifty-eight. */
  it('recomposes the nested rakeback object from its four separate keys', () => {
    const settings = new RuntimeSettings(config);
    settings.apply(settings.validate({ rakebackDailyBps: 777 }), undefined);
    assert.equal(settings.config.rakebackTierBps.daily, 777);
    assert.equal(settings.config.rakebackTierBps.instant, config.rakebackTierBps.instant);
    assert.equal(config.rakebackTierBps.daily, 500);
    const row = settings.rows().find((entry) => entry.key === 'rakebackDailyBps');
    assert.equal(row?.defaultValue, 500);
    assert.equal(row?.overridden, true);
  });

  /**
   * The guard that matters most, and the reason it lives here rather than only in `buildApp`.
   *
   * `assertVipSolvency` refuses to START the process. Before this, an administrator could save a
   * combination it rejects, watch the site keep serving, and find out at the next deploy that the
   * API would not come back up -- with the offending value sitting in a table no deploy script
   * reads. Rejecting it at the moment it is typed is the only version that cannot become an
   * outage.
   */
  it('refuses a giveback the house edge cannot pay for, at the moment it is typed', () => {
    const settings = new RuntimeSettings(
      loadConfig({ ...base, VIP_ENABLED: 'true', RAKEBACK_ENABLED: 'true' }),
    );
    assert.throws(() => settings.validate({ rakebackInstantBps: 9000 }), /not solvent/);
    // The same insolvency reached from the other side: cut the margin instead of raising the payout.
    assert.throws(() => settings.validate({ houseEdgeBps: 50 }), /not solvent/);
    // And the neighbouring values that are still affordable are not caught by it.
    assert.doesNotThrow(() => settings.validate({ rakebackInstantBps: 1200 }));
    assert.doesNotThrow(() => settings.validate({ houseEdgeBps: 1500 }));
  });

  it('checks a change against the whole config, not only the keys being changed', () => {
    const settings = new RuntimeSettings(config);
    // Raising one half of a pair past the other is refused...
    assert.throws(
      () => settings.validate({ rouletteMaxStakeMinor: '9000000000' }),
      /cannot exceed the table limit/,
    );
    // ...and accepted when the same request moves both.
    assert.doesNotThrow(() =>
      settings.validate({
        rouletteMaxStakeMinor: '9000000000',
        rouletteMaxRoundStakeMinor: '9000000000',
      }),
    );
  });

  /* A reset is a write too. Putting one half of a pair back to its deployment default while the
   * other half stays overridden is the same crossing, approached from the opposite direction. */
  it('validates a reset before it is written, not after', () => {
    const settings = new RuntimeSettings(config);
    settings.apply(
      settings.validate({ tipMinMinor: '400000000', tipMaxMinor: '900000000' }),
      undefined,
    );
    assert.throws(() => settings.validateReset(['tipMaxMinor']), /Minimum tip cannot exceed/);
    assert.deepEqual(settings.validateReset(['tipMinMinor', 'tipMaxMinor']), [
      'tipMinMinor',
      'tipMaxMinor',
    ]);
  });

  /* An audit line saying only what a value became cannot answer the question asked of it later. */
  it('captures the previous value for the audit entry', () => {
    const settings = new RuntimeSettings(config);
    assert.deepEqual(settings.snapshot(['houseEdgeBps', 'tipMaxMinor']), {
      houseEdgeBps: 1000,
      tipMaxMinor: '100000000',
    });
    settings.apply(settings.validate({ houseEdgeBps: 1500 }), undefined);
    assert.deepEqual(settings.snapshot(['houseEdgeBps']), { houseEdgeBps: 1500 });
  });

  it('writes the previous value and a reason into the audit log on both write paths', async () => {
    const route = await read('services/api-gateway/src/routes/admin-operations.ts');
    const update = route.slice(route.indexOf("'/v1/admin/runtime-settings',"));
    assert.match(update, /const before = runtimeSettings\.snapshot\(parsed\.keys\(\)\)/);
    assert.match(update, /previous: before/);
    const reset = route.slice(route.indexOf("'/v1/admin/runtime-settings/reset',"));
    assert.match(reset, /runtimeSettings\.validateReset\(body\.keys\)/);
    assert.match(reset, /previous: before/);
  });

  /* A key here whose consumer reads the frozen boot config would render a dial in the console
   * that moves and changes nothing. These are the values known to be captured once at startup,
   * plus the ones that define the trust boundary this console sits behind. */
  it('keeps boot-captured and trust-boundary values out of the allow-list', () => {
    for (const key of [
      'logLevel',
      'trustedProxyCidrs',
      'sessionTtlHours',
      'appOrigin',
      'cookieSecret',
      'dataEncryptionKey',
      'devLoginEnabled',
      'devLoginToken',
      'physicalCustodyEnabled',
      'minecraftTransfersEnabled',
      'houseStockUnlimited',
      'discordControlEnabled',
      'discordBotToken',
      'turnstileSecretKey',
      'auditLogHmacKey',
    ]) {
      assert.equal(
        runtimeSettingKeys.includes(key as never),
        false,
        `${key} must stay deployment-only`,
      );
    }
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
