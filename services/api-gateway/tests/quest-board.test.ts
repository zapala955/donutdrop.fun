import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import pg from 'pg';
import type { AppConfig } from '../src/config.js';
import { Database } from '../src/lib/db.js';
import { PERIOD_DAYS, bestMultiplierFor, claimBoardQuest, periodOf, readQuestBoard } from '../src/lib/quest-board.js';
import { wagerRequirementRemaining } from '../src/lib/wager-requirements.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('quest board: the clock', () => {
  it('turns over every three days at 00:00 UTC, the same instant for everybody', () => {
    assert.equal(PERIOD_DAYS, 3);
    const a = periodOf(new Date('2026-11-09T13:45:00Z'));
    assert.equal(a.end.getTime() - a.start.getTime(), 3 * 86_400_000);
    assert.equal(a.start.getUTCHours(), 0);
    assert.equal(a.start.getUTCMinutes(), 0);
    assert.ok(a.start.getTime() <= Date.parse('2026-11-09T13:45:00Z') && Date.parse('2026-11-09T13:45:00Z') < a.end.getTime());
    // Every instant inside a period names the same period; the next instant after it, the next one.
    assert.deepEqual(periodOf(a.start), a);
    assert.deepEqual(periodOf(new Date(a.end.getTime() - 1)), a);
    assert.equal(periodOf(a.end).start.getTime(), a.end.getTime());
  });
});

