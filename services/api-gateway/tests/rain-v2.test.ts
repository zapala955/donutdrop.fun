import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { drawRainPool } from '../src/lib/lava-rain.js';
import { countedWagerMinor } from '../src/lib/rewards.js';
import { RuntimeSettings, runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

/* Lava Rain, 2026-11-14. The owner: "i want the rains to be a random amount from 300m to 1.5b, 20x
 * wager req and send messages to the discord channel ... make sure they have to wear the server tag,
 * have 25m deposited in the last 3 days to enter ... MAKE SURE THE WAGER REQ WORKS CORRECTLY ITS THE
 * MOST IMPORTANT THING". The rain lock itself is in rain-lock.test.ts; this file holds the rest, and
 * the ways around the lock that were closed with it. */

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

const config = loadConfig({
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
});

describe('how big a drop is', () => {
  it('is $300M to $1.5B by default, a 20x hold, the tag and $25M deposited in 3 days to enter', () => {
    assert.equal(config.lavaRainPoolMinMinor, 300_000_000n);
    assert.equal(config.lavaRainPoolMaxMinor, 1_500_000_000n);
    assert.equal(config.rainWagerMultiplier, 20);
    assert.equal(config.lavaRainTagRequired, true);
    assert.equal(config.lavaRainMinDepositMinor, 25_000_000n);
    assert.equal(config.lavaRainDepositWindowHours, 72);
    // A pool typed by hand is still capped, now at the top of the range.
    assert.equal(config.lavaRainMaxPoolMinor, 1_500_000_000n);
    for (const key of ['lavaRainPoolMinMinor', 'lavaRainPoolMaxMinor', 'lavaRainTagRequired', 'lavaRainMinDepositMinor', 'lavaRainDepositWindowHours'] as const) {
      assert.equal(runtimeSettingDefinitions[key].group, 'rain', key);
    }
  });

  it('draws whole millions, every one of them in range, both ends reachable', () => {
    for (let index = 0; index < 5_000; index += 1) {
      const pool = drawRainPool(config);
      assert.ok(pool >= 300_000_000n && pool <= 1_500_000_000n, String(pool));
      assert.equal(pool % 1_000_000n, 0n);
    }
    assert.equal(drawRainPool(config, (min) => min), 300_000_000n);
    assert.equal(drawRainPool(config, (_min, max) => max - 1), 1_500_000_000n);
    // A range under a million draws to the unit; a reversed one is read the right way round.
    const tiny = { lavaRainPoolMinMinor: 10n, lavaRainPoolMaxMinor: 20n };
    assert.equal(drawRainPool(tiny, (_min, max) => max - 1), 20n);
    assert.equal(drawRainPool({ lavaRainPoolMinMinor: 1_500_000_000n, lavaRainPoolMaxMinor: 300_000_000n }, (min) => min), 300_000_000n);
  });

  it('refuses a smallest pool above the largest, live and at boot', () => {
    const settings = new RuntimeSettings(config);
    assert.throws(() => settings.validate({ lavaRainPoolMinMinor: '2000000000' }));
    assert.doesNotThrow(() => settings.validate({ lavaRainPoolMinMinor: '500000000' }));
    assert.throws(() => loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      APP_ORIGIN: 'http://localhost:3000',
      COOKIE_SECRET: 'c'.repeat(32),
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      BOT_CREDENTIALS_JSON: JSON.stringify({ '10000000-0000-4000-8000-000000000001': { secret: Buffer.alloc(32, 2).toString('base64'), serverHost: 'donutsmp.net', username: 'DonutBot' } }),
      AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
      IP_HASH_KEY: 'i'.repeat(32),
      LAVA_RAIN_POOL_MIN_MINOR: '2000000000',
    }), /LAVA_RAIN_POOL_MIN_MINOR/);
  });

  it('draws every automatic drop, and a drop by hand with no pool typed', async () => {
    const route = await read('services/api-gateway/src/routes/social.ts');
    assert.match(route, /const pool = drawRainPool\(config\);/);
    assert.match(route, /const pool = body\.poolMinor === undefined \? drawRainPool\(config\) : BigInt\(body\.poolMinor\);/);
    assert.doesNotMatch(route, /lavaRainAutoPoolMinor/);
  });
});

