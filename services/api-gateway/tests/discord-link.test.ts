import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { discordAuthorizeUrl, discordScopes, exchangeDiscordCode } from '../src/lib/discord-oauth.js';

/* 2026-10-22, at the operator's request: "Log in with Discord" is gone, and a Discord is linked to
 * an account by authorizing the app, from the Discord page. Signing in is Minecraft's alone. The
 * join reward, which the old /link code paid inside the server, is paid at the link only when
 * Discord says the player is in the community server, and otherwise by /link in the server. */

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
  DISCORD_REDIRECT_URI: 'http://localhost:3001/v1/discord/link/callback',
};
const GUILD = '987654321098765432';

/** Stands in for Discord: the token, the account, and the member read, recording what was asked. */
function fakeDiscord(member: number | 'throw') {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.endsWith('/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }));
    }
    if (url.endsWith('/users/@me')) {
      return new Response(JSON.stringify({ id: '223456789012345678', username: 'steve‮' }));
    }
    if (url.includes('/guilds/')) {
      if (member === 'throw') throw new Error('network');
      return new Response('{}', { status: member });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = original) };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('linking a Discord: the OAuth round trip', () => {
  it('asks for the account id, and for membership only when the server is known', () => {
    assert.equal(discordScopes(loadConfig(baseEnv)), 'identify');
    const config = loadConfig({ ...baseEnv, COMMUNITY_GUILD_ID: GUILD });
    assert.equal(discordScopes(config), 'identify guilds.members.read');
    const url = new URL(discordAuthorizeUrl(config, config.discordRedirectUri, 'S'.repeat(43)));
    assert.equal(url.searchParams.get('scope'), 'identify guilds.members.read');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3001/v1/discord/link/callback');
    assert.throws(() => loadConfig({ ...baseEnv, COMMUNITY_GUILD_ID: 'not-a-server' }));
  });

  it('reads membership of the server: a member, not a member, or not said', async () => {
    const config = loadConfig({ ...baseEnv, COMMUNITY_GUILD_ID: GUILD });
    for (const [status, member] of [[200, true], [404, false], [429, null], ['throw', null]] as const) {
      const discord = fakeDiscord(status);
      restore = discord.restore;
      const identity = await exchangeDiscordCode(config, 'code-1234', config.discordRedirectUri);
      discord.restore();
      restore = null;
      assert.equal(identity.member, member, String(status));
      assert.equal(identity.id, '223456789012345678');
      // A name that cannot be shown safely is replaced, never stored as it came.
      assert.equal(identity.username, 'discord user');
      assert.ok(discord.asked.some((url) => url.endsWith(`/users/@me/guilds/${GUILD}/member`)));
    }
  });

  it('does not ask about membership when no server is configured', async () => {
    const discord = fakeDiscord(200);
    restore = discord.restore;
    const identity = await exchangeDiscordCode(loadConfig(baseEnv), 'code-1234', baseEnv.DISCORD_REDIRECT_URI);
    assert.equal(identity.member, null);
    assert.ok(!discord.asked.some((url) => url.includes('/guilds/')));
  });
});

describe('linking a Discord: the routes', () => {
  it('starts only for a signed-in session, and only once the app is set up', async () => {
    const routes = await read('services/api-gateway/src/routes/discord-link.ts');
    assert.match(routes, /'\/v1\/discord\/link\/start',\n\s*\{ preHandler: guards\.requireCsrf/);
    assert.match(routes, /'DISCORD_LINK_UNAVAILABLE'/);
    assert.match(routes, /conflict\('DISCORD_ALREADY_LINKED'/);
    // Only the state's hash is stored, and the account linked is the one the state was minted for.
    assert.match(routes, /VALUES \(\$1, \$2, now\(\)/);
    assert.match(routes, /\[sha256Hex\(state\), userId, STATE_TTL_MS\]/);
    assert.match(routes, /RETURNING user_id`,\n\s*\[sha256Hex\(query\.data\.state\)\]/);
  });

  it('answers every callback with a redirect to the Discord page', async () => {
    const routes = await read('services/api-gateway/src/routes/discord-link.ts');
    const callback = routes.slice(routes.indexOf("'/v1/discord/link/callback'"));
    assert.match(routes, /const back = \(outcome: LinkOutcome\) => `\$\{config\.appOrigin\}\/discord\?link=\$\{outcome\}`;/);
    assert.doesNotMatch(callback, /throw new AppError|reply\.code\(/);
    assert.match(callback, /query\.data\.error === 'access_denied' \? 'cancelled' : 'failed'/);
  });

  it('is the only Discord door: no Discord sign-in, no referral verification, no link code', async () => {
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerDiscordLinkRoutes\(app, db, config\);/);
    assert.doesNotMatch(app, /discord-login|registerDiscordLoginRoutes/);
    const referrals = await read('services/api-gateway/src/routes/referrals.ts');
    assert.doesNotMatch(referrals, /\/v1\/referrals\/discord/);
    const config = await read('services/api-gateway/src/config.ts');
    assert.doesNotMatch(config, /DISCORD_LOGIN_REDIRECT_URI/);
  });
});

describe('linking a Discord: the site', () => {
  it('has no "Log in with Discord" and no switching accounts through it', async () => {
    const app = await front('assets/js/app.js');
    assert.doesNotMatch(app, /Log in with Discord|discord-login|completeDiscordLogin/);
    const html = await front('index.html');
    assert.doesNotMatch(html, /switchAccountBtn/);
    const store = await front('assets/js/store.js');
    assert.doesNotMatch(store, /\/v1\/auth\/discord/);
    assert.match(store, /api\.post\('\/v1\/discord\/link\/start', \{\}\)/);
  });

  it('links from the Discord page, says how it went once, and works with the rewards off', async () => {
    const page = await front('assets/js/discord.js');
    assert.match(page, /link\.textContent = 'LINK DISCORD';/);
    assert.match(page, /const outcome = params\.get\('link'\);/);
    assert.match(page, /history\.replaceState\(/);
    // The link is painted whatever the rewards say, after them.
    assert.match(page, /paintRewardList\(\);\n\s*\}\n\s*paintLink\(\);/);
    for (const outcome of ['linked', 'reward', 'join', 'limit', 'taken', 'inactive', 'expired', 'cancelled', 'failed']) {
      assert.match(page, new RegExp(`\\n  ${outcome}: \\{`), outcome);
    }
  });
});
