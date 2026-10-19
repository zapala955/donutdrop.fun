import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { randomToken } from '../src/lib/crypto.js';
import {
  discordAuthorizeUrl,
  exchangeDiscordCode,
  OAUTH_STATE_PATTERN,
} from '../src/lib/discord-oauth.js';

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
  DISCORD_REDIRECT_URI: 'http://localhost:3001/v1/referrals/discord/callback',
  DISCORD_LOGIN_REDIRECT_URI: 'http://localhost:3001/v1/auth/discord/callback',
};

describe('log in with Discord: configuration', () => {
  it('pins its own redirect, empty by default, HTTP(S) only', () => {
    assert.equal(
      loadConfig(baseEnv).discordLoginRedirectUri,
      'http://localhost:3001/v1/auth/discord/callback',
    );
    const { DISCORD_LOGIN_REDIRECT_URI: _unset, ...withoutLogin } = baseEnv;
    assert.equal(loadConfig(withoutLogin).discordLoginRedirectUri, '');
    assert.throws(() =>
      loadConfig({ ...baseEnv, DISCORD_LOGIN_REDIRECT_URI: 'javascript:alert(1)' }),
    );
  });

  it('is documented beside the referral redirect', async () => {
    const env = await read('.env.example');
    assert.match(env, /\nDISCORD_LOGIN_REDIRECT_URI=\n/);
    assert.match(env, /\/v1\/auth\/discord\/callback/);
  });
});

describe('log in with Discord: the shared OAuth helper', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('accepts the state it mints (randomToken(32) is base64url, not hex)', () => {
    /* The referral callback used to demand 64 hex characters while its start minted base64url, so
     * every verification came back as a 400 before the state was even looked up. */
    for (let i = 0; i < 50; i += 1) assert.match(randomToken(32), OAUTH_STATE_PATTERN);
    assert.doesNotMatch('a'.repeat(64), OAUTH_STATE_PATTERN);
  });

  it('builds the consent URL for whichever redirect it is given, identify scope only', () => {
    const config = loadConfig(baseEnv);
    const url = new URL(
      discordAuthorizeUrl(config, config.discordLoginRedirectUri, 'S'.repeat(43)),
    );
    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'http://localhost:3001/v1/auth/discord/callback',
    );
    assert.equal(url.searchParams.get('scope'), 'identify');
    assert.equal(url.searchParams.get('client_id'), '123456789012345678');
  });

  it('exchanges the code against the same redirect, and cleans the display name', async () => {
    const config = loadConfig(baseEnv);
    const sent: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, body: String(init?.body ?? '') });
      if (url.endsWith('/oauth2/token')) {
        return Response.json({ access_token: 'tok', token_type: 'Bearer' });
      }
      return Response.json({ id: '111111111111111111', username: '<b>‮evil</b>' });
    }) as typeof fetch;
    const identity = await exchangeDiscordCode(
      config,
      'code-123456',
      config.discordLoginRedirectUri,
    );
    assert.deepEqual(identity, { id: '111111111111111111', username: 'discord user' });
    const form = new URLSearchParams(sent[0]?.body);
    assert.equal(form.get('redirect_uri'), 'http://localhost:3001/v1/auth/discord/callback');
    assert.equal(form.get('code'), 'code-123456');
  });
});