describe('who may claim', () => {
  it('checks the bar, then the deposit, then asks Discord about the tag, all before the drop is locked', async () => {
    const route = await read('services/api-gateway/src/routes/social.ts');
    const claim = route.slice(route.indexOf("'/v1/social/rain/claim'"));
    const entry = claim.indexOf('await assertRainEntry(db, config, userId);');
    const lock = claim.indexOf('FOR UPDATE');
    assert.ok(entry > 0 && entry < lock, 'the entry rules come before the lock');
    assert.ok(claim.indexOf("'RAIN_NOT_ELIGIBLE'") < entry, 'the bar is checked before Discord is asked');
    const lib = await read('services/api-gateway/src/lib/lava-rain.ts');
    // The tag is asked afresh at the claim, so a tag put on a second ago counts.
    assert.match(lib, /const checked = await rainEntry\(client, config, userId, 'fresh'\);/);
    for (const code of ['RAIN_NEEDS_DEPOSIT', 'RAIN_NEEDS_DISCORD', 'RAIN_NEEDS_TAG', 'RAIN_TAG_UNKNOWN']) assert.ok(lib.includes(`'${code}'`), code);
    // Real deposits only: the same kinds the code drops count.
    assert.match(lib, /depositedWithin\(client, userId, config\.lavaRainDepositWindowHours\)/);
  });

  it('is announced in Discord by the community bot, taken by one ask and recorded', async () => {
    const [lib, routes, sql] = await Promise.all([
      read('services/api-gateway/src/lib/lava-rain.ts'),
      read('services/api-gateway/src/routes/community-bot.ts'),
      read('packages/db/migrations/098_rain_discord_posts.sql'),
    ]);
    assert.match(lib, /UPDATE lava_rain_events e SET discord_announced_at = now\(\)/);
    assert.match(routes, /'\/internal\/v1\/community\/rain\/tick'/);
    assert.match(routes, /'\/internal\/v1\/community\/rain\/message'/);
    assert.match(sql, /ADD COLUMN discord_announced_at timestamptz,/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v98\(\) RETURNS boolean/);
  });
});

