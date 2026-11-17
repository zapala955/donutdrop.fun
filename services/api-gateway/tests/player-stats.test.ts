import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { loadConfig } from '../src/config.js';
import { botRequestSignaturePayload } from '../src/lib/bot-auth.js';
import { communityBotSignaturePayload } from '../src/lib/community-bot-auth.js';
import { hmacHex } from '../src/lib/crypto.js';
import { Database } from '../src/lib/db.js';
import { statsSchema } from '../src/lib/player-stats.js';
import { playtimeText, renderStatsCard, statText, statsCardSvg, STATS_CARD_HEIGHT, STATS_CARD_WIDTH } from '../src/lib/stats-card.js';
import { registerPlayerStatsRoutes } from '../src/routes/player-stats.js';

/* The owner, 2026-11-17: the unused bot becomes "the stats bot and players do /stats (player) in the
 * community bot and it shows a players stats in the donutsmp ... a photo whould be better ... money,
 * shards, kills, deaths, playtime blocks placed, blocks broken ... make sure it gets the stats by
 * running /stats on donutsmp and make sure it has no proxy", then of the picture: a watermark, "more
 * premium", "actual icons", a smaller skin, a bigger name and no "DonutSMP" line under it. */

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

const SAMPLE = {
  money: { display: '$1.24B', value: 1_240_000_000 },
  shards: { display: '18,450', value: 18_450 },
  kills: { display: '2,317', value: 2_317 },
  deaths: { display: '941', value: 941 },
  playtime: { display: '41d 7h', value: 41 * 86_400 + 7 * 3_600 },
  blocksPlaced: { display: '384,120', value: 384_120 },
  blocksBroken: { display: '1,902,447', value: 1_902_447 },
};

describe('the stats card', () => {
  it('shows every figure, money in gold, with an icon each, the name large and nothing under it', () => {
    const svg = statsCardSvg({ player: 'teexs', stats: SAMPLE, fetchedAt: new Date('2026-11-17T09:00:00Z') });
    for (const text of ['teexs', '$1.24B', '18,450', '41d 7h', '2,317', '941', '384,120', '1.9M', 'Money', 'Shards', 'Playtime', 'Kills', 'Deaths', 'Blocks placed', 'Blocks broken']) {
      assert.ok(svg.includes(`>${text}<`), text);
    }
    assert.match(svg, /fill="#ffaa00" letter-spacing="-3">\$1\.24B</);
    // Seven icons, one set: stroked groups, one per figure.
    assert.equal(svg.match(/stroke-linecap="round" stroke-linejoin="round">/g)?.length, 7);
    // Geist for the card; Archivo only for the wordmark.
    assert.match(svg, /font-family="Geist" font-weight="700" font-size="\d+" fill="#ffffff" letter-spacing="-2">teexs</);
    assert.equal(svg.match(/font-family="Archivo"/g)?.length, 1);
    // What the owner had taken off: the line under the name, the /stats footer, glow and frames.
    assert.doesNotMatch(svg, />DonutSMP</);
    assert.doesNotMatch(svg, /\/stats/);
    assert.doesNotMatch(svg, /Gradient|filter=|blur/);
  });

  it('carries the watermark: the donut monogram over the whole ground, the wordmark and the address', () => {
    const svg = statsCardSvg({ player: 'teexs', stats: SAMPLE, fetchedAt: new Date() });
    assert.ok((svg.match(/<use href="#mark"/g)?.length ?? 0) > 60, 'the monogram covers the card');
    assert.match(svg, /<tspan fill="#ffffff">Donut<\/tspan><tspan fill="#ffaa00">Luxe<\/tspan>/);
    assert.match(svg, />donutluxe\.com</);
  });

  it('draws as a 1200 x 675 PNG, with or without a skin, and with figures missing', () => {
    const png = renderStatsCard({ player: '.Lumberjack_9921', stats: { kills: { display: '0', value: 0 } }, fetchedAt: new Date() });
    assert.equal(png.readUInt32BE(16), STATS_CARD_WIDTH);
    assert.equal(png.readUInt32BE(20), STATS_CARD_HEIGHT);
    const svg = statsCardSvg({ player: 'x_y', stats: { kills: { display: '0', value: 0 } }, fetchedAt: new Date() });
    assert.ok(svg.includes('>—<'), 'a missing figure is a dash');
  });

  it('writes figures the way the site does', () => {
    assert.equal(statText('money', { display: '$1,240,000,000', value: 1_240_000_000 }), '$1.24B');
    assert.equal(statText('kills', { display: '2317', value: 2317 }), '2,317');
    assert.equal(statText('blocksBroken', { display: '1902447', value: 1_902_447 }), '1.9M');
    assert.equal(statText('playtime', { display: '312 hours', value: null }), '312 hours');
    assert.equal(playtimeText(41 * 86_400 + 7 * 3_600 + 59), '41d 7h');
    assert.equal(playtimeText(5 * 3_600 + 30 * 60), '5h 30m');
    assert.equal(playtimeText(42 * 60), '42m');
  });

  it('only takes figures it can print', () => {
    assert.equal(statsSchema.safeParse(SAMPLE).success, true);
    assert.equal(statsSchema.safeParse({}).success, false, 'a lookup with no figure is not found');
    assert.equal(statsSchema.safeParse({ kills: { display: '<script>', value: 1 } }).success, false);
    assert.equal(statsSchema.safeParse({ kills: { display: '1\u0007', value: 1 } }).success, false);
    assert.equal(statsSchema.safeParse({ kills: { display: '1', value: -1 } }).success, false);
  });
});

