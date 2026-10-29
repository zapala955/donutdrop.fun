import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { CROWN_GAMES, ROUND_SOURCES, beats, roundQuery } from '../src/lib/crowns.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');
const front = (relative: string) => read(`../../../DONUTDROP FRONTEND/Donut Drop/${relative}`);

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

describe('who takes a crown', () => {
  it("a higher multiplier takes it, an empty crown is anybody's", () => {
    assert.equal(
      beats(
        { multiplier_x100: '501', stake_minor: '1' },
        { multiplier_x100: '500', stake_minor: '9' },
      ),
      true,
    );
    assert.equal(
      beats(
        { multiplier_x100: '499', stake_minor: '9' },
        { multiplier_x100: '500', stake_minor: '1' },
      ),
      false,
    );
    assert.equal(beats({ multiplier_x100: '101', stake_minor: '1' }, null), true);
  });

  it('on the same multiplier the bigger stake takes it, and a full tie stays put', () => {
    assert.equal(
      beats(
        { multiplier_x100: '500', stake_minor: '2' },
        { multiplier_x100: '500', stake_minor: '1' },
      ),
      true,
    );
    assert.equal(
      beats(
        { multiplier_x100: '500', stake_minor: '1' },
        { multiplier_x100: '500', stake_minor: '1' },
      ),
      false,
    );
    assert.equal(
      beats(
        { multiplier_x100: '500', stake_minor: '1' },
        { multiplier_x100: '500', stake_minor: '2' },
      ),
      false,
    );
  });

  it('compares as integers, not strings', () => {
    assert.equal(
      beats(
        { multiplier_x100: '1000', stake_minor: '1' },
        { multiplier_x100: '999', stake_minor: '1' },
      ),
      true,
    );
  });
});

describe('the rounds a crown is read from', () => {
  it('crowns the nine house games whose multiplier can move, and no player-versus-player game', () => {
    assert.deepEqual(
      [...CROWN_GAMES],
      ['case', 'upgrader', 'crash', 'mines', 'tower', 'chicken', 'plinko', 'slots', 'dice'],
    );
    for (const game of CROWN_GAMES) assert.ok(ROUND_SOURCES[game], game);
    const tables = Object.values(ROUND_SOURCES).map((source) => source.table);
    for (const pvp of [
      'coinflip_games',
      'mines_duel_games',
      'battle_players',
      'roulette_bets',
      'blackjack_hands',
    ]) {
      assert.ok(!tables.includes(pvp), pvp);
    }
  });

  it('leaves out staff, test twins and inactive accounts, and only counts real wins over the stake floor', () => {
    for (const game of CROWN_GAMES) {
      const sql = roundQuery(game, 'best');
      assert.match(sql, /u\.status = 'active'/, game);
      assert.match(sql, /NOT \(u\.role = 'admin'/, game);
      assert.match(sql, /minecraft_identity NOT LIKE 'demo:%'/, game);
      assert.match(sql, /r\.\w+ >= \$3 AND r\.\w+ > 0 AND r\.\w+ > r\.\w+/, game);
      assert.match(sql, /\* 100\) \/ r\.\w+\) >= \$4/, game);
    }
  });

  it('ranks by multiplier then stake for a crown, and by time for a bounty', () => {
    assert.match(
      roundQuery('plinko', 'best'),
      /ORDER BY \(\(r\.payout_minor \* 100\) \/ r\.stake_minor\) DESC, r\.stake_minor DESC, r\.created_at ASC/,
    );
    assert.match(roundQuery('plinko', 'first'), /ORDER BY r\.created_at ASC, r\.id ASC/);
    assert.match(roundQuery('crash', 'first'), /r\.settled_at >= \$1 AND r\.settled_at <= \$2/);
    assert.match(roundQuery('upgrader', 'best'), /r\.outcome = 'win'/);
  });
});

