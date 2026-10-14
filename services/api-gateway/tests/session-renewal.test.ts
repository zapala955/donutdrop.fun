import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createAuthGuards, csrfCookieOptions, sessionCookieOptions } from '../src/lib/auth.js';
import { sha256 } from '../src/lib/crypto.js';
import type { Database } from '../src/lib/db.js';

/* Players were being shown the Log in button minutes after signing in. Their sessions were never
 * revoked; the browser stopped sending the cookie (SameSite=Strict drops it on every arrival from
 * Discord or a search result), the session ran out at a fixed 24 hours however much they played,
 * and any hiccup on the sign-in check (a 429 from the jackpot bar's polling, a 502 during a
 * restart) was read as "signed out". These pin each of those down. */

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  APP_ORIGIN: 'http://localhost:3000',
  PUBLIC_BASE_URL: 'http://localhost:3001',
  COOKIE_SECRET: 'c'.repeat(32),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  INTERNAL_WEBHOOK_SECRET: 'w'.repeat(32),
  BOT_CREDENTIALS_JSON: JSON.stringify({
    '10000000-0000-4000-8000-000000000099': {
      secret: Buffer.alloc(32, 2).toString('base64'),
      serverHost: 'donutsmp.net',
      username: 'DonutBot',
    },
  }),
  AUDIT_LOG_HMAC_KEY: 'a'.repeat(32),
  IP_HASH_KEY: 'i'.repeat(32),
  LOG_LEVEL: 'silent',
});

const CSRF = 'csrf-token';

