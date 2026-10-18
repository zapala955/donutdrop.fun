import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { staffPredicate } from '../src/lib/admin-stats.js';
import {
  DEMO_IDENTITY_PREFIX,
  TEST_MODE_ROUTES,
  accountId,
  flexName,
  notDemoPredicate,
  testModeAllows,
} from '../src/lib/media-test.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';
import type { AuthUser } from '../src/types/fastify.js';

const root = path.resolve(import.meta.dirname, '../../..');
const src = (file: string) => readFile(path.join(root, 'services/api-gateway/src', file), 'utf8');

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '20000000-0000-4000-8000-000000000002': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  GAME_CURRENCY_ONLY: 'true',
  LOG_LEVEL: 'silent',
};

const creator: AuthUser = {
  id: '30000000-0000-4000-8000-000000000003',
  sessionId: '40000000-0000-4000-8000-000000000004',
  minecraftIdentity: 'mc:creator',
  minecraftUsername: 'Creator',
  role: 'player',
  status: 'active',
  csrfHash: Buffer.alloc(32),
};
const twin: AuthUser = {
  ...creator,
  id: '50000000-0000-4000-8000-000000000005',
  minecraftIdentity: `${DEMO_IDENTITY_PREFIX}${creator.id}`,
  demoOf: creator.id,
};

