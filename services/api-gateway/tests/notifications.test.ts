import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { AppConfig } from '../src/config.js';
import type { DbClient } from '../src/lib/db.js';
import {
  NOTICE_KINDS,
  NOTICE_KINDS_SQL,
  isNoticeKind,
  markNotificationsRead,
  readNotifications,
} from '../src/lib/notifications.js';
import { TEST_MODE_ROUTES } from '../src/lib/media-test.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';
import { moneyAlerts } from '../src/lib/staff-alerts.js';

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

type Row = Record<string, unknown>;
/** A client that answers by which table a query reads, and keeps every query it was sent. */
function fakeClient(answers: Array<[RegExp, Row[]]>): DbClient & { sent: Array<{ text: string; values: unknown[] }> } {
  const sent: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    sent,
    async query(text: string, values: unknown[] = []) {
      sent.push({ text, values });
      const hit = answers.find(([pattern]) => pattern.test(text));
      return { rows: hit ? hit[1] : [], rowCount: hit ? hit[1].length : 0, command: 'SELECT', oid: 0, fields: [] };
    },
  };
  return client as unknown as DbClient & { sent: typeof sent };
}

const baseConfig = {
  rakebackEnabled: true,
  referralsEnabled: true,
  staffAlertChannelId: 0n,
  staffAlertRoleId: 0n,
  staffAlertBigWinMinor: 50_000_000n,
  staffAlertDailyProfitMinor: 100_000_000n,
} as unknown as AppConfig;