describe('how it is kept', () => {
  it("reads outside a transaction and writes under the game's lock, giving up if the crown moved", async () => {
    const source = await read('../src/lib/crowns.ts');
    assert.match(
      source,
      /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)', \[`crowns:\$\{game\}`\]/,
    );
    assert.match(
      source,
      /SELECT id FROM crown_reigns WHERE game = \$1 AND ended_at IS NULL FOR UPDATE/,
    );
    assert.match(
      source,
      /if \(\(live\.rows\[0\]\?\.id \?\? null\) !== \(seen\?\.id \?\? null\)\) return null;/,
    );
    assert.match(source, /export const SCAN_OVERLAP_MS = 5 \* 60_000;/);
    assert.ok(
      source.indexOf("roundQuery(game, 'best')") < source.indexOf('return db.transaction'),
      'the rounds are read before the write transaction opens',
    );
  });

  it('pays a bounty once, through the ledger, with the usual wager requirement', async () => {
    const source = await read('../src/lib/crowns.ts');
    assert.match(source, /WHERE id = \$1 AND status = 'open'\s+RETURNING prize_minor/);
    assert.match(
      source,
      /creditWallet\(client, winner\.user_id, prize, 'bounty_reward', bounty\.id\)/,
    );
    assert.match(source, /requirementFor\(prize, config\.signupBonusWagerMultiplier\)/);
  });

  it('is started with the app and stops with it', async () => {
    const app = await read('../src/app.ts');
    assert.match(app, /startCrownSweeper\(app, db, config\);/);
    assert.match(app, /await registerCrownRoutes\(app, db, config\);/);
    const source = await read('../src/lib/crowns.ts');
    assert.match(
      source,
      /timer\.unref\(\);\s+app\.addHook\('onClose', async \(\) => clearInterval\(timer\)\);/,
    );
  });
});

describe('the routes', () => {
  it('serve the board to anybody and the bounty buttons to staff only', async () => {
    const source = await read('../src/routes/crowns.ts');
    assert.match(
      source,
      /'\/v1\/crowns',\s+\{ preHandler: softAuth, config: \{ rateLimit: \{ max: 60, timeWindow: '1 minute' \} \} \}/,
    );
    assert.match(source, /'\/v1\/crowns\/bounties',\s+\{ preHandler: guards\.requireAdmin/);
    assert.match(
      source,
      /'\/v1\/crowns\/bounties\/:id\/cancel',\s+\{ preHandler: guards\.requireAdmin/,
    );
    assert.match(source, /action: 'crown_bounty\.create'/);
    assert.match(source, /action: 'crown_bounty\.cancel'/);
    assert.match(source, /prize > config\.crownBountyMaxPrizeMinor/);
  });

  it('show masked names only', async () => {
    const source = await read('../src/lib/crowns.ts');
    assert.match(source, /\$\{maskedName\('u\.minecraft_username'\)\} AS name/);
    assert.match(source, /\$\{maskedName\('w\.minecraft_username'\)\} END AS winner_name/);
    assert.doesNotMatch(source, /minecraft_username AS (?:name|winner_name)/);
  });
});

describe('the settings', () => {
  it('ship on, 30 days, a 1M stake floor, a 30 second sweep and a 1B bounty cap', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.crownsEnabled, true);
    assert.equal(config.crownWindowDays, 30);
    assert.equal(config.crownMinStakeMinor, 1_000_000n);
    assert.equal(config.crownSweepSeconds, 30);
    assert.equal(config.crownBountyMaxPrizeMinor, 1_000_000_000n);
    assert.equal(loadConfig({ ...baseEnv, CROWNS_ENABLED: 'false' }).crownsEnabled, false);
    assert.throws(() => loadConfig({ ...baseEnv, CROWN_WINDOW_DAYS: '0' }), /CROWN_WINDOW_DAYS/);
  });

  it('can be changed live from the System tab, all but the sweep interval', () => {
    for (const key of [
      'crownsEnabled',
      'crownWindowDays',
      'crownMinStakeMinor',
      'crownBountyMaxPrizeMinor',
    ] as const) {
      assert.ok(key in runtimeSettingDefinitions, key);
      assert.equal(runtimeSettingDefinitions[key].group, 'crowns');
    }
    assert.ok(!('crownSweepSeconds' in runtimeSettingDefinitions));
  });
});