describe('the stats bot never touches money', () => {
  it('is a role of its own that every money path leaves out', async () => {
    const [migration, auth, minecraft, routes, bots, nodes] = await Promise.all([
      read('packages/db/migrations/102_stats_bot.sql'),
      read('services/api-gateway/src/routes/auth.ts'),
      read('services/api-gateway/src/routes/minecraft-in.ts'),
      read('services/api-gateway/src/routes/player-stats.ts'),
      read('services/api-gateway/src/lib/bots.ts'),
      read('services/api-gateway/src/lib/bot-nodes.ts'),
    ]);
    assert.match(migration, /CHECK \(role IN \('teller', 'vault', 'node', 'stats'\)\)/);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE player_stats_lookups TO donut_api_runtime;/);
    // Payouts, deposits and sweeps pick a bot by a money role by name.
    assert.match(bots, /AND role = \$2 AND status = 'online'/);
    assert.match(bots, /AND role = 'vault' AND status <> 'quarantined'/);
    assert.match(nodes, /AND b\.role = 'node' AND b\.status <> 'quarantined'/);
    // Linking by message or payment never hands a player the stats bot.
    assert.match(auth, /WHERE id = ANY\(\$1::uuid\[\]\) AND status = 'online' AND role <> 'stats'/);
    assert.match(minecraft, /WHERE id = \$1 AND status = 'online' AND role <> 'stats'\n\s+AND lower\(username\) = lower\(\$2\)/);
    // Told it is the stats bot only when it is: the money bots' reader refuses keys it does not know.
    assert.match(minecraft, /\.\.\.\(row\?\.stats \? \{ stats: true \} : \{\}\),/);
    // And it is the only bot a lookup is ever handed to.
    assert.match(routes, /SELECT 1 FROM bot_accounts WHERE id = \$1 AND role = 'stats' AND status <> 'quarantined' AND parked_at IS NULL/);
  });
});

/* The whole loop, against PostgreSQL, through the routes as the two bots call them: signed. */
const databaseUrl = process.env['TEST_DATABASE_URL'];

