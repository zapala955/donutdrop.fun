import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ADJUSTMENT_KINDS,
  buildStatsReport,
  DEPOSIT_KINDS,
  GAMES,
  ITEM_BUYBACK_KINDS,
  PROMO_KINDS,
  staffPredicate,
  statsWindow,
  summarize,
  summarizeGames,
  toJson,
  WITHDRAWAL_KINDS,
  type KindAggregate,
} from '../src/lib/admin-stats.js';

/*
 * The admin dashboard: what was wagered, what the house kept, what it paid back, and the net.
 *
 * Every figure is a sum over wallet ledger kinds, so the one way it silently goes wrong is a kind
 * nobody told it about -- a new game whose stakes are not turnover, a new reward that is not a
 * cost. The first test reads the ledger's own CHECK constraint and fails until every kind is
 * placed somewhere.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

const kinds = (entries: Record<string, [amount: number, rows?: number, users?: number]>) =>
  new Map<string, KindAggregate>(
    Object.entries(entries).map(([kind, [amount, rows = 1, users = 1]]) => [
      kind,
      { amount: BigInt(amount), rows, users },
    ]),
  );

describe('admin dashboard figures', () => {
  it('places every ledger kind the database allows', async () => {
    const directory = path.join(root, 'packages/db/migrations');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    let latest = '';
    for (const file of files) {
      const sql = await readFile(path.join(directory, file), 'utf8');
      const at = sql.lastIndexOf('wallet_transactions_kind_check');
      if (at >= 0 && /CHECK \(kind IN \(/.test(sql.slice(at))) latest = sql.slice(at);
    }
    const allowed = [...latest.slice(0, latest.indexOf('));')).matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1] ?? '',
    );
    assert.ok(allowed.length > 40, 'the kind constraint was found');
    /* Not the house's money either way: a tip moves cash between two players, and the piggy bank
     * was retired before it took a stake. */
    const neutral = ['tip_sent', 'tip_received', 'piggy_open', 'piggy_claim', 'piggy_break'];
    const placed = new Set<string>([
      ...GAMES.flatMap((game) => [...game.stakes, ...game.payouts, ...game.refunds]),
      ...Object.keys(PROMO_KINDS),
      ...ITEM_BUYBACK_KINDS,
      ...DEPOSIT_KINDS,
      ...WITHDRAWAL_KINDS,
      ...ADJUSTMENT_KINDS,
      ...neutral,
    ]);
    assert.deepEqual(
      allowed.filter((kind) => !placed.has(kind)),
      [],
      'a ledger kind the dashboard does not count',
    );
  });

  it('takes turnover, house take and net from signed ledger sums', () => {
    const totals = summarize(
      kinds({
        case_open: [-1_000, 10],
        case_win: [900],
        battle_stake: [-500, 4],
        battle_refund: [100, 1],
        battle_win: [350],
        rakeback_claim: [20],
        signup_bonus: [5],
        item_sale: [30],
        cash_deposit: [2_000],
        cash_withdrawal: [-800],
        cash_withdrawal_refund: [100],
        admin_adjustment: [-50],
        tip_sent: [-70],
        tip_received: [70],
      }),
    );
    // Stakes less refunds: a refunded battle seat was never a bet.
    assert.equal(totals.wagered, 1_400n);
    assert.equal(totals.bets, 13);
    // Kept: 1000 - 900 on cases, 500 - 100 - 350 on battles.
    assert.equal(totals.ggr, 150n);
    assert.equal(totals.promo, 25n);
    assert.equal(totals.itemBuybacks, 30n);
    assert.equal(totals.net, 95n);
    assert.equal(totals.deposits, 2_000n);
    // A withdrawal refunded after a failed payout never left.
    assert.equal(totals.withdrawals, 700n);
    assert.equal(totals.adjustments, -50n);
  });

  it('reports each game on its own, and counts a blackjack double as the same player', () => {
    const games = summarizeGames(
      kinds({
        blackjack_stake: [-300, 3, 2],
        blackjack_double: [-100, 1, 1],
        blackjack_payout: [450],
        coinflip_stake: [-200, 2, 2],
        coinflip_refund: [100, 1, 1],
        coinflip_win: [95],
      }),
    );
    assert.deepEqual(
      games.map((game) => [game.key, game.wagered, game.bets, game.players, game.ggr]),
      [
        ['blackjack', 400n, 4, 2, -50n],
        ['coinflip', 100n, 1, 2, 5n],
      ],
    );
  });

  it('compares like with like: a window and the same span before it', () => {
    const now = new Date('2026-10-04T14:25:00Z');
    const today = statsWindow(1, now);
    assert.equal(today.from.toISOString(), '2026-10-04T00:00:00.000Z');
    assert.equal(today.previousFrom.toISOString(), '2026-10-03T09:35:00.000Z');
    assert.equal(today.unit, 'hour');
    assert.equal(today.buckets.length, 15);
    const week = statsWindow(7, now);
    assert.equal(week.from.toISOString(), '2026-09-28T00:00:00.000Z');
    assert.equal(week.unit, 'day');
    assert.equal(week.buckets.length, 7);
    assert.equal(
      week.from.getTime() - week.previousFrom.getTime(),
      now.getTime() - week.from.getTime(),
    );
  });

  it('leaves staff out unless asked: admins, the developer login and system accounts', () => {
    const sql = staffPredicate('u');
    assert.match(sql, /u\.role = 'admin'/);
    assert.match(sql, /u\.minecraft_identity LIKE 'dev:%'/);
    assert.match(sql, /u\.minecraft_identity LIKE 'system:%'/);
  });

  it('fills every bucket, a quiet one with zeros, and answers in JSON-safe text', async () => {
    const seen: string[] = [];
    const db = {
      query: (text: string) => {
        seen.push(text);
        return Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });
      },
    };
    const report = await buildStatsReport(db as never, {
      days: 7,
      includeStaff: false,
      now: new Date('2026-10-04T14:25:00Z'),
    });
    assert.equal(report.series.length, 7);
    assert.ok(report.series.every((point) => point.net === 0n && point.players === 0));
    assert.deepEqual(report.games, []);
    const json = JSON.parse(JSON.stringify(toJson(report))) as { totals: { net: string } };
    assert.equal(json.totals.net, '0');
    // Every query that reads player rows is filtered, with the switch as a bound parameter.
    for (const text of seen.filter((sql) => /JOIN users u|FROM users u/.test(sql))) {
      if (/WHERE \(u\.role = 'admin'/.test(text)) continue; // the staff count itself
      assert.match(text, /\(\$3::boolean OR NOT \(u\.role = 'admin'/);
    }
  });
});