/** A player's session row, and a database that renews it with `secondsLeft` to go (0: not due). */
function playerDatabase(secondsLeft: number) {
  const statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const database = {
    query: async (sql: string, values?: readonly unknown[]) => {
      statements.push(values ? { sql, values } : { sql });
      if (sql.includes('FROM sessions s')) {
        const row = {
          session_id: 'session-id',
          user_id: 'user-id',
          minecraft_identity: 'mc:player',
          minecraft_username: 'Player',
          role: 'player',
          status: 'active',
          csrf_hash: sha256(CSRF),
        };
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('UPDATE sessions') && secondsLeft > 0) {
        return { rows: [{ seconds_left: String(secondsLeft) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Database;
  return { database, statements };
}

function request(cookies: Record<string, string>): FastifyRequest {
  return {
    cookies: { du_session: 'signed-cookie', ...cookies },
    headers: { origin: config.appOrigin, 'x-csrf-token': CSRF },
    unsignCookie: () => ({ valid: true, renew: false, value: 'session-token' }),
  } as unknown as FastifyRequest;
}

function replyRecorder() {
  const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  const reply = {
    setCookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.push({ name, value, options });
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, cookies };
}

const renewals = (statements: Array<{ sql: string }>) =>
  statements.filter(({ sql }) => sql.includes('UPDATE sessions')).length;

describe('the session cookies', () => {
  it('are sent on a link from Discord or a search result, not only from the site itself', () => {
    // Strict dropped them on every arrival from another site; the player looked signed out.
    assert.equal(sessionCookieOptions(config).sameSite, 'lax');
    assert.equal(csrfCookieOptions(config).sameSite, 'lax');
    assert.equal(sessionCookieOptions(config).httpOnly, true);
    assert.equal(sessionCookieOptions(config).signed, true);
    // The page reads the CSRF token from its cookie.
    assert.equal(csrfCookieOptions(config).httpOnly, false);
    assert.equal(sessionCookieOptions(config).maxAge, config.sessionTtlHours * 3600);
    assert.equal(csrfCookieOptions(config).maxAge, config.sessionTtlHours * 3600);
  });

  it('no route sets either cookie as Strict any more', async () => {
    for (const file of ['src/routes/auth.ts', 'src/routes/discord-control.ts', 'src/lib/auth.ts']) {
      const source = await readFile(path.resolve(import.meta.dirname, '..', file), 'utf8');
      for (const call of source.matchAll(/setCookie\(\s*(sessionCookieName|csrfCookieName)\(config\)[^;]*;/g)) {
        assert.doesNotMatch(call[0], /strict/i, `${file}: ${call[0]}`);
      }
    }
  });
});

describe('a player session in use', () => {
  it('is renewed, and the browser gets both cookies again for exactly as long', async () => {
    const { database, statements } = playerDatabase(86_000);
    const { reply, cookies } = replyRecorder();
    await createAuthGuards(database, config).authenticate(request({ du_csrf: CSRF }), reply);

    assert.equal(renewals(statements), 1);
    const renewal = statements.find(({ sql }) => sql.includes('UPDATE sessions'))!;
    // Only once less than half the lifetime is left, and never past 30 days from the sign-in.
    assert.match(renewal.sql, /expires_at < now\(\) \+ \(\$2 \* interval '1 hour'\) \/ 2/);
    assert.match(renewal.sql, /LEAST\(now\(\) \+ \(\$2 \* interval '1 hour'\), created_at \+ \(\$3 \* interval '1 day'\)\)/);
    assert.match(renewal.sql, /revoked_at IS NULL/);
    assert.deepEqual(renewal.values, ['session-id', config.sessionTtlHours, 30]);

    assert.deepEqual(cookies.map(({ name }) => name), ['du_session', 'du_csrf']);
    assert.equal(cookies[0]!.value, 'session-token');
    assert.equal(cookies[1]!.value, CSRF);
    for (const cookie of cookies) assert.equal(cookie.options['maxAge'], 86_000);
  });

  it('sets nothing when it is not yet due', async () => {
    const { database, statements } = playerDatabase(0);
    const { reply, cookies } = replyRecorder();
    await createAuthGuards(database, config).authenticate(request({ du_csrf: CSRF }), reply);
    assert.equal(renewals(statements), 1);
    assert.equal(cookies.length, 0);
  });

  it('is not renewed where no cookie could go back with it', async () => {
    /* Moving the row on alone would let the browser's cookie lapse first -- and the check would not
     * come due again until it had. */
    const { database, statements } = playerDatabase(86_000);
    await createAuthGuards(database, config).authenticate(request({ du_csrf: CSRF }));
    assert.equal(renewals(statements), 0);
  });

  it('is not renewed without the CSRF cookie it was issued with', async () => {
    // Otherwise the session would outlive the token every write needs.
    for (const cookies of [{}, { du_csrf: 'someone-elses' }]) {
      const { database, statements } = playerDatabase(86_000);
      const { reply, cookies: set } = replyRecorder();
      await createAuthGuards(database, config).authenticate(request(cookies), reply);
      assert.equal(renewals(statements), 0);
      assert.equal(set.length, 0);
    }
  });

  it('is renewed by the sign-in check and by every write, which both have a reply', async () => {
    const { database, statements } = playerDatabase(86_000);
    const { reply, cookies } = replyRecorder();
    await createAuthGuards(database, config).requireCsrf(request({ du_csrf: CSRF }), reply);
    assert.equal(renewals(statements), 1);
    assert.equal(cookies.length, 2);
    const routes = await readFile(path.resolve(import.meta.dirname, '../src/routes/auth.ts'), 'utf8');
    assert.match(routes, /app\.get\(\s*'\/v1\/auth\/me',\s*\{[^}]*preHandler: guards\.authenticate/);
  });
});

describe('the page, when the sign-in check fails', () => {
  const front = (name: string) =>
    readFile(path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop/assets/js', name), 'utf8');

  it('asks again over a hiccup, and only a 401 means signed out', async () => {
    const store = await front('store.js');
    const whoAmI = store.slice(store.indexOf('async function whoAmI()'), store.indexOf('export async function bootstrap()'));
    assert.match(whoAmI, /const waits = \[1000, 3000, 6000\];/);
    assert.match(whoAmI, /error instanceof ApiError && error\.status === 401\) \|\| attempt >= waits\.length\) throw error;/);
    const bootstrap = store.slice(store.indexOf('export async function bootstrap()'));
    assert.match(bootstrap, /state\.user = await whoAmI\(\);/);
  });

  it('is not starved by the jackpot bar: switched off, it stops asking', async () => {
    const jackpot = await front('vault-jackpot.js');
    assert.match(jackpot, /if \(error\?\.code === 'JACKPOT_DISABLED'\) \{\s*disabled = true;/);
    const poll = jackpot.slice(jackpot.indexOf('async function poll()'));
    assert.match(poll.slice(0, poll.indexOf("api.get('/v1/social/jackpot')")), /if \(disabled\) return;/);
    // Every round anyone settles fires "activity"; the bar asks at most once per gap for them.
    const listener = jackpot.slice(jackpot.indexOf("bus.addEventListener('change'"), jackpot.indexOf('function build()'));
    assert.match(listener, /if \(disabled \|\| /);
    assert.match(listener, /lastAskedAt \+ EVENT_GAP_MS - Date\.now\(\)/);
    assert.doesNotMatch(listener, /void poll\(\);\s*\}\);/, 'an event must not ask straight away');
  });
});
