import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { discordAuthorizeUrl } from '../src/lib/discord-oauth.js';
import { runtimeSettingDefinitions } from '../src/lib/runtime-settings.js';

/* One Discord, several site accounts (migration 075): a main account and its alts, all reachable by
 * "Log in with Discord", with the main one the account the community bot acts for. Checked end to
 * end against a real Postgres when it was written; these hold the shape in place. */

const repo = path.resolve(import.meta.dirname, '../../..');
// Line endings normalised: a Windows checkout has CRLF and the patterns below are written with LF.
const read = async (relative: string) =>
  (await readFile(path.join(repo, relative), 'utf8')).replace(/\r\n/g, '\n');
const front = (relative: string) => read(`DONUTDROP FRONTEND/Donut Drop/${relative}`);

const baseEnv = {
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
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'd'.repeat(32),
  DISCORD_LOGIN_REDIRECT_URI: 'http://localhost:3001/v1/auth/discord/callback',
};

describe('several accounts on one Discord: the limit', () => {
  it('defaults to five, is bounded, and is live in the admin panel', () => {
    assert.equal(loadConfig(baseEnv).discordMaxAccounts, 5);
    assert.equal(loadConfig({ ...baseEnv, DISCORD_MAX_ACCOUNTS: '1' }).discordMaxAccounts, 1);
    assert.throws(() => loadConfig({ ...baseEnv, DISCORD_MAX_ACCOUNTS: '0' }));
    assert.throws(() => loadConfig({ ...baseEnv, DISCORD_MAX_ACCOUNTS: '26' }));
    const live = runtimeSettingDefinitions.discordMaxAccounts;
    assert.equal(live.kind, 'integer');
    assert.equal(live.min, 1n);
    assert.equal(live.max, 25n);
  });
});

describe('several accounts on one Discord: migration 075', () => {
  const migration = () => read('packages/db/migrations/075_discord_multi_account.sql');

  it('swaps the unique index for a plain one and allows one main account per Discord', async () => {
    const sql = await migration();
    assert.match(
      sql,
      /DROP INDEX users_discord_user_id_idx;\nCREATE INDEX users_discord_user_id_idx\n  ON users \(discord_user_id\) WHERE discord_user_id IS NOT NULL;/,
    );
    assert.match(sql, /ADD COLUMN discord_main boolean NOT NULL DEFAULT false/);
    assert.match(sql, /CHECK \(NOT discord_main OR discord_user_id IS NOT NULL\)/);
    // Every account linked today was the only one on its Discord, so it is that Discord's main.
    assert.match(sql, /UPDATE users SET discord_main = true WHERE discord_user_id IS NOT NULL;/);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX users_discord_main_idx ON users \(discord_user_id\) WHERE discord_main;/,
    );
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v75\(\) RETURNS boolean/);
  });

  it('keeps every Discord reward once per Discord, which is what makes alts safe', async () => {
    // Unchanged since 056, and the reason migration 075 can drop the unique link at all.
    const rewards = await read('packages/db/migrations/056_dice_discord_rewards.sql');
    assert.match(
      rewards,
      /CREATE UNIQUE INDEX discord_rewards_join_discord_idx\n  ON discord_rewards \(discord_user_id\) WHERE kind = 'join';/,
    );
    assert.match(rewards, /ON discord_rewards \(discord_user_id, reward_day\) WHERE kind = 'tag';/);
    assert.match(rewards, /ON discord_rewards \(invitee_discord_id\) WHERE kind = 'invite';/);
  });

  it('lets a sign-in learn the Discord before the account', async () => {
    const sql = await migration();
    assert.match(
      sql,
      /ALTER TABLE discord_login_states DROP CONSTRAINT discord_login_states_check1;/,
    );
    assert.match(sql, /CHECK \(user_id IS NULL OR discord_user_id IS NOT NULL\)/);
  });
});