describe('/stats end to end against PostgreSQL', { skip: !databaseUrl }, () => {
  it('queues, hands the lookup only to the stats bot, takes its report and draws the card', async () => {
    if (!databaseUrl) return;
    const statsBot = randomUUID();
    const tellerBot = randomUUID();
    const statsKey = Buffer.alloc(32, 7);
    const tellerKey = Buffer.alloc(32, 8);
    const communityKey = 'c'.repeat(48);
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      APP_ORIGIN: 'http://localhost:3000',
      COOKIE_SECRET: 'cookie-secret-that-is-long-enough-for-tests',
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      BOT_CREDENTIALS_JSON: JSON.stringify({
        [statsBot]: { secret: statsKey.toString('base64'), serverHost: 'donutsmp.net', username: `St${statsBot.slice(0, 8)}` },
        [tellerBot]: { secret: tellerKey.toString('base64'), serverHost: 'donutsmp.net', username: `Te${tellerBot.slice(0, 8)}` },
      }),
      AUDIT_LOG_HMAC_KEY: 'audit-secret-that-is-long-enough-for-tests',
      IP_HASH_KEY: 'ip-hash-secret-that-is-long-enough-for-tests',
      LOG_LEVEL: 'silent',
      COMMUNITY_BOT_ENABLED: 'true',
      COMMUNITY_BOT_HMAC_KEY: communityKey,
    });
    const db = new Database(config);
    const app = Fastify({ logger: false });
    await registerPlayerStatsRoutes(app, db, config);
    await app.ready();

    const community = async (url: string, body: Record<string, string>) => {
      const timestamp = Date.now().toString();
      const response = await app.inject({
        method: 'POST',
        url,
        headers: {
          'x-community-timestamp': timestamp,
          'x-community-signature': hmacHex(communityKey, communityBotSignaturePayload('POST', url, timestamp, body)),
        },
        payload: body,
      });
      return { status: response.statusCode, body: response.json() as Record<string, unknown> };
    };
    const asBot = async (bot: string, key: Buffer, url: string, extra: Record<string, unknown> = {}) => {
      const body = { eventId: randomUUID(), botId: bot, ...extra };
      const timestamp = Date.now().toString();
      const response = await app.inject({
        method: 'POST',
        url,
        headers: {
          'x-bot-id': bot,
          'x-bot-timestamp': timestamp,
          'x-bot-signature': hmacHex(key, botRequestSignaturePayload('POST', url, bot, timestamp, body)),
        },
        payload: body,
      });
      assert.ok(response.headers['x-api-signature'], 'the bot can check the answer is the gateway’s');
      return { status: response.statusCode, body: response.json() as Record<string, unknown> };
    };
    const tag = statsBot.slice(0, 6);
    const member = `9${Date.now()}`.slice(0, 18);
    const other = `8${Date.now()}`.slice(0, 18);
    const player = `.St_${tag}`;

    try {
      await db.query(
        `INSERT INTO bot_accounts (id, username, status, server_host, last_heartbeat_at, role)
         VALUES ($1, $2, 'online', 'donutsmp.net', now(), 'stats'), ($3, $4, 'online', 'donutsmp.net', now(), 'teller')`,
        [statsBot, `St${statsBot.slice(0, 8)}`, tellerBot, `Te${tellerBot.slice(0, 8)}`],
      );

      const asked = await community('/internal/v1/community/stats/request', { player, discordUserId: member });
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      assert.equal(asked.body['status'], 'queued');
      const lookupId = asked.body['lookupId'] as string;
      // The same player again, by anyone: the same lookup.
      const again = await community('/internal/v1/community/stats/request', { player: player.toUpperCase(), discordUserId: other });
      assert.equal(again.body['lookupId'], lookupId);
      assert.equal(again.body['reused'], true);
      // The same member, a different player, inside the cooldown: refused.
      const tooSoon = await community('/internal/v1/community/stats/request', { player: `Zz${tag}`, discordUserId: member });
      assert.equal(tooSoon.status, 429);

      // A money bot is never handed a lookup.
      const teller = await asBot(tellerBot, tellerKey, '/internal/v1/minecraft/stats/claim');
      assert.equal(teller.status, 200);
      assert.equal(teller.body['lookup'], null);

      const claimed = await asBot(statsBot, statsKey, '/internal/v1/minecraft/stats/claim');
      assert.deepEqual(claimed.body['lookup'], { id: lookupId, player });
      const waiting = await community('/internal/v1/community/stats/result', { lookupId });
      assert.equal(waiting.body['status'], 'running');

      const reported = await asBot(statsBot, statsKey, '/internal/v1/minecraft/stats/report', {
        lookupId,
        outcome: 'found',
        stats: SAMPLE,
        shownName: player,
        raw: { title: 'Stats', items: [{ slot: 10, name: 'Money', lore: ['$1.24B'] }], chat: [], dialog: [] },
      });
      assert.deepEqual(reported.body, { applied: true });
      // A second report of the same lookup changes nothing.
      const late = await asBot(statsBot, statsKey, '/internal/v1/minecraft/stats/report', { lookupId, outcome: 'not_found' });
      assert.deepEqual(late.body, { applied: false });

      const result = await community('/internal/v1/community/stats/result', { lookupId });
      assert.equal(result.body['status'], 'found');
      assert.equal(result.body['player'], player);
      const png = Buffer.from(result.body['cardPng'] as string, 'base64');
      assert.equal(png.readUInt32BE(16), 1200);

      // A player DonutSMP does not know.
      const missing = `.No_${tag}`;
      const unknown = await community('/internal/v1/community/stats/request', { player: missing, discordUserId: other.replace(/^8/, '7') });
      const unknownId = unknown.body['lookupId'] as string;
      const next = await asBot(statsBot, statsKey, '/internal/v1/minecraft/stats/claim');
      assert.deepEqual(next.body['lookup'], { id: unknownId, player: missing });
      await asBot(statsBot, statsKey, '/internal/v1/minecraft/stats/report', { lookupId: unknownId, outcome: 'not_found' });
      const notFound = await community('/internal/v1/community/stats/result', { lookupId: unknownId });
      assert.equal(notFound.body['status'], 'not_found');
      assert.equal(notFound.body['cardPng'], undefined);

      // With the stats bot out of the game, nobody is left waiting on it.
      await db.query(`UPDATE bot_accounts SET last_heartbeat_at = now() - interval '5 minutes' WHERE id = $1`, [statsBot]);
      const offline = await community('/internal/v1/community/stats/request', { player: `Of${tag}`, discordUserId: other.replace(/^8/, '6') });
      assert.equal(offline.status, 409, 'a 4xx, so the community bot shows the member the sentence');
      assert.equal((offline.body['error'] as { code?: string } | undefined)?.code ?? offline.body['code'], 'STATS_BOT_OFFLINE');
    } finally {
      await db.query('DELETE FROM player_stats_lookups WHERE normalized_player LIKE $1', [`%${tag.toLowerCase()}`]).catch(() => undefined);
      await app.close();
      await db.pool.end();
    }
  });
});