describe('media test mode', () => {
  it('is on by default with a 1B play balance, and both are live settings', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.mediaTestModeEnabled, true);
    assert.equal(config.mediaTestBalanceMinor, 1_000_000_000n);
    assert.equal(runtimeSettingDefinitions.mediaTestModeEnabled.kind, 'boolean');
    assert.equal(runtimeSettingDefinitions.mediaTestBalanceMinor.kind, 'bigint');
    const off = loadConfig({ ...baseEnv, MEDIA_TEST_MODE_ENABLED: 'false' });
    assert.equal(off.mediaTestModeEnabled, false);
  });

  it('lets a test session write only to the house games, an item sale and the switch', () => {
    for (const route of [
      'POST /v1/cases/:id/open',
      'POST /v1/upgrades',
      'POST /v1/mines/games/:id/cashout',
      'POST /v1/tower/games/:id/pick',
      'POST /v1/chicken/games/:id/step',
      'POST /v1/dice/bets',
      'POST /v1/plinko/bets',
      'POST /v1/slots/spins',
      'POST /v1/blackjack/hands/:id/actions',
      'POST /v1/crash/bets',
      'POST /v1/roulette/bets',
      'POST /v1/media/test-mode',
    ]) {
      const [method, url] = route.split(' ');
      assert.ok(testModeAllows(method ?? '', url), route);
    }
    /* Every door play money could leave by: payouts, transfers, tips, rain, player-vs-player
     * stakes, referral and reward claims, chat, the admin console. */
    for (const route of [
      'POST /v1/cash-withdrawals',
      'POST /v1/withdrawals',
      'POST /v1/social/tip',
      'POST /v1/social/rain/claim',
      'POST /v1/coinflip',
      'POST /v1/coinflip/:code/join',
      'POST /v1/duels',
      'POST /v1/mines-duel',
      'POST /v1/battles/:code/join',
      'POST /v1/sidebets/:id/bet',
      'POST /v1/referrals/attach',
      'POST /v1/referrals/claim',
      'POST /v1/rakeback/claim',
      'POST /v1/vault/yield/claim',
      'POST /v1/community/cases',
      'POST /v1/chat',
      'POST /v1/discord/daily-code/redeem',
      'PATCH /v1/admin/runtime-settings',
    ]) {
      const [method, url] = route.split(' ');
      assert.equal(testModeAllows(method ?? '', url), false, route);
    }
    assert.equal(testModeAllows('POST', undefined), false);
    for (const route of TEST_MODE_ROUTES) assert.match(route, /^POST \/v1\//);
  });

  it('refuses every other write in the CSRF guard, after the CSRF check', async () => {
    const auth = await src('lib/auth.ts');
    const guard = auth.slice(auth.indexOf('async function requireCsrf'));
    const csrf = guard.indexOf("'INVALID_CSRF'");
    const demo = guard.indexOf("'TEST_MODE_ACTIVE'");
    assert.ok(csrf > 0 && demo > csrf, 'the test-mode refusal follows the CSRF check');
    assert.match(guard, /testModeAllows\(request\.method, request\.routeOptions\.url\)/);
  });

  it('swaps to the twin only for an active real account, and only while the switch is on', async () => {
    const auth = await src('lib/auth.ts');
    assert.match(auth, /LEFT JOIN users d ON s\.demo_mode AND d\.demo_of = u\.id/);
    const swap = auth.slice(auth.indexOf('config.mediaTestModeEnabled &&'));
    assert.match(swap, /row\.status === 'active'/);
    assert.match(swap, /role: 'player'/);
    assert.match(swap, /demoOf: row\.user_id/);
    // The swap comes after the admin MFA check, so that check always runs on the real account.
    assert.ok(
      auth.indexOf("'ADMIN_MFA_REQUIRED'") < auth.indexOf('config.mediaTestModeEnabled &&'),
    );
  });

  it('names the real account and never flexes a twin', () => {
    assert.equal(accountId(creator), creator.id);
    assert.equal(accountId(twin), creator.id);
    assert.equal(flexName(creator), 'Creator');
    assert.equal(flexName(twin), undefined);
    assert.equal(flexName(undefined), undefined);
  });

  it('counts twins as staff, so the house figures and the anti-drain monitor skip them', () => {
    assert.match(staffPredicate('u'), /u\.minecraft_identity LIKE 'demo:%'/);
    assert.equal(notDemoPredicate('u'), "u.minecraft_identity NOT LIKE 'demo:%'");
  });

  it('buys nothing with a twin wager: no race, jackpot, rakeback, VIP or referral', async () => {
    const settlement = await src('lib/cash-settlement.ts');
    const body = settlement.slice(settlement.indexOf('export async function recordWager'));
    const skip = body.indexOf('if (await isDemoAccount(client, userId))');
    assert.ok(skip > 0, 'recordWager checks for a twin');
    for (const effect of [
      'recordQuestProgress',
      'accrueReferralWager',
      'accrueRakeback',
      'recordRaceWager',
      'accrueAndDrawJackpot',
      'recordVipWager',
    ]) {
      assert.ok(body.indexOf(effect) > skip, `${effect} runs after the twin check`);
    }
    const royalty = await src('lib/creator-royalties.ts');
    assert.match(royalty, /payerUserId && \(await isDemoAccount\(client, payerUserId\)\)/);
  });

  it('keeps twins off the live feed, the boards and the Discord win feed', async () => {
    const activity = await src('routes/activity.ts');
    assert.equal(
      activity.match(
        /WHERE NOT EXISTS \(SELECT 1 FROM users d WHERE d\.id = \w+\.player_id AND d\.demo_of IS NOT NULL\)/g,
      )?.length,
      2,
    );
    const insights = await src('routes/insights.ts');
    // The three boards, and the player card behind a chat avatar.
    assert.equal(insights.match(/\$\{notDemoPredicate\('u'\)\}/g)?.length, 4);
    for (const file of ['blackjack.ts', 'mines.ts', 'plinko.ts', 'slots.ts', 'crash.ts', 'upgrades.ts']) {
      const route = await src(`routes/${file}`);
      assert.doesNotMatch(
        route,
        /announce\w*\(config, request\.authUser\?\.minecraftUsername/,
        file,
      );
      assert.match(route, /flexName\(request\.authUser\)/, file);
    }
    assert.match(
      await src('routes/crash.ts'),
      /SELECT id, minecraft_username FROM users WHERE id = ANY\(\$1::uuid\[\]\) AND demo_of IS NULL/,
    );
  });

  it('is switched on only by an eligible account, and only with cash-only play or unlimited stock', async () => {
    const routes = await src('routes/media-test.ts');
    assert.match(routes, /if \(!config\.cashOnlyPlay && !config\.houseStockUnlimited\)/);
    assert.match(routes, /testModeEligible\(client, ownerId\)/);
    // Switching off is never refused.
    assert.ok(routes.indexOf('if (!body.enabled)') < routes.indexOf('TEST_MODE_DISABLED'));
    // A top-up only fills up; it never takes winnings away.
    assert.match(routes, /if \(current >= target\) return current;/);
    const lib = await src('lib/media-test.ts');
    assert.match(lib, /u\.role = 'admin' OR EXISTS/);
    assert.match(lib, /ca\.status = 'approved'/);
  });

  it('ships a migration that marks twins and refuses one without the demo identity', async () => {
    const sql = await readFile(
      path.join(root, 'packages/db/migrations/067_media_test_mode.sql'),
      'utf8',
    );
    assert.match(sql, /ALTER TABLE users ADD COLUMN demo_of uuid REFERENCES users\(id\)/);
    assert.match(sql, /CHECK \(demo_of IS NULL OR minecraft_identity LIKE 'demo:%'\)/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX users_demo_of_idx ON users \(demo_of\) WHERE demo_of IS NOT NULL/,
    );
    assert.match(sql, /ALTER TABLE sessions ADD COLUMN demo_mode boolean NOT NULL DEFAULT false/);
    assert.match(sql, /'daily_code_reward',\s+'demo_topup'\s+\)\);/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v67\(\) RETURNS boolean/);
  });
});