describe('log in with Discord: the routes', () => {
  const route = () => read('services/api-gateway/src/routes/discord-login.ts');

  it('is registered with the other sign-in routes', async () => {
    const app = await read('services/api-gateway/src/app.ts');
    assert.match(app, /await registerDiscordLoginRoutes\(app, db, config\);/);
  });

  it('mints the session only in /complete, from the browser that started the attempt', async () => {
    const source = await route();
    const callback = source.slice(
      source.indexOf("'/v1/auth/discord/callback'"),
      source.indexOf("'/v1/auth/discord/complete'"),
    );
    // The callback works in any browser it is pasted into, so it must never hand out a session.
    assert.doesNotMatch(callback, /setCookie|INSERT INTO sessions/);
    const complete = source.slice(source.indexOf("'/v1/auth/discord/complete'"));
    assert.match(complete, /preHandler: requireWebsiteOrigin/);
    assert.match(complete, /readDiscordLoginCookie\(request, config\)/);
    assert.match(complete, /WHERE browser_token_hash = \$1 FOR UPDATE/);
    assert.match(complete, /INSERT INTO sessions/);
    assert.match(complete, /SET completed_at = now\(\)/);
  });

  it('only finds accounts that already carry the Discord, and never creates one', async () => {
    const source = await route();
    assert.match(source, /WHERE discord_user_id = \$1 AND demo_of IS NULL/);
    assert.match(source, /WHERE id = \$1 AND discord_user_id = \$2 AND demo_of IS NULL/);
    assert.doesNotMatch(source, /INSERT INTO users|SET discord_user_id/);
  });

  it('refuses administrators, whose sessions need the Minecraft sign-in MFA', async () => {
    const source = await route();
    assert.match(
      source,
      /config\.adminMinecraftIds\.has\(account\.minecraft_identity\.toLowerCase\(\)\)/,
    );
    assert.match(source, /DISCORD_LOGIN_ADMIN/);
    assert.doesNotMatch(source, /admin_mfa_verified_at/);
  });

  it('stores only hashes, spends the state once, and is rate limited', async () => {
    const source = await route();
    assert.match(source, /\[sha256Hex\(state\), sha256Hex\(browserToken\), LOGIN_TTL_SECONDS\]/);
    assert.match(source, /WHERE state_hash = \$1 AND callback_at IS NULL AND expires_at > now\(\)/);
    assert.match(
      source,
      /'\/v1\/auth\/discord\/start',\n    \{\n      preHandler: requireWebsiteOrigin,\n      config: \{ rateLimit: \{ max: 10, timeWindow: '10 minutes' \} \}/,
    );
    assert.match(
      source,
      /'\/v1\/auth\/discord\/callback',\n    \{ config: \{ rateLimit: \{ max: 20, timeWindow: '1 minute' \} \} \}/,
    );
  });

  it('keeps the referral verification on its own redirect', async () => {
    const referrals = await read('services/api-gateway/src/routes/referrals.ts');
    assert.match(referrals, /discordAuthorizeUrl\(config, config\.discordRedirectUri, state\)/);
    assert.match(
      referrals,
      /exchangeDiscordCode\(config, query\.code, config\.discordRedirectUri\)/,
    );
    assert.match(referrals, /state: z\.string\(\)\.regex\(OAUTH_STATE_PATTERN\)/);
  });
});

describe('log in with Discord: migration 073', () => {
  const migration = () => read('packages/db/migrations/073_discord_login.sql');

  it('is additive: one table, its grants, the schema marker', async () => {
    const sql = await migration();
    assert.doesNotMatch(sql, /DROP |ALTER TABLE|UPDATE users/i);
    assert.match(
      sql,
      /CREATE TABLE discord_login_states \(\n  state_hash char\(64\) PRIMARY KEY,\n  browser_token_hash char\(64\) NOT NULL UNIQUE,/,
    );
    assert.match(
      sql,
      /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE discord_login_states TO donut_api_runtime;/,
    );
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v73\(\) RETURNS boolean/);
  });
});

describe('log in with Discord: the page', () => {
  it('offers the button only when the server says it is set up', async () => {
    const app = await front('assets/js/app.js');
    assert.match(app, /id="linkDiscordGo"/);
    assert.match(app, /void discordLoginAvailable\(\)\.then\(\(available\) =>/);
    assert.match(app, /location\.assign\(authorizeUrl\)/);
    const store = await front('assets/js/store.js');
    assert.match(store, /api\.get\('\/v1\/auth\/discord'\)/);
    assert.match(store, /api\.post\('\/v1\/auth\/discord\/start', \{\}\)/);
    assert.match(store, /api\.post\('\/v1\/auth\/discord\/complete', \{\}\)/);
  });

  it('collects the session before bootstrap, so bootstrap cannot race it with a 401', async () => {
    const app = await front('assets/js/app.js');
    assert.match(app, /finishDiscordReturn\(\)\.then\(bootstrap\)\.catch\(showApiError\);/);
    assert.doesNotMatch(app, /\nbootstrap\(\)\.catch\(showApiError\);/);
    // Read once, stripped, so a reload does not replay it.
    assert.match(app, /params\.delete\('discord-login'\)/);
  });
});