describe('the launch, the five-hour clock, one claim per network (2026-11-15)', () => {
  it('queues a $3B launch drop the new API opens, and sets a drop every 300 minutes, on the live database only', async () => {
    const sql = await read('packages/db/migrations/099_rain_launch.sql');
    assert.match(sql, /CREATE TABLE lava_rain_scheduled \(/);
    assert.match(sql, /SELECT gen_random_uuid\(\), 3000000000, 30, 'Launch of the new Lava Rain/);
    assert.match(sql, /'lavaRainAutoEveryMinutes', to_jsonb\(300\)/);
    // Every drop open for 30 minutes (the owner, 2026-11-15), the default and the live setting alike.
    assert.match(sql, /'lavaRainClaimMinutes', to_jsonb\(30\)/);
    assert.equal(config.lavaRainClaimMinutes, 30);
    // All guarded: a fresh database or a test run gets none of them.
    assert.equal((sql.match(/EXISTS \(SELECT 1 FROM lava_rain_events\)/g) ?? []).length, 3);
    assert.match(sql, /GRANT SELECT, DELETE ON TABLE lava_rain_scheduled TO donut_api_runtime;/);
  });

  it('opens a queued drop before an automatic one, once, under the same lock, only while nothing is falling', async () => {
    const route = await read('services/api-gateway/src/routes/social.ts');
    assert.match(route, /if \(\(await openScheduledRain\(\)\) \|\| \(await autoDropRain\(\)\)\) liveEvents\.publish\('rain'\);/);
    const open = route.slice(route.indexOf('async function openScheduledRain()'), route.indexOf('/* ── the rain clock ──'));
    assert.ok(open.indexOf("pg_advisory_xact_lock(hashtextextended('lava-rain-create', 0))") < open.indexOf('DELETE FROM lava_rain_scheduled'));
    assert.ok(open.indexOf("status = 'open' AND closes_at > now()") < open.indexOf('DELETE FROM lava_rain_scheduled'));
    assert.match(open, /next\.claim_minutes \?\? config\.lavaRainClaimMinutes/);
  });

  it('takes one claim per network on each drop, refusing an unreadable address, held by an index too', async () => {
    const [route, sql, chat, post] = await Promise.all([
      read('services/api-gateway/src/routes/social.ts'),
      read('packages/db/migrations/100_rain_networks.sql'),
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/chat.js'),
      read('services/community-bot/src/features/rain-posts.ts'),
    ]);
    const claim = route.slice(route.indexOf("'/v1/social/rain/claim'"));
    assert.match(claim, /const network = networkHash\(config, request\.ip\);\n\s*if \(!network\) throw new AppError\(403, 'RAIN_NETWORK_UNKNOWN'/);
    // Before Discord is asked, and again under the drop's row lock.
    assert.ok(claim.indexOf("'RAIN_NETWORK_USED'") < claim.indexOf('await assertRainEntry(db, config, userId);'));
    assert.ok(claim.indexOf('FOR UPDATE') < claim.lastIndexOf("'RAIN_NETWORK_USED'"));
    assert.match(claim, /INSERT INTO lava_rain_claims \(event_id, user_id, qualifying_wagered_minor, network_hash\)/);
    assert.match(sql, /CREATE UNIQUE INDEX lava_rain_claims_network_idx\s+ON lava_rain_claims \(event_id, network_hash\)/);
    // Kept, but not spelled out on the card or in the Discord post (the owner, 2026-11-15).
    assert.doesNotMatch(chat, /One claim per connection/);
    assert.doesNotMatch(post, /claim per connection/);
    assert.match(chat, /if \(you\?\.networkUsed\) return \{ label: 'Already claimed', go: null \};/);
  });
});

describe('the 20x cannot be walked around', () => {
  it('keeps held rain money off every game against another player', async () => {
    for (const file of ['coinflip', 'mines-duel', 'duels', 'battles', 'sidebets']) {
      const route = await read(`services/api-gateway/src/routes/${file}.ts`);
      const guard = route.indexOf('await assertRainMoneyStays(client, userId, stake);');
      const debit = route.indexOf('balance_minor = balance_minor - $2', guard);
      assert.ok(guard > 0 && debit > guard, `${file}: the rain check comes before the stake is taken`);
    }
  });

  it('counts a PvP stake against the rain lock only as the house wager its rake is worth', async () => {
    const settlement = await read('services/api-gateway/src/lib/cash-settlement.ts');
    assert.match(settlement, /await reduceWagerRequirement\(client, userId, amountMinor, countedWagerMinor\(config, amountMinor, marginMinor\)\);/);
    // A $10M duel at a 3% rake earns $300K, worth $3M of house wagering at a 10% edge.
    assert.equal(countedWagerMinor(config, 10_000_000n, 300_000n), 3_000_000n);
    assert.equal(countedWagerMinor(config, 10_000_000n), 10_000_000n);
  });

  it('counts an open Stocks position as money in play, so going broke into one forgives nothing', async () => {
    const lib = await read('services/api-gateway/src/lib/wager-requirements.ts');
    assert.match(lib, /NOT EXISTS \(SELECT 1 FROM stocks_positions g WHERE g\.user_id = \$1 AND g\.status = 'open'\)/);
  });
});

const databaseUrl = process.env['TEST_DATABASE_URL'];

describe('the rain lock against PostgreSQL', { skip: !databaseUrl }, () => {
  it('holds the share at 20x, keeps it off PvP, counts house and PvP wagers right, and frees it at zero', async () => {
    if (!databaseUrl) return;
    const { randomUUID } = await import('node:crypto');
    const pg = (await import('pg')).default;
    const { addRainLock, assertRainMoneyStays, assertWagerRequirementMet, rainLock, reduceWagerRequirement } = await import('../src/lib/wager-requirements.js');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const user = randomUUID();
    const tag = user.slice(0, 8);
    try {
      await pool.query(
        `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username, role, status, terms_accepted_at)
         VALUES ($1, $2, $3, $4, 'player', 'active', now())`,
        [user, `mc:rain${tag}`, `Rain${tag}`, `rain${tag}`],
      );
      // $100M of the player's own, then a $500M share.
      await pool.query('INSERT INTO user_wallets (user_id, balance_minor) VALUES ($1, 600000000)', [user]);
      await addRainLock(pool, config, user, 500_000_000n);
      assert.deepEqual(await rainLock(pool, user), { heldMinor: 500_000_000n, remainingMinor: 10_000_000_000n });

      // Only the player's own $100M may leave or go against another player.
      await assert.doesNotReject(assertWagerRequirementMet(pool, user, 'withdrawing', 100_000_000n));
      await assert.rejects(assertWagerRequirementMet(pool, user, 'withdrawing', 100_000_001n), { code: 'RAIN_WAGER_REQUIREMENT' });
      await assert.doesNotReject(assertRainMoneyStays(pool, user, 100_000_000n));
      await assert.rejects(assertRainMoneyStays(pool, user, 100_000_001n), (error: any) => {
        assert.equal(error.code, 'RAIN_WAGER_REQUIREMENT');
        assert.equal(error.details.freeMinor, '100000000');
        return true;
      });

      // A $10M house wager counts $10M; a $10M duel at a 3% rake counts $3M.
      await reduceWagerRequirement(pool, user, 10_000_000n);
      assert.equal((await rainLock(pool, user)).remainingMinor, 9_990_000_000n);
      await reduceWagerRequirement(pool, user, 10_000_000n, countedWagerMinor(config, 10_000_000n, 300_000n));
      assert.equal((await rainLock(pool, user)).remainingMinor, 9_987_000_000n);

      // Wagered off: nothing held, everything may leave.
      await reduceWagerRequirement(pool, user, 9_987_000_000n);
      assert.deepEqual(await rainLock(pool, user), { heldMinor: 0n, remainingMinor: 0n });
      await assert.doesNotReject(assertWagerRequirementMet(pool, user, 'withdrawing', 600_000_000n));
      await assert.doesNotReject(assertRainMoneyStays(pool, user, 600_000_000n));

      // A second share starts its own 20x.
      await addRainLock(pool, config, user, 1_000_000n);
      assert.deepEqual(await rainLock(pool, user), { heldMinor: 1_000_000n, remainingMinor: 20_000_000n });
    } finally {
      await pool.end();
    }
  });
});