describe('admin dashboard wiring', () => {
  it('serves the report to administrators only, and keeps staff out of the overview', async () => {
    const source = await read('services/api-gateway/src/routes/admin-operations.ts');
    assert.match(source, /app\.get\('\/v1\/admin\/stats', \{ preHandler: requireAdminRead \}/);
    const overview = source.slice(
      source.indexOf("app.get('/v1/admin/overview'"),
      source.indexOf("app.get('/v1/admin/stats'"),
    );
    assert.match(overview, /FROM users u WHERE \$\{NOT_STAFF\}\)::text AS users_total/);
    assert.match(overview, /FROM wager_events e JOIN users u ON u\.id = e\.user_id/);
    assert.match(overview, /AS wagered_today_minor/);
    assert.match(overview, /FROM roulette_bets b JOIN users u ON u\.id = b\.user_id/);
    assert.match(overview, /AS wallet_staff_minor/);
  });

  it('indexes the ledger by time for the windowed sums', async () => {
    const sql = await read('packages/db/migrations/055_admin_stats.sql');
    assert.match(
      sql,
      /CREATE INDEX wallet_transactions_created_idx ON wallet_transactions \(created_at\);/,
    );
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v55\(\) RETURNS boolean/);
  });

  it('draws the dashboard from the report, with the period and staff switch above it', async () => {
    const html = await read('DONUTDROP FRONTEND/Donut Drop/admin/index.html');
    const script = await read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js');
    for (const id of [
      'dashRange',
      'dashStaff',
      'dashHero',
      'dashKpis',
      'chartWagered',
      'chartCash',
      'chartPlayers',
      'dashGames',
      'dashCosts',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(script, /`\/v1\/admin\/stats\?days=\$\{dashState\.days\}&includeStaff=/);
    // A slower answer to an earlier click never paints over the period chosen since.
    assert.match(script, /if \(seq !== dashState\.seq\) return;/);
    // Every chart answers the pointer.
    assert.match(script, /target\.addEventListener\('pointermove', show\)/);
  });
});
