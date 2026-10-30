import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { FEEDBACK_DAILY_LIMIT, FEEDBACK_MAX_CHARS, FEEDBACK_MIN_CHARS } from '../src/lib/feedback.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');
const front = (relative: string) => read(`../../../DONUTDROP FRONTEND/Donut Drop/${relative}`);
const migration = () => read('../../../packages/db/migrations/085_feedback.sql');

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

describe('feedback: the reward', () => {
  it('pays 1M once, after 1M played', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.feedbackEnabled, true);
    assert.equal(config.feedbackRewardMinor, 1_000_000n);
    assert.equal(config.feedbackMinWagerMinor, 1_000_000n);
  });

  it('can be tuned live in its own group', async () => {
    for (const key of ['feedbackEnabled', 'feedbackRewardMinor', 'feedbackMinWagerMinor'] as const) {
      assert.equal(runtimeSettingDefinitions[key].group, 'feedback', key);
    }
    assert.match(await front('admin/admin.js'), /feedback: 'Feedback'/);
  });

  it('is paid only to a playing, ordinary account that has not been paid, under a lock', async () => {
    const lib = await read('../src/lib/feedback.ts');
    assert.match(lib, /eligible: config\.feedbackEnabled && config\.feedbackRewardMinor > 0n && counts && played && !rewarded/);
    assert.match(lib, /NOT \$\{staffPredicate\('u'\)\}/);
    assert.match(lib, /\$\{notDemoPredicate\('u'\)\}/);
    assert.match(lib, /SELECT id FROM users WHERE id = \$1 FOR UPDATE/);
    assert.match(lib, /creditWallet\(client, userId, reward, 'feedback_reward', id\)/);
    // Free money is free money: the same requirement as every other kind (lib/wager-requirements.ts).
    assert.match(lib, /requirementFor\(reward, config\.signupBonusWagerMultiplier\)/);
    assert.ok(FEEDBACK_DAILY_LIMIT >= 1 && FEEDBACK_DAILY_LIMIT <= 5);
    assert.equal(FEEDBACK_MIN_CHARS, 20);
    assert.equal(FEEDBACK_MAX_CHARS, 1000);
  });

  it('counts the survey once per player, by the latest answer', async () => {
    const lib = await read('../src/lib/feedback.ts');
    assert.match(lib, /SELECT DISTINCT ON \(user_id\) user_id, likes_3d FROM player_feedback ORDER BY user_id, created_at DESC/);
  });
});

describe('feedback: migration 085', () => {
  it('stores notes append-only with one paid note per account, and nothing destructive', async () => {
    const sql = await migration();
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|ALTER COLUMN/i);
    assert.match(sql, /CREATE TABLE player_feedback/);
    assert.match(sql, /likes_3d boolean NOT NULL/);
    assert.match(sql, /CREATE UNIQUE INDEX player_feedback_rewarded_idx ON player_feedback \(user_id\) WHERE reward_minor > 0;/);
    assert.match(sql, /player_feedback_append_only\s+BEFORE UPDATE OR DELETE ON player_feedback/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v85\(\) RETURNS boolean/);
  });

  it('rebuilds the ledger kind list from 084 and only adds feedback_reward', async () => {
    const kinds = (sql: string) => {
      const at = sql.lastIndexOf('ADD CONSTRAINT wallet_transactions_kind_check');
      const body = sql.slice(sql.indexOf('kind IN (', at), sql.indexOf('));', at));
      return new Set([...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
    };
    const before = kinds(await read('../../../packages/db/migrations/084_weekly_quests.sql'));
    const after = kinds(await migration());
    for (const kind of before) assert.ok(after.has(kind), `${kind} would be dropped from the ledger`);
    assert.deepEqual([...after].filter((kind) => !before.has(kind)), ['feedback_reward']);
  });

  it('names the new ledger kind everywhere a kind has to be named', async () => {
    assert.match(await read('../src/lib/wallet.ts'), /\| 'feedback_reward'/);
    assert.match(await read('../src/lib/admin-stats.ts'), /feedback_reward: 'Feedback'/);
    assert.match(await front('assets/js/account.js'), /feedback_reward: 'Feedback reward'/);
  });
});

describe('feedback: the routes, the window, the pop-up and the admin tab', () => {
  it('reads signed in, writes behind CSRF and a rate limit, and shows staff only to an admin', async () => {
    const route = await read('../src/routes/feedback.ts');
    assert.match(route, /app\.get\('\/v1\/feedback', \{ preHandler: guards\.authenticate \}/);
    assert.match(route, /preHandler: guards\.requireCsrf, config: \{ rateLimit: \{ max: 5, timeWindow: '10 minutes' \} \}/);
    assert.match(route, /'\/v1\/admin\/feedback', \{ preHandler: requireAdminRead \}/);
    assert.match(route, /request\.authUser\?\.role !== 'admin'/);
    assert.match(route, /likes3d: z\.boolean\(\)/);
    assert.match(await read('../src/app.ts'), /await registerFeedbackRoutes\(app, db, config\);/);
  });

  it('asks both questions in one window, opened from the account menu', async () => {
    const page = await front('assets/js/feedback.js');
    assert.match(page, /Do you like the 3D games\?/);
    assert.match(page, /What should we add or fix\?/);
    assert.match(page, /api\.post\('\/v1\/feedback', \{\s*likes3d: choice\.value === 'yes',\s*message: text\.value\.trim\(\),/);
    // The reward is the server's figure, never written into the copy.
    assert.match(page, /money\(Number\(status\.rewardMinor\)\)/);
    assert.doesNotMatch(page, /\$1M|1_000_000|1000000/);
    const html = await front('index.html');
    assert.match(html, /id="feedbackBtn" type="button" role="menuitem" data-closes-menu hidden/);
    assert.match(html, /href="assets\/css\/feedback\.css"/);
    assert.match(await front('assets/js/app.js'), /initFeedback\(\);/);
  });

  it('is promoted by a pop-up while the first note would still be paid', async () => {
    const popups = await front('assets/js/popups.js');
    assert.match(popups, /id: 'feedback'/);
    assert.match(popups, /if \(status\?\.enabled && status\.eligible\)/);
    assert.match(popups, /action: openFeedback/);
    assert.match(popups, /if \(popup\.action\) void popup\.action\(\);\s*else openLogin\(\);/);
  });

  it('has an admin tab with the tally and every note as text', async () => {
    const html = await front('admin/index.html');
    assert.match(html, /data-panel="feedback" aria-selected="false">Feedback<\/button>/);
    assert.match(html, /<section class="panel" data-panel="feedback" hidden>/);
    const admin = await front('admin/admin.js');
    assert.match(admin, /feedback: loadFeedback,/);
    assert.match(admin, /api\.get\('\/v1\/admin\/feedback\?limit=200'\)/);
    assert.match(admin, /const text = cell\(row\.message\);/);
  });
});
