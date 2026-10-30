import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';
import {
  FRIENDS_SQL,
  RACE_SQL,
  WEEKLY_QUESTS,
  equalShare,
  finishers,
  rankPrizes,
  weekStart,
} from '../src/lib/weekly-quests.js';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');
const front = (relative: string) => read(`../../../DONUTDROP FRONTEND/Donut Drop/${relative}`);
const migration = () => read('../../../packages/db/migrations/084_weekly_quests.sql');

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

const M = 1_000_000n;

describe('weekly quests: the week and the money', () => {
  it('runs Monday 00:00 UTC to Monday', () => {
    // Thursday 2026-10-29 19:00 UTC is in the week of Monday 2026-10-26.
    assert.equal(weekStart(new Date('2026-10-29T19:00:00Z')).toISOString(), '2026-10-26T00:00:00.000Z');
    // Monday at midnight starts its own week; Sunday night is still the old one.
    assert.equal(weekStart(new Date('2026-11-02T00:00:00Z')).toISOString(), '2026-11-02T00:00:00.000Z');
    assert.equal(weekStart(new Date('2026-11-01T23:59:59Z')).toISOString(), '2026-10-26T00:00:00.000Z');
  });

  it('pays the race by rank and never more than the pot', () => {
    assert.deepEqual(rankPrizes(10n * M, [5000, 3000, 2000]), [5n * M, 3n * M, 2n * M]);
    const odd = rankPrizes(7n, [5000, 3000, 2000]);
    assert.ok(odd.reduce((sum, prize) => sum + prize, 0n) <= 7n);
  });

  it('splits the recruit pot equally, rounding down, and pays nobody when nobody finished', () => {
    assert.equal(equalShare(10n * M, 1), 10n * M);
    assert.equal(equalShare(10n * M, 3), 3_333_333n);
    assert.equal(equalShare(10n * M, 0), 0n);
  });

  it('counts an inviter as finished only with enough qualified friends', () => {
    const row = (referrer: string, qualified: boolean) => ({
      referrer_id: referrer, referee_id: `${referrer}${Math.random()}`, friend: 'F****', net_minor: '0', wagered_minor: '0', qualified,
    });
    const done = finishers(
      [row('a', true), row('a', true), row('a', true), row('b', true), row('b', true), row('b', false)],
      3,
    );
    assert.deepEqual([...done.entries()], [['a', 3]]);
  });

  it('defaults to a 10M pot per quest, three places and three friends', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.weeklyQuestsEnabled, true);
    assert.equal(config.depositRacePotMinor, 10n * M);
    assert.equal(config.recruitQuestPotMinor, 10n * M);
    assert.deepEqual(config.depositRaceSplitBps, [5000, 3000, 2000]);
    assert.equal(config.recruitQuestFriends, 3);
    assert.equal(config.recruitFriendDepositMinor, 10n * M);
    assert.equal(config.recruitFriendWagerMinor, 10n * M);
  });

  it('refuses a split that would pay more than the pot', () => {
    assert.throws(() => loadConfig({ ...baseEnv, DEPOSIT_RACE_SPLIT_BPS: '6000,5000' }));
    assert.throws(() => loadConfig({ ...baseEnv, DEPOSIT_RACE_SPLIT_BPS: '5000,0' }));
  });

  it('can be tuned live in the admin panel, in its own group', async () => {
    for (const key of [
      'weeklyQuestsEnabled', 'depositRacePotMinor', 'depositRaceMinDepositMinor', 'recruitQuestPotMinor',
      'recruitQuestFriends', 'recruitFriendDepositMinor', 'recruitFriendWagerMinor', 'weeklyQuestGraceHours',
    ] as const) {
      assert.equal(runtimeSettingDefinitions[key].group, 'weeklyQuests', key);
    }
    assert.match(await front('admin/admin.js'), /weeklyQuests: 'Weekly quests'/);
  });
});