describe('notification bell', () => {
  it('lists only kinds the player did not cause, all of them real ledger kinds', async () => {
    const migration = await read('packages/db/migrations/069_chicken.sql');
    const start = migration.indexOf('ADD CONSTRAINT wallet_transactions_kind_check');
    const kinds = new Set(
      [...migration.slice(start, migration.indexOf('));', start)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    );
    for (const kind of NOTICE_KINDS) assert.ok(kinds.has(kind), `${kind} is not a ledger kind`);
    // What a player does themselves is shown where they did it, never in the bell.
    for (const kind of ['crash_stake', 'crash_payout', 'rakeback_claim', 'referral_revshare', 'rain_claim', 'cash_withdrawal', 'tip_sent', 'item_sale']) {
      assert.equal(isNoticeKind(kind), false, kind);
    }
  });

  it('queries with exactly the list migration 070 indexes, so Postgres can use the index', async () => {
    const migration = await read('packages/db/migrations/070_notifications.sql');
    assert.ok(migration.includes(`WHERE kind IN (${NOTICE_KINDS_SQL});`), 'the partial index predicate matches NOTICE_KINDS');
    assert.match(migration, /ADD COLUMN notifications_read_at timestamptz NOT NULL DEFAULT now\(\)/);
    assert.match(migration, /CREATE INDEX wallet_transactions_notice_idx\n  ON wallet_transactions \(user_id, created_at DESC\)/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v70\(\) RETURNS boolean/);
    const lib = await read('services/api-gateway/src/lib/notifications.ts');
    assert.match(lib, /AND t\.kind IN \(\$\{NOTICE_KINDS_SQL\}\)/);
  });

  it('merges the ledger and paid withdrawals newest first, and counts what is newer than the marker', async () => {
    const readAt = new Date('2026-10-16T10:00:00.000Z');
    const client = fakeClient([
      [/FROM users WHERE id/, [{ read_at: readAt, referral_blocked: false }]],
      [/FROM wallet_transactions t/, [
        { id: 'a', kind: 'cash_deposit', amount_minor: '5000000', created_at: new Date('2026-10-16T11:00:00.000Z'), from_name: null },
        { id: 'b', kind: 'tip_received', amount_minor: '750000', created_at: new Date('2026-10-16T09:00:00.000Z'), from_name: 'Notch_' },
      ]],
      [/FROM cash_withdrawals/, [
        { id: 'w', amount_minor: '1000000', payee_username: 'Steve', paid_at: new Date('2026-10-16T10:30:00.000Z') },
      ]],
      [/FROM rakeback_accruals/, [{ rakeback_minor: '100000', referrals_minor: '4000' }]],
    ]);
    const feed = await readNotifications(client, baseConfig, 'u');
    assert.deepEqual(feed.items.map((n) => n.id), ['a', 'w', 'b']);
    assert.deepEqual(feed.items.map((n) => n.unread), [true, true, false]);
    assert.equal(feed.unread, 2);
    assert.equal(feed.items[1]?.kind, 'withdrawal_paid');
    assert.equal(feed.items[1]?.to, 'Steve');
    assert.equal(feed.items[2]?.from, 'Notch_');
    assert.deepEqual(feed.ready, [
      { kind: 'rakeback', amountMinor: '100000', path: '/rakeback' },
      { kind: 'referrals', amountMinor: '4000', path: '/referrals' },
    ]);
  });

  it('does not offer a claim the player cannot make', async () => {
    const client = fakeClient([
      [/FROM users WHERE id/, [{ read_at: new Date(), referral_blocked: true }]],
      [/FROM rakeback_accruals/, [{ rakeback_minor: '0', referrals_minor: '4000' }]],
    ]);
    const feed = await readNotifications(client, baseConfig, 'u');
    assert.deepEqual(feed.ready, []);
    const off = await readNotifications(
      fakeClient([[/FROM rakeback_accruals/, [{ rakeback_minor: '500', referrals_minor: null }]]]),
      { ...baseConfig, rakebackEnabled: false } as AppConfig,
      'u',
    );
    assert.deepEqual(off.ready, []);
  });

  it('marks read up to what was shown, never backwards and never past now', async () => {
    const client = fakeClient([[/UPDATE users/, [{ read_at: new Date('2026-10-16T10:00:00.001Z') }]]]);
    await markNotificationsRead(client, 'u', new Date('2026-10-16T10:00:00.000Z'));
    const sql = client.sent[0]?.text ?? '';
    assert.match(sql, /GREATEST\(\s*notifications_read_at,/);
    assert.match(sql, /LEAST\(COALESCE\(\$2::timestamptz \+ interval '1 millisecond', now\(\)\), now\(\)\)/);
    assert.equal(client.sent[0]?.values[1], '2026-10-16T10:00:00.000Z');
  });

  it('is served for the real account, and its read marker is allowed in test mode', async () => {
    const routes = await read('services/api-gateway/src/routes/notifications.ts');
    assert.match(routes, /'\/v1\/notifications',\n    \{ preHandler: guards\.authenticate/);
    assert.match(routes, /'\/v1\/notifications\/read',\n    \{ preHandler: guards\.requireCsrf/);
    assert.equal((routes.match(/requireAccount\(request\.authUser\)/g) ?? []).length, 2);
    assert.ok(TEST_MODE_ROUTES.has('POST /v1/notifications/read'));
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerNotificationRoutes\(app, db, config\);/);
  });

  it('tells the player\'s open tabs when one lands', async () => {
    const [live, wallet, minecraft, operations, admin, withdrawals] = await Promise.all([
      read('services/api-gateway/src/lib/live-events.ts'),
      read('services/api-gateway/src/lib/wallet.ts'),
      read('services/api-gateway/src/routes/minecraft-in.ts'),
      read('services/api-gateway/src/routes/admin-operations.ts'),
      read('services/api-gateway/src/routes/admin.ts'),
      read('services/api-gateway/src/routes/cash-withdrawals.ts'),
    ]);
    assert.match(live, /\| 'notice';/);
    assert.match(wallet, /if \(isNoticeKind\(kind\)\) noticeSoon\(userId\);/);
    // Every place a withdrawal becomes paid says so to its owner.
    const paidUpdates = (source: string) => (source.match(/UPDATE cash_withdrawals SET status = 'paid'/g) ?? []).length;
    const told = (source: string) => (source.match(/for \(const row of paid\.rows\) noticeSoon\(row\.user_id\);/g) ?? []).length;
    assert.equal(paidUpdates(minecraft), 2);
    assert.equal(told(minecraft), 2);
    assert.equal(paidUpdates(operations), 1);
    assert.equal(told(operations), 1);
    // The refund and the staff adjustment write the ledger directly, so they say so themselves.
    assert.match(withdrawals, /'cash_withdrawal_refund', \$5\)`,[\s\S]{0,400}noticeSoon\(row\.user_id\);/);
    assert.match(admin, /'admin_adjustment', \$5\)`,[\s\S]{0,900}noticeSoon\(params\.id\);/);
  });

  it('has a line in the page for every kind the server sends', async () => {
    const page = await front('assets/js/notices.js');
    for (const kind of [...NOTICE_KINDS, 'withdrawal_paid']) {
      assert.match(page, new RegExp(`\\n  ${kind}: \\{`), `notices.js has no copy for ${kind}`);
    }
    const live = await front('assets/js/live.js');
    assert.match(live, /source\.addEventListener\('notice', \(\) => window\.dispatchEvent\(new CustomEvent\('donut:notice'\)\)\);/);
    const html = await front('index.html');
    assert.match(html, /<button class="lxicon notif__btn" id="notifBtn" type="button" aria-haspopup="dialog"/);
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/notices\.css" \/>/);
    const app = await front('assets/js/app.js');
    assert.match(app, /initNotices\(\);/);
    // The deposit poll slows to thirty seconds only while the stream is speaking.
    assert.match(app, /live \? DEPOSIT_POLL_LIVE_MS : DEPOSIT_POLL_MS/);
    assert.match(app, /window\.addEventListener\('donut:notice', \(\) => \{\n  void checkDeposits\(\);/);
  });
});

describe('staff money alerts', () => {
  it('are dials in the admin panel, off at zero', () => {
    for (const key of ['staffAlertChannelId', 'staffAlertRoleId', 'staffAlertBigWinMinor', 'staffAlertDailyProfitMinor'] as const) {
      assert.equal(runtimeSettingDefinitions[key].group, 'alerts', key);
      assert.equal(runtimeSettingDefinitions[key].kind, 'bigint', key);
      assert.equal(runtimeSettingDefinitions[key].min, 0n, key);
    }
  });

  it('skip a list whose bar is zero, and pass the channel and role through as strings', async () => {
    const client = fakeClient([]);
    const result = await moneyAlerts(client, {
      ...baseConfig,
      staffAlertBigWinMinor: 0n,
      staffAlertDailyProfitMinor: 0n,
      staffAlertChannelId: 1234567890123456789n,
      staffAlertRoleId: 0n,
    } as AppConfig);
    assert.equal(client.sent.length, 1, 'only the holds are read');
    assert.match(client.sent[0]?.text ?? '', /payout_hold_by IS NULL/);
    assert.equal(result.channelId, '1234567890123456789');
    assert.equal(result.roleId, null);
  });

  it('read every game, leave staff out, and rank by profit', async () => {
    const client = fakeClient([]);
    await moneyAlerts(client, baseConfig);
    const wins = client.sent.find((q) => /FROM \(/.test(q.text))?.text ?? '';
    for (const table of ['case_rounds', 'upgrader_rounds', 'roulette_bets', 'blackjack_hands', 'crash_bets', 'mines_games', 'tower_games', 'chicken_games', 'plinko_bets', 'slots_spins', 'coinflip_games', 'mines_duel_games']) {
      assert.ok(wins.includes(`FROM ${table}`) || wins.includes(`JOIN ${table}`), table);
    }
    assert.match(wins, /WHERE w\.payout_minor - w\.wager_minor >= \$2::bigint\n\s+AND NOT \(u\.role = 'admin'/);
    assert.match(wins, /ORDER BY w\.payout_minor - w\.wager_minor DESC/);
    const profits = client.sent.find((q) => /FROM wallet_transactions t/.test(q.text))?.text ?? '';
    assert.match(profits, /interval '24 hours'/);
    assert.match(profits, /AND NOT \(u\.role = 'admin'/);
  });

  it('are served to the bot on a signed route, with the counters it already had', async () => {
    const control = await read('services/api-gateway/src/routes/discord-control.ts');
    assert.match(control, /'\/internal\/v1\/discord\/alerts\/money',\n    \{\n      config: \{ rateLimit: \{ max: 60, timeWindow: '1 minute' \} \},\n      preHandler: async \(request: FastifyRequest\) => verifyDiscordControlSignature\(request, config\),/);
    assert.match(control, /AS cash_withdrawals_waiting/);
    const admin = await front('admin/admin.js');
    assert.match(admin, /alerts: 'Staff alerts \(Discord\)',/);
  });
});

describe('module preloads', () => {
  const generator = async () =>
    (await import(pathToFileURL(path.join(repo, 'scripts/module-preload.mjs')).href)) as {
      expectedHtml(html: string, readModule: (relative: string) => string): string;
      staticImports(source: string): string[];
      readFrontendModule(relative: string): string;
    };

  it('name every module the page loads, and are up to date', async () => {
    const { expectedHtml, readFrontendModule } = await generator();
    const html = await front('index.html');
    assert.equal(expectedHtml(html, readFrontendModule), html, 'index.html is out of date: run node scripts/module-preload.mjs');
    assert.match(html, /<link rel="modulepreload" href="assets\/js\/app\.js\?v=3" \/>/);
    assert.match(html, /<link rel="modulepreload" href="assets\/js\/notices\.js" \/>/);
    // The stylesheets the first paint needs are asked for first.
    assert.ok(html.indexOf('rel="modulepreload"') > html.lastIndexOf('rel="stylesheet" href="assets/css/'));
  });

  it('follow static imports only', async () => {
    const { staticImports } = await generator();
    const source = [
      "import { a, b } from './one.js';",
      'import {',
      '  c,',
      "} from './two.js';",
      "import './three.js';",
      "export { d } from './four.js';",
      " * import { e } from './in-a-comment.js'",
      "const lazy = () => import('./lazy.js');",
      "const text = 'from ./five.js';",
    ].join('\n');
    assert.deepEqual(staticImports(source), ['./one.js', './two.js', './three.js', './four.js']);
  });
});