describe('several accounts on one Discord: the rules', () => {
  const lib = () => read('services/api-gateway/src/lib/discord-accounts.ts');

  it('serialises every change to one Discord, so two links cannot both take the last slot', async () => {
    const source = await lib();
    assert.match(
      source,
      /pg_advisory_xact_lock\(hashtextextended\('discord-accounts:' \|\| \$1, 0\)\)/,
    );
    const link = source.slice(source.indexOf('export async function linkAccountToDiscord('));
    assert.ok(link.indexOf('lockDiscord(') < link.indexOf('count(*)'), 'locked before counting');
  });

  it('makes the first account main, and promotes another when the main one is unlinked', async () => {
    const source = await lib();
    assert.match(source, /const main = Number\(others\.rows\[0\]\?\.mains \?\? 0\) === 0;/);
    assert.match(
      source,
      /if \(account\.discord_main\) \{[\s\S]{0,200}UPDATE users SET discord_main = true/,
    );
  });

  it("pays the bot's rewards to the main account, and a daily code to whoever redeems it", async () => {
    const rewards = await read('services/api-gateway/src/lib/discord-rewards.ts');
    assert.match(rewards, /const user = await mainAccount\(client, input\.discordUserId\);/);
    // The site's status counts the Discord's rewards too, so an alt is not told a claimed one waits.
    assert.match(
      rewards,
      /FROM discord_rewards WHERE user_id = \$1 OR discord_user_id = \$2 GROUP BY kind/,
    );
    const codes = await read('services/api-gateway/src/lib/daily-codes.ts');
    assert.match(
      codes,
      /WHERE id = \$1 AND discord_user_id = \$2',\n      \[input\.userId, input\.discordUserId\]/,
    );
    assert.doesNotMatch(codes, /FROM users WHERE discord_user_id = \$1'/);
  });

  it('lets the bot list, re-main and unlink only over its signed channel', async () => {
    const bot = await read('services/api-gateway/src/routes/community-bot.ts');
    for (const route of [
      '/internal/v1/community/accounts',
      '/internal/v1/community/accounts/main',
      '/internal/v1/community/accounts/unlink',
    ]) {
      const at = bot.indexOf(`'${route}'`);
      assert.ok(at > 0, route);
      assert.match(
        bot.slice(at, at + 300),
        /verifyCommunityBotSignature\(request, config\);/,
        route,
      );
    }
    // The bot's single-account reads follow the main account, not whichever row comes back first.
    assert.match(
      bot,
      /ORDER BY u\.discord_main DESC, u\.discord_verified_at, u\.id\n          LIMIT 1/,
    );
    assert.match(bot, /const row = await mainAccount\(db, body\.discordUserId\);/);
  });

  it('unlinks from the site only the signed-in account', async () => {
    const site = await read('services/api-gateway/src/routes/discord-rewards.ts');
    assert.match(site, /'\/v1\/discord\/unlink',\n    \{ preHandler: guards\.requireCsrf/);
    assert.match(site, /unlinkAccount\(client, \{ userId \}\)/);
  });
});

describe('several accounts on one Discord: signing in', () => {
  const route = () => read('services/api-gateway/src/routes/discord-login.ts');

  it('asks which account when the Discord carries several, only of the browser that started', async () => {
    const source = await route();
    assert.match(source, /return reply\.redirect\(back\(only \? 'ok' : 'choose'\)\);/);
    const list = source.slice(source.indexOf("'/v1/auth/discord/accounts'"));
    assert.match(list, /preHandler: requireWebsiteOrigin/);
    assert.match(list, /confirmedAttempt\(db, request, false\)/);
    // Administrators are never offered: their sessions need the Minecraft sign-in's MFA.
    assert.match(source, /eligible: rows\.rows\.filter\(\(account\) => !isAdmin\(account\)\)/);
    // A picked id must be one of THIS Discord's accounts.
    assert.match(
      source,
      /WHERE id = \$1 AND discord_user_id = \$2 AND demo_of IS NULL\n            FOR UPDATE/,
    );
  });

  it("skips Discord's Authorize screen for a returning player, and asks again only when told to", async () => {
    const config = loadConfig(baseEnv);
    const quiet = new URL(
      discordAuthorizeUrl(config, config.discordLoginRedirectUri, 'S'.repeat(43), 'none'),
    );
    assert.equal(quiet.searchParams.get('prompt'), 'none');
    const referral = new URL(
      discordAuthorizeUrl(config, config.discordLoginRedirectUri, 'S'.repeat(43)),
    );
    assert.equal(referral.searchParams.get('prompt'), 'consent');
    const source = await route();
    assert.match(source, /body\.consent \? 'consent' : 'none'/);
    assert.match(source, /NEEDS_CONSENT\.has\(error\) \? 'retry' : 'failed'/);
  });

  it('ends the session it replaces when a player switches accounts', async () => {
    const source = await route();
    assert.match(
      source,
      /UPDATE sessions SET revoked_at = now\(\) WHERE token_hash = \$1 AND revoked_at IS NULL/,
    );
  });

  it('picks on the page before bootstrap, and switches through Discord, not from a session', async () => {
    const app = await front('assets/js/app.js');
    assert.match(app, /\} else if \(outcome === 'choose'\) \{\n    await pickDiscordAccount\(\);/);
    assert.match(app, /const user = await completeDiscordLogin\(account\.id\);/);
    assert.match(app, /\$\('#modal'\)\.addEventListener\('close', finish, \{ once: true \}\);/);
    // Switching goes back through Discord: a session proves its account, not the Discord.
    assert.match(
      app,
      /switchButton\.addEventListener\('click', async \(event\) => \{[\s\S]{0,120}await goToDiscord\(\);/,
    );
    const html = await front('index.html');
    assert.match(html, /id="switchAccountBtn" hidden/);
  });
});