describe('quest board: migration 087', () => {
  it('adds the quests and a claim table keyed on quest, player and period, and nothing destructive', async () => {
    const sql = await read('packages/db/migrations/087_quest_board.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);
    assert.match(sql, /CREATE TABLE board_quests \(/);
    assert.match(sql, /kind varchar\(16\) NOT NULL CHECK \(kind IN \('deposit', 'wager'\)\)/);
    assert.match(sql, /PRIMARY KEY \(quest_id, user_id, period_start\)/);
    // Claims are append-only to the API.
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE board_quest_claims TO donut_api_runtime;/);
    assert.doesNotMatch(sql, /GRANT[^;]*UPDATE[^;]*board_quest_claims/);
    // The daily quests are switched off, not removed; and no quest is added.
    assert.match(sql, /UPDATE quest_definitions SET enabled = false, updated_at = now\(\) WHERE enabled;/);
    assert.doesNotMatch(sql, /INSERT INTO board_quests/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v87\(\) RETURNS boolean/);
  });
});

describe('quest board: what counts and what pays', () => {
  it('counts deposits net of withdrawals within the period, never below zero, and wagers from the log', async () => {
    const lib = await read('services/api-gateway/src/lib/quest-board.ts');
    assert.match(lib, /const MONEY_KINDS = \[\.\.\.DEPOSIT_KINDS, \.\.\.WITHDRAWAL_KINDS\];/);
    assert.match(lib, /greatest\(0, coalesce\(\(SELECT sum\(t\.amount_minor\) FROM wallet_transactions t/);
    assert.match(lib, /FROM wager_events w\s+WHERE w\.user_id = \$1 AND w\.created_at >= \$2 AND w\.created_at < \$3/);
  });

  it('pays through the ledger once per period, with the free-money wager requirement', async () => {
    const lib = await read('services/api-gateway/src/lib/quest-board.ts');
    assert.match(lib, /creditWallet\(client, userId, reward, 'quest_reward', claimId\)/);
    assert.match(lib, /ON CONFLICT \(quest_id, user_id, period_start\) DO NOTHING/);
    assert.match(lib, /if \(inserted\.rowCount !== 1\) conflict\('QUEST_ALREADY_CLAIMED'/);
    assert.match(lib, /addWagerRequirement\(client, userId, requirementFor\(reward, config\.questRewardWagerMultiplier\)\)/);
  });

  it('has a public, rate-limited board, a CSRF-guarded claim, and audited admin writes', async () => {
    const routes = await read('services/api-gateway/src/routes/quest-board.ts');
    assert.match(routes, /'\/v1\/quests\/board',\s*\{ preHandler: softAuth, config: \{ rateLimit: \{ max: 60/);
    assert.match(routes, /'\/v1\/quests\/board\/:id\/claim',\s*\{ preHandler: guards\.requireCsrf, config: \{ rateLimit: \{ max: 30/);
    assert.match(routes, /app\.post\('\/v1\/admin\/quest-board', \{ preHandler: guards\.requireAdmin \}/);
    assert.match(routes, /app\.patch\('\/v1\/admin\/quest-board\/:id', \{ preHandler: guards\.requireAdmin \}/);
    assert.equal(routes.match(/appendAudit\(client, config, \{/g)?.length, 2);
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerQuestBoardRoutes\(app, db, config\);/);
  });
});

describe('quest board: the Quests tab and the console', () => {
  it('is on the menu, reads the board, and sets quest text as text', async () => {
    const [html, page, css] = await Promise.all([front('index.html'), front('assets/js/quests.js'), front('assets/css/quest-board.css')]);
    assert.match(html, /<a class="lxnav" href="\/quests" data-route="quests" data-tip="Quests">/);
    // And in the account dropdown, under Daily Rewards.
    assert.match(html, /<span>Daily Rewards<\/span>\s*<\/a>\s*<a class="menu__row" href="\/quests" data-route="quests" role="menuitem">/);
    assert.match(html, /<div class="qb" id="questRoot"><\/div>/);
    assert.match(html, /href="assets\/css\/quest-board\.css"/);
    assert.match(page, /api\.get\('\/v1\/quests\/board'\)/);
    assert.match(page, /api\.post\(`\/v1\/quests\/board\/\$\{encodeURIComponent\(quest\.id\)\}\/claim`, \{\}\)/);
    // Names and descriptions come from the console: never into markup.
    assert.match(page, /node\('h3', 'qb__name', quest\.name\)/);
    assert.match(page, /node\('p', 'qb__desc', quest\.description\)/);
    assert.doesNotMatch(page, /innerHTML[^;]*quest\.(name|description)/);
    // Nothing counted on the client.
    assert.doesNotMatch(page, /\+= |\+\+/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });

  it('lets the console add, edit and switch quests', async () => {
    const [admin, html] = await Promise.all([front('admin/admin.js'), front('admin/index.html')]);
    assert.match(admin, /api\.get\('\/v1\/admin\/quest-board'\)/);
    assert.match(admin, /await api\.post\('\/v1\/admin\/quest-board', payload\);/);
    assert.match(admin, /await api\.patch\(`\/v1\/admin\/quest-board\/\$\{encodeURIComponent\(quest\.id\)\}`, payload\);/);
    assert.match(html, /id="createBoardQuest"/);
    assert.match(html, /id="boardQuestTable"/);
  });
});

/* Against a real database when CI provides one: progress, a refused early claim, one payment per
 * period however many claims arrive at once, and the requirement it carries. */
const databaseUrl = process.env['TEST_DATABASE_URL'];

describe('quest board: claims against PostgreSQL', { skip: !databaseUrl }, () => {
  it('pays a finished quest once per period, and not before it is finished', async () => {
    if (!databaseUrl) return;
    if (!/(?:test|ci)/i.test(new URL(databaseUrl).pathname)) throw new Error('TEST_DATABASE_URL must name a test database');
    const owner = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = 'donut_ci_quest_login';
    runtimeUrl.password = 'ci-only-quest-password-71d0c2aa';
    const config = { databaseUrl: runtimeUrl.toString(), databaseSsl: false, questRewardWagerMultiplier: 3 } as unknown as AppConfig;
    const db = new Database(config);
    const user = randomUUID();
    const tag = user.slice(0, 8);
    try {
      await owner.query(`
        DO $block$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_ci_quest_login') THEN
            CREATE ROLE donut_ci_quest_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
              PASSWORD 'ci-only-quest-password-71d0c2aa';
          END IF;
        END
        $block$;
        GRANT donut_api_runtime TO donut_ci_quest_login;
      `);
      await owner.query(
        `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username, role, status, terms_accepted_at)
         VALUES ($1, $2, $3, $4, 'player', 'active', now())`,
        [user, `mc:quest${tag}`, `Quest${tag}`, `quest${tag}`],
      );
      await owner.query('INSERT INTO user_wallets (user_id, balance_minor) VALUES ($1, 0)', [user]);
      const { start } = periodOf(new Date((await owner.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now));
      const money = (amount: number, kind: string, at = 'now()') =>
        owner.query(
          `INSERT INTO wallet_transactions (id, user_id, amount_minor, balance_after_minor, kind, reference_id, created_at)
           VALUES ($1, $2, $3, 0, $4, $5, ${at})`,
          [randomUUID(), user, amount, kind, randomUUID()],
        );
      const deposit = randomUUID();
      const wager = randomUUID();
      await owner.query(
        `INSERT INTO board_quests (id, name, kind, target_minor, reward_minor, sort_order) VALUES
           ($1, 'Deposit 10M', 'deposit', 10000000, 1000000, 1),
           ($2, 'Wager 5M', 'wager', 5000000, 250000, 2)`,
        [deposit, wager],
      );

      // A deposit from the last period does not count; this period's do, less what was taken out.
      await money(50_000_000, 'cash_deposit', `'${new Date(start.getTime() - 3_600_000).toISOString()}'::timestamptz`);
      await money(6_000_000, 'cash_deposit');
      await money(6_000_000, 'pay_login_deposit');
      await money(-3_000_000, 'cash_withdrawal');
      let board = await readQuestBoard(db, config, user);
      const mine = board.quests.find((quest) => quest.id === deposit)!;
      assert.equal(mine.progressMinor, '9000000');
      assert.equal(mine.claimable, false);
      await assert.rejects(claimBoardQuest(db, config, user, deposit), { code: 'QUEST_INCOMPLETE' });

      /* Over the line: three claims at once. Each loser is refused as already claimed, or, under
       * load, by the database's own serialization check (a retryable 40001 the player can repeat);
       * either way exactly one is paid, and a claim after the race is refused. */
      await money(2_000_000, 'cash_deposit');
      const results = await Promise.allSettled([1, 2, 3].map(() => claimBoardQuest(db, config, user, deposit)));
      assert.ok(results.filter((r) => r.status === 'fulfilled').length <= 1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        assert.ok(['QUEST_ALREADY_CLAIMED', '40001'].includes((r as PromiseRejectedResult).reason?.code), String((r as PromiseRejectedResult).reason));
      }
      if (!results.some((r) => r.status === 'fulfilled')) await claimBoardQuest(db, config, user, deposit);
      await assert.rejects(claimBoardQuest(db, config, user, deposit), { code: 'QUEST_ALREADY_CLAIMED' });
      const paid = await owner.query<{ n: string; total: string }>(
        `SELECT count(*)::text AS n, coalesce(sum(amount_minor), 0)::text AS total
           FROM wallet_transactions WHERE user_id = $1 AND kind = 'quest_reward'`,
        [user],
      );
      assert.deepEqual(paid.rows[0], { n: '1', total: '1000000' });
      assert.equal((await owner.query<{ b: string }>('SELECT balance_minor::text AS b FROM user_wallets WHERE user_id = $1', [user])).rows[0]!.b, '1000000');
      assert.equal(await wagerRequirementRemaining(owner, user), 3_000_000n);
      board = await readQuestBoard(db, config, user);
      assert.equal(board.quests.find((quest) => quest.id === deposit)!.claimed, true);
      assert.equal(board.quests.find((quest) => quest.id === deposit)!.progressMinor, '10000000', 'capped at the target');

      // Wagers count from the log. Signed out, the board shows no progress at all.
      await owner.query(
        `INSERT INTO wager_events (id, user_id, amount_minor, margin_minor, source, reference_id) VALUES ($1, $2, 5000000, 0, 'upgrader', $3)`,
        [randomUUID(), user, randomUUID()],
      );
      assert.equal((await readQuestBoard(db, config, user)).quests.find((quest) => quest.id === wager)!.claimable, true);
      assert.ok((await readQuestBoard(db, config, null)).quests.every((quest) => quest.progressMinor === null && !quest.claimable));

      // A quest switched off cannot be claimed.
      await owner.query('UPDATE board_quests SET enabled = false WHERE id = $1', [wager]);
      await assert.rejects(claimBoardQuest(db, config, user, wager), { code: 'QUEST_NOT_FOUND' });
    } finally {
      await db.close();
      await owner.end();
    }
  });
});

describe('quest board: multiplier quests (migration 088)', () => {
  it('adds the kind and the operator\'s first three quests, and nothing destructive', async () => {
    const sql = await read('packages/db/migrations/088_quest_multiplier.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);
    assert.match(sql, /CHECK \(kind IN \('deposit', 'wager', 'multiplier'\)\)/);
    assert.match(sql, /CHECK \(\(kind = 'multiplier'\) = \(min_stake_minor IS NOT NULL\)\)/);
    assert.match(sql, /'Wager \$100M', 'Play any game\.', 'wager', 100000000, 5000000, 1, true, NULL/);
    assert.match(sql, /'Deposit \$50M', 'Deposit in game\.', 'deposit', 50000000, 5000000, 2, true, NULL/);
    assert.match(sql, /'multiplier', 2500, 20000000, 3, true, 1000000/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v88\(\) RETURNS boolean/);
  });

  it('shows the multiplier and the least bet on the page, and edits them in the console', async () => {
    const [page, admin] = await Promise.all([front('assets/js/quests.js'), front('admin/admin.js')]);
    assert.match(page, /const times = \(hundredths\) => `\$\{Number\(hundredths\) \/ 100\}×`;/);
    assert.match(page, /Hit \$\{times\(target\)\} on a bet of \$\{cash\(quest\.minStakeMinor\)\} or more/);
    assert.match(admin, /options: \['deposit', 'wager', 'multiplier'\]/);
    assert.match(admin, /String\(Math\.round\(Number\(String\(values\.targetMinor\)\.replace\(\/x\|×\/gi, ''\)\.trim\(\)\) \* 100\)\)/);
  });
});

describe('quest board: a multiplier quest against PostgreSQL', { skip: !databaseUrl }, () => {
  it('counts the best multiplier on a bet of at least the minimum, in the period, and pays it once', async () => {
    if (!databaseUrl) return;
    const owner = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const config = { databaseUrl, databaseSsl: false, questRewardWagerMultiplier: 3 } as unknown as AppConfig;
    const db = new Database(config);
    const user = randomUUID();
    const tag = user.slice(0, 8);
    try {
      await owner.query(
        `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username, role, status, terms_accepted_at)
         VALUES ($1, $2, $3, $4, 'player', 'active', now())`,
        [user, `mc:mult${tag}`, `Mult${tag}`, `mult${tag}`],
      );
      await owner.query('INSERT INTO user_wallets (user_id, balance_minor) VALUES ($1, 0)', [user]);
      const bet = async (stake: number, payout: number) => {
        const seed = randomUUID();
        await owner.query(
          `INSERT INTO fairness_seeds (id, user_id, server_seed_ciphertext, server_seed_hash, used_at) VALUES ($1, $2, 'x', $3, now())`,
          [seed, user, 'a'.repeat(64)],
        );
        await owner.query(
          `INSERT INTO dice_bets (id, user_id, idempotency_key, request_hash, stake_minor, direction, target, chance, roll,
                                 multiplier_bps, win, payout_minor, fairness_seed_id, server_seed_hash, server_seed_reveal, client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, 'under', 100, 100, 5, 900000, $6, $7, $8, $9, $9, 'c', 0)`,
          [randomUUID(), user, randomUUID(), 'b'.repeat(64), stake, payout > 0, payout, seed, 'a'.repeat(64)],
        );
      };
      const quest = randomUUID();
      await owner.query(
        `INSERT INTO board_quests (id, name, kind, target_minor, reward_minor, min_stake_minor) VALUES ($1, 'Hit 25x', 'multiplier', 2500, 20000000, 1000000)`,
        [quest],
      );
      const { start, end } = periodOf(new Date((await owner.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now));

      // 100x on a bet under the minimum does not count; 10x on $1M does, but is short.
      await bet(500_000, 50_000_000);
      await bet(1_000_000, 10_000_000);
      assert.equal(await bestMultiplierFor(owner, user, start, end, 1_000_000n), 1000n);
      let mine = (await readQuestBoard(db, config, user)).quests.find((q) => q.id === quest)!;
      assert.equal(mine.progressMinor, '1000');
      assert.equal(mine.minStakeMinor, '1000000');
      assert.equal(mine.claimable, false);
      await assert.rejects(claimBoardQuest(db, config, user, quest), { code: 'QUEST_INCOMPLETE' });

      // 25.5x on $2M: done, paid once, at the quests' wager requirement.
      await bet(2_000_000, 51_000_000);
      assert.equal(await bestMultiplierFor(owner, user, start, end, 1_000_000n), 2550n);
      mine = (await readQuestBoard(db, config, user)).quests.find((q) => q.id === quest)!;
      assert.equal(mine.claimable, true);
      assert.equal((await claimBoardQuest(db, config, user, quest)).rewardMinor, '20000000');
      await assert.rejects(claimBoardQuest(db, config, user, quest), { code: 'QUEST_ALREADY_CLAIMED' });
      assert.equal(await wagerRequirementRemaining(owner, user), 60_000_000n);
    } finally {
      await db.close();
      await owner.end();
    }
  });
});
