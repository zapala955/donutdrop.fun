import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/lib/db.js';
import { claimTagReward, rewardStatus } from '../src/lib/discord-rewards.js';

/* The owner, 2026-11-17: "make it so the discord tag rewards automatically go there and users dont
 * need to do /tag". The tag reward is claimed on the site's Rewards tab; the gateway checks the tag
 * with Discord at the claim, on the rules /tag had. */

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

describe('the tag reward on the Rewards tab', () => {
  it('is claimed on the site: linked, the tag checked with Discord at the claim, paid to the account claiming', async () => {
    const routes = await read('services/api-gateway/src/routes/discord-rewards.ts');
    const at = routes.indexOf("'/v1/discord/tag/claim'");
    assert.ok(at > 0, 'the claim route');
    const route = routes.slice(at, at + 1400);
    assert.match(route, /preHandler: guards\.requireCsrf/);
    assert.match(route, /WHERE id = \$1 AND discord_verified_at IS NOT NULL/);
    assert.match(route, /serverTagState\(config, discordUserId, \{ fresh: true \}\)/);
    // Discord not answering is "try again", never "you are not wearing it".
    assert.match(route, /if \(state === 'unknown'\) \{\s+throw new AppError\(503, 'TAG_UNCHECKED'/);
    assert.match(route, /claimTagReward\(db, config, \{ discordUserId, wearingTag: state === 'wearing', userId \}\)/);
  });

  it('is no longer paid by /tag, which points to the Rewards tab', async () => {
    const [server, rewards] = await Promise.all([
      read('services/community-bot/src/server.ts'),
      read('services/community-bot/src/features/rewards.ts'),
    ]);
    assert.match(server, /case 'tag':\s+return tagMoved\(interaction, config\.siteUrl\);/);
    assert.doesNotMatch(rewards, /api\.claimTag\(/);
    assert.match(rewards, /\/rewards`;/);
  });

  it('is on the redesigned Rewards tab, beside rakeback and the referral share', async () => {
    const page = await read('DONUTDROP FRONTEND/Donut Drop/assets/js/rakeback.js');
    assert.match(page, /api\.post\('\/v1\/discord\/tag\/claim', \{\}\)/);
    assert.match(page, /api\.get\('\/v1\/discord\/rewards'\)/);
    for (const card of ["card('rakeback'", "card('referral'", "card('tag'"]) assert.ok(page.includes(card), card);
    const css = await read('DONUTDROP FRONTEND/Donut Drop/assets/css/luxe-games.css');
    assert.match(css, /Hallmark · component: rewards page/);
    assert.match(css, /body\.lx \.rw__cards \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    const html = await read('DONUTDROP FRONTEND/Donut Drop/index.html');
    assert.match(html, /<div class="rw" id="rewardsRoot"><\/div>/);
  });
});

const databaseUrl = process.env['TEST_DATABASE_URL'];

describe('the tag reward against PostgreSQL', { skip: !databaseUrl }, () => {
  it('pays the first claim, holds the next for 24 hours, gives an alt nothing extra, and says what is due', async () => {
    if (!databaseUrl) return;
    const base = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      APP_ORIGIN: 'http://localhost:3000',
      COOKIE_SECRET: 'cookie-secret-that-is-long-enough-for-tests',
      DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      BOT_CREDENTIALS_JSON: JSON.stringify({
        '10000000-0000-4000-8000-000000000001': { secret: Buffer.alloc(32, 2).toString('base64'), serverHost: 'donutsmp.net', username: 'DonutBot' },
      }),
      AUDIT_LOG_HMAC_KEY: 'audit-secret-that-is-long-enough-for-tests',
      IP_HASH_KEY: 'ip-hash-secret-that-is-long-enough-for-tests',
      LOG_LEVEL: 'silent',
    });
    const config = { ...base, discordRewardsEnabled: true, discordTagRewardMinor: 1_000_000n };
    const db = new Database(config);
    const discordId = `9${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 19);
    const main = randomUUID();
    const alt = randomUUID();
    try {
      for (const [id, name, isMain] of [[main, 'Tm', true], [alt, 'Ta', false]] as const) {
        const tag = id.slice(0, 8);
        await db.query(
          `INSERT INTO users (id, minecraft_identity, minecraft_username, normalized_username, role, status,
                              terms_accepted_at, discord_user_id, discord_verified_at, discord_main)
           VALUES ($1, $2, $3, $4, 'player', 'active', now(), $5, now(), $6)`,
          [id, `mc:tag${tag}`, `${name}${tag}`, `${name.toLowerCase()}${tag}`, discordId, isMain],
        );
        await db.query('INSERT INTO user_wallets (user_id, balance_minor) VALUES ($1, 0)', [id]);
      }

      // Before any claim it is ready (the tag is checked at the claim).
      assert.equal((await rewardStatus(db, config, alt)).tag.ready, true);
      // Tag off: nothing, and why.
      const off = await claimTagReward(db, config, { discordUserId: discordId, wearingTag: false, userId: alt });
      assert.equal(off.paid, false);
      // Tag on, claimed from the alt on the site: the alt is paid.
      const first = await claimTagReward(db, config, { discordUserId: discordId, wearingTag: true, userId: alt });
      assert.equal(first.paid, true);
      const wallet = await db.query<{ balance_minor: string }>('SELECT balance_minor FROM user_wallets WHERE user_id = $1', [alt]);
      assert.equal(wallet.rows[0]?.balance_minor, '1000000');
      // Free money: it carries the requirement.
      const owed = await db.query<{ remaining_minor: string }>('SELECT remaining_minor FROM user_wager_requirements WHERE user_id = $1', [alt]);
      assert.ok(BigInt(owed.rows[0]?.remaining_minor ?? '0') > 0n);
      // Straight after, from either account on that Discord: the 24 hours, with when it opens.
      for (const userId of [alt, main]) {
        const again = await claimTagReward(db, config, { discordUserId: discordId, wearingTag: true, userId });
        assert.equal(again.paid, false);
        if (!again.paid) assert.ok(again.nextAt && Date.parse(again.nextAt) > Date.now() + 23 * 3_600_000);
      }
      const status = await rewardStatus(db, config, main);
      assert.equal(status.tag.ready, false);
      assert.equal(status.tag.days, 1);
      assert.equal(status.tag.totalMinor, '1000000');
      assert.ok(status.tag.nextAt);
      // An account not linked to that Discord is never paid for it.
      const stranger = await claimTagReward(db, config, { discordUserId: '123456789012345678', wearingTag: true, userId: main });
      assert.equal(stranger.paid, false);
    } finally {
      await db.pool.end();
    }
  });
});
