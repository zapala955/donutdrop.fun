import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  allRoundsSql,
  historyPageSql,
  ROUND_GAMES,
  ROUND_SOURCES,
  roundsUnion,
} from '../src/lib/player-rounds.js';
import { SLOTS_MACHINES } from '../src/lib/slots.js';
import { historyBody, REWARD_KINDS, statisticsBody } from '../src/routes/insights.js';

/* The statistics and history pages counted the upgrader alone (and crates and battles, on the
 * statistics page), from when that was the whole site, and the statistics page's "net profit /
 * loss" was the whole wallet ledger, deposits and withdrawals included. Both now read every game's
 * rounds through one list of sources. The SQL was run against production on 2026-10-21: per game,
 * its stakes and payouts matched the ledger's stake and payout entries to the unit. */

const repo = path.resolve(import.meta.dirname, '../../..');
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');

describe('the rounds behind the statistics and history pages', () => {
  it('reads every game table, the player\'s own rows only', () => {
    const sql = allRoundsSql();
    for (const table of ['upgrader_rounds', 'case_rounds', 'battle_players', 'roulette_bets', 'blackjack_hands', 'crash_bets', 'mines_games', 'tower_games', 'chicken_games', 'plinko_bets', 'dice_bets', 'slots_spins', 'coinflip_games', 'mines_duel_games']) {
      assert.ok(sql.includes(`FROM ${table}`), table);
    }
    for (const source of ROUND_SOURCES) assert.match(source.where, /\$1/, source.key);
  });

  it('counts a round once it has settled, never one still in play or one that was cancelled', () => {
    const where = (key: string) => ROUND_SOURCES.find((source) => source.key === `'${key}'`)!.where;
    for (const game of ['blackjack', 'mines', 'tower', 'chicken', 'coinflip', 'mines-duel', 'battles']) {
      assert.match(where(game), /status = 'settled'/, game);
    }
    assert.match(where('crash'), /status IN \('cashed_out', 'lost'\)/);
    assert.match(where('roulette'), /rr\.status = 'settled'/);
  });

  it('pays a mines duel draw back exactly, a doubled hand stakes twice, an upgrader loss pays nothing', () => {
    const source = (key: string) => ROUND_SOURCES.find((entry) => entry.key === `'${key}'`)!;
    assert.match(source('mines-duel').payout, /WHEN g\.outcome = 'draw' THEN g\.stake_minor/);
    assert.match(source('blackjack').wager, /CASE WHEN h\.doubled THEN 2 ELSE 1 END/);
    assert.equal(source('upgrader').payout, 'coalesce(r.payout_minor, 0)');
  });

  it('names every game a round can carry, every slot machine included', () => {
    for (const machine of Object.values(SLOTS_MACHINES)) assert.equal(ROUND_GAMES[machine.id], machine.name);
    for (const source of ROUND_SOURCES) if (source.game) assert.ok(ROUND_GAMES[source.game], source.game);
  });

  it('pages each table off its index, and narrows to one game without reading the others', () => {
    const page = historyPageSql(null);
    assert.equal((page.match(/LIMIT \$3::int/g) ?? []).length, ROUND_SOURCES.length + 1);
    assert.match(page, /to_char\(rounds\.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS at/);
    assert.match(page, /ORDER BY rounds\.at DESC, rounds\.id DESC/);

    const mines = historyPageSql('mines');
    assert.ok(mines.includes('FROM mines_games'));
    assert.ok(!mines.includes('FROM plinko_bets'), 'a filter on mines reads no other game');
    // A machine is a column, not a table: the slots source stays and narrows itself.
    assert.ok(mines.includes('FROM slots_spins') && mines.includes('s.machine = $4::text'));
    const oreRush = roundsUnion({ before: null, game: '$4', gameValue: 'ore-rush', limit: null });
    assert.ok(oreRush.includes('FROM slots_spins') && !oreRush.includes('FROM mines_games'));
  });

  it('counts rewards beside the games, never deposits, withdrawals, tips or game payouts', () => {
    for (const kind of ['cash_deposit', 'pay_login_deposit', 'cash_withdrawal', 'tip_received', 'admin_adjustment', 'demo_topup', 'mines_payout', 'case_win', 'battle_refund']) {
      assert.ok(!REWARD_KINDS.includes(kind), kind);
    }
    for (const kind of ['rakeback_claim', 'streak_reward', 'daily_code_reward', 'rain_claim']) {
      assert.ok(REWARD_KINDS.includes(kind), kind);
    }
  });
});

describe('the statistics body', () => {
  const row = (game: string, rounds: number, wins: number, wagered: string, paid: string, best: string | null, top: [string, string] | null) => ({
    game, rounds, wins, wagered, paid, best, top_wager: top?.[0] ?? null, top_payout: top?.[1] ?? null,
  });

  it('adds every game up, signs the result, and finds the biggest win across them', () => {
    const body = statisticsBody(
      [
        row('plinko', 681, 124, '152590850000', '136768217000', '23.5', ['1000000000', '3100000000']),
        row('mines', 130, 17, '14961550000', '28385560597', '22.5', ['1000000000', '22500000000']),
        row('dice', 17, 7, '11600000', '8823600', '2.8836', ['1000000', '2883600']),
      ],
      '2304000000',
      [{ name: 'Skull Market', opens: '3', spent: '1500000000' }],
    );
    assert.equal(body.totals.rounds, 828);
    assert.equal(body.totals.wins, 148);
    assert.equal(body.totals.wageredMinor, '167564000000');
    assert.equal(body.totals.paidMinor, '165162601197');
    assert.equal(body.totals.netMinor, '-2401398803');
    assert.equal(body.totals.rewardsMinor, '2304000000');
    assert.deepEqual(body.biggestWin, { game: 'mines', name: 'Mines', wagerMinor: '1000000000', payoutMinor: '22500000000', multiplier: 22.5 });
    assert.equal(body.bestMultiplier, 23.5);
    assert.deepEqual(body.favouriteGame, { game: 'plinko', name: 'Plinko' });
    assert.equal(body.games[1]!.netMinor, '13424010597');
    assert.equal(body.games[2]!.bestMultiplier, 2.88);
    assert.deepEqual(body.favouriteCases, [{ name: 'Skull Market', opens: 3, spentMinor: '1500000000' }]);
  });

  it('says nothing was played rather than a 0% record', () => {
    const body = statisticsBody([], '0', []);
    assert.equal(body.totals.winRate, null);
    assert.equal(body.biggestWin, null);
    assert.equal(body.bestMultiplier, null);
    assert.equal(body.favouriteGame, null);
    assert.equal(body.totals.netMinor, '0');
  });
});

describe('the history body', () => {
  const round = (at: string, wager: string, payout: string, detail = '') => ({ game: 'ore-rush', id: at, at, wager, payout, detail });

  it('hands back the last round\'s time as the cursor on a full page, and none on the last page', () => {
    const full = historyBody([round('2026-10-21T13:06:04.132097Z', '50000000', '0'), round('2026-10-21T13:06:00.201175Z', '50000000', '60000000', 'x')], 2);
    assert.equal(full.next, '2026-10-21T13:06:00.201175Z');
    assert.equal(full.rounds[0]!.name, 'Ore Rush');
    assert.equal(full.rounds[0]!.multiplier, 0);
    assert.equal(full.rounds[0]!.detail, null);
    assert.equal(full.rounds[1]!.multiplier, 1.2);
    assert.ok(full.games.some((game) => game.game === 'monument' && game.name === 'Ocean Monument'));
    assert.equal(historyBody([round('2026-10-21T13:06:04.132097Z', '1', '0')], 2).next, null);
  });

  it('rounds a multiplier down, never up', () => {
    assert.equal(historyBody([round('2026-10-21T00:00:00Z', '3', '10')], 50).rounds[0]!.multiplier, 3.33);
  });
});

describe('the two pages', () => {
  it('read every game from the new routes, and the statistics no longer read the ledger as a result', async () => {
    const insights = await read('services/api-gateway/src/routes/insights.ts');
    const statistics = insights.slice(insights.indexOf("app.get('/v1/statistics'"), insights.indexOf("app.get('/v1/history'"));
    assert.doesNotMatch(statistics, /amount_minor > 0|amount_minor < 0/);
    assert.match(insights, /app\.get\('\/v1\/history', \{ preHandler: guards\.authenticate \}/);

    const account = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/account.js');
    assert.match(account, /roundHistory\(\{ game: historyGame, before, limit: HISTORY_PAGE \}\)/);
    assert.match(account, /el\('div', 'lxtabs hist__filter'\)/);
    assert.match(account, /if \(token !== historyToken\) return;/);
    assert.doesNotMatch(account, /upgradeHistory/);

    const board = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/board.js');
    assert.doesNotMatch(board, /data\.upgrader|breakdown\(/);
    assert.match(board, /statsRoot\.appendChild\(byGame\(data\.games\)\);/);
  });
});