describe('weekly quests: what counts', () => {
  it('counts a deposit only as far as it was played, net of withdrawals, inside the week', () => {
    assert.match(RACE_SQL, /'cash_deposit'/);
    assert.match(RACE_SQL, /'cash_withdrawal'/);
    assert.match(RACE_SQL, /LEAST\(m\.net_minor, coalesce\(p\.wagered_minor, 0\)\)/);
    assert.match(RACE_SQL, /t\.created_at >= \$1 AND t\.created_at < \$2/);
    assert.match(RACE_SQL, /w\.created_at >= \$1 AND w\.created_at < \$2/);
  });

  it('leaves staff, developer logins, test twins and closed accounts out of both quests', () => {
    for (const sql of [RACE_SQL, FRIENDS_SQL]) {
      assert.match(sql, /status = 'active'/);
      assert.match(sql, /minecraft_identity NOT LIKE 'demo:%'/);
      assert.match(sql, /role = 'admin' OR \w+\.minecraft_identity LIKE 'dev:%'/);
    }
  });

  it('counts only new players invited this week, on an invite that was not voided', () => {
    assert.match(FRIENDS_SQL, /r\.voided_at IS NULL/);
    assert.match(FRIENDS_SQL, /r\.created_at >= \$1 AND r\.created_at < \$2/);
    assert.match(FRIENDS_SQL, /f\.created_at >= \$1 AND f\.created_at < \$2/);
    assert.match(FRIENDS_SQL, /coalesce\(m\.net_minor, 0\) >= \$4 AND coalesce\(p\.wagered_minor, 0\) >= \$5/);
  });

  it('settles a round once, after its grace period, and pays through the ledger with a requirement', async () => {
    const source = await read('../src/lib/weekly-quests.ts');
    assert.match(source, /WHERE id = \$1 AND settled_at IS NULL AND settles_at <= now\(\)/);
    assert.match(source, /creditWallet\(client, winner\.userId, winner\.amount, 'weekly_quest_reward', payoutId\)/);
    // Free money is free money: the same requirement as every other kind (lib/wager-requirements.ts).
    assert.match(source, /requirementFor\(winner\.amount, config\.signupBonusWagerMultiplier\)/);
    // An open round still settles after the quests are switched off: it was promised.
    const sweep = source.slice(source.indexOf('export async function runWeeklyQuestSweep'));
    assert.match(sweep, /if \(config\.weeklyQuestsEnabled\) \{\s*for \(const quest of WEEKLY_QUESTS\)/);
    assert.match(sweep, /WHERE settled_at IS NULL AND settles_at <= \$1/);
    assert.deepEqual([...WEEKLY_QUESTS], ['deposit_race', 'recruit']);
  });
});

describe('weekly quests: migration 084', () => {
  it('adds the rounds and an append-only payout table, and nothing destructive', async () => {
    const sql = await migration();
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|ALTER COLUMN/i);
    assert.match(sql, /CREATE TABLE weekly_quest_rounds/);
    assert.match(sql, /UNIQUE \(quest, starts_at\)/);
    assert.match(sql, /CREATE TABLE weekly_quest_payouts/);
    assert.match(sql, /UNIQUE \(round_id, user_id\)/);
    assert.match(sql, /weekly_quest_payouts_append_only\s+BEFORE UPDATE OR DELETE ON weekly_quest_payouts/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v84\(\) RETURNS boolean/);
  });

  it('rebuilds the ledger kind list from 082 and only adds weekly_quest_reward', async () => {
    const kinds = (sql: string) => {
      const at = sql.lastIndexOf('ADD CONSTRAINT wallet_transactions_kind_check');
      const body = sql.slice(sql.indexOf('kind IN (', at), sql.indexOf('));', at));
      return new Set([...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
    };
    const before = kinds(await read('../../../packages/db/migrations/082_staking.sql'));
    const after = kinds(await migration());
    for (const kind of before) assert.ok(after.has(kind), `${kind} would be dropped from the ledger`);
    assert.deepEqual([...after].filter((kind) => !before.has(kind)), ['weekly_quest_reward']);
  });

  it('names the new ledger kind everywhere a kind has to be named', async () => {
    assert.match(await read('../src/lib/wallet.ts'), /\| 'weekly_quest_reward'/);
    assert.match(await read('../src/lib/admin-stats.ts'), /weekly_quest_reward: 'Weekly quests'/);
    assert.match(await front('assets/js/account.js'), /weekly_quest_reward: 'Weekly quest prize'/);
  });
});

describe('weekly quests: the page, the bell and the pop-ups', () => {
  it('has a public, rate-limited board', async () => {
    const route = await read('../src/routes/weekly-quests.ts');
    assert.match(route, /'\/v1\/quests\/weekly'/);
    assert.match(route, /preHandler: softAuth/);
    assert.match(route, /rateLimit: \{ max: 60, timeWindow: '1 minute' \}/);
    const app = await read('../src/app.ts');
    assert.match(app, /await registerWeeklyQuestRoutes\(app, db, config\);/);
    assert.match(app, /startWeeklyQuestSweeper\(app, db, config\);/);
  });

  it('sits above the daily quests on the Quests page', async () => {
    const html = await front('index.html');
    assert.match(html, /<div class="wq" id="weeklyQuestsRoot" hidden><\/div>\s*<div class="quests" id="questRoot">/);
    assert.match(html, /href="assets\/css\/weekly-quests\.css"/);
    const quests = await front('assets/js/quests.js');
    assert.match(quests, /mountWeeklyQuests\(\$\('#weeklyQuestsRoot', view\)\)/);
    const page = await front('assets/js/weekly-quests.js');
    assert.match(page, /api\.get\('\/v1\/quests\/weekly'\)/);
    // Nothing is counted on the client.
    assert.doesNotMatch(page, /\+= |\+\+/);
  });

  it('tells a winner in the bell', async () => {
    const lib = await read('../src/lib/notifications.ts');
    assert.match(lib, /kind: 'quest_won'/);
    assert.match(lib, /FROM weekly_quest_payouts p JOIN weekly_quest_rounds r ON r\.id = p\.round_id/);
    assert.match(await front('assets/js/notices.js'), /quest_won: \{/);
  });

  it('promotes both quests with their own pop-ups, never on the Quests page itself', async () => {
    const popups = await front('assets/js/popups.js');
    assert.match(popups, /id: 'quest:deposit_race'/);
    assert.match(popups, /id: 'quest:recruit'/);
    assert.match(popups, /if \(currentRouteName\(\) === 'quests'\) return null;/);
    assert.match(popups, /if \(recruit\.you\?\.done\) return null;/);
    assert.equal(popups.match(/href: '\/quests'/g)?.length, 2);
    // Figures are the board's, not written into the copy.
    assert.match(popups, /money\(Number\(race\.potMinor\)\)/);
    assert.match(popups, /money\(Number\(recruit\.potMinor\)\)/);
  });
});