describe('the migration', () => {
  it('adds three tables and one ledger kind, and nothing destructive', async () => {
    const sql = await read('../../../packages/db/migrations/081_crowns.sql');
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE|ALTER COLUMN/i);
    assert.match(sql, /CREATE TABLE crown_reigns/);
    assert.match(sql, /CREATE TABLE crown_scan_state/);
    assert.match(sql, /CREATE TABLE crown_bounties/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX crown_reigns_current_idx ON crown_reigns \(game\) WHERE ended_at IS NULL;/,
    );
    assert.match(sql, /ended_by uuid REFERENCES crown_reigns\(id\) DEFERRABLE INITIALLY DEFERRED/);
    /* The kind list is rebuilt in full, so it must carry every kind the migrations before it added
     * (fishing, ice fishing and the derby came in 076-078) with 'bounty_reward' on the end. */
    assert.match(sql, /'derby_stake', 'derby_payout',\s*'bounty_reward'/);
    for (const kind of ['slots_payout', 'fishing_stake', 'fishing_payout', 'ice_fishing_stake', 'ice_fishing_payout']) {
      assert.match(sql, new RegExp(`'${kind}'`), `${kind} would be dropped from the ledger`);
    }
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v81\(\) RETURNS boolean/);
  });

  it('names the new ledger kind everywhere a kind has to be named', async () => {
    assert.match(await read('../src/lib/wallet.ts'), /\| 'bounty_reward'/);
    assert.match(await read('../src/lib/admin-stats.ts'), /bounty_reward: 'Bounties'/);
    assert.match(await front('assets/js/account.js'), /bounty_reward: 'Bounty'/);
  });
});

describe('what the player sees', () => {
  it('the bell hears about a lost crown, a fallen one and a bounty won', async () => {
    const lib = await read('../src/lib/notifications.ts');
    assert.match(lib, /kind: row\.ended_reason === 'expired' \? 'crown_expired' : 'crown_lost'/);
    assert.match(lib, /kind: 'bounty_won'/);
    assert.match(
      lib,
      /AND \(n\.id IS NULL OR n\.user_id <> r\.user_id\)/,
      'beating your own record is not news',
    );
    const page = await front('assets/js/notices.js');
    for (const kind of ['crown_lost', 'crown_expired', 'bounty_won'])
      assert.match(page, new RegExp(`${kind}: \\{`), kind);
  });

  it('the leaderboard carries the crowns, and the stream refreshes them', async () => {
    const html = await front('index.html');
    assert.match(
      html,
      /<div class="crowns" id="crownsRoot"><\/div>\s+<div class="board" id="boardRoot"><\/div>/,
    );
    assert.match(html, /<link rel="stylesheet" href="assets\/css\/crowns\.css" \/>/);
    assert.match(await front('assets/js/board.js'), /mountCrowns\(\$\('#crownsRoot', view\)\);/);
    assert.match(
      await front('assets/js/live.js'),
      /source\.addEventListener\('crowns', \(\) => window\.dispatchEvent\(new CustomEvent\('donut:crowns'\)\)\);/,
    );
    assert.match(await read('../src/lib/live-events.ts'), /\| 'crowns'/);
  });

  it('a holder wears the crown in chat while crowns are on', async () => {
    const route = await read('../src/routes/chat.ts');
    assert.match(route, /cr\.user_id = m\.user_id AND cr\.ended_at IS NULL\) AS crowns/);
    assert.match(
      route,
      /config\.crownsEnabled && row\.crowns\?\.length \? \{ crowns: row\.crowns \} : \{\}/,
    );
    assert.match(await front('assets/js/chat.js'), /el\('i', 'msg__badge msg__badge--crown'\)/);
  });
});
