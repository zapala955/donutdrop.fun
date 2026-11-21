import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { CACHEABLE_AVATAR_ROUTES, registerAvatarRoutes } from '../src/routes/avatars.js';
import type { Database } from '../src/lib/db.js';

/*
 * Case Battles show every player's Minecraft head beside their masked name (2026-11-21). The seat
 * payload has no user id, so the page asks for a seat's head by battle code and seat number and
 * the server finds the player: no id and no name reaches the browser, and a bot has no head.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
const PLAYER = '22222222-2222-4222-8222-222222222222';
const MOJANG = 'b'.repeat(32);

function fakeDb() {
  const asked: unknown[][] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      asked.push(params);
      if (sql.includes('battle_players')) {
        // Seat 0 is a person, seat 1 a bot (filtered out by the query itself), seat 2 is empty.
        const [code, seat] = params;
        return { rows: code === 'ABCDEF12' && seat === 0 ? [{ user_id: PLAYER }] : [] };
      }
      return { rows: params[0] === PLAYER ? [{ minecraft_identity: `mc:${MOJANG}` }] : [] };
    },
  } as unknown as Database;
  return { db, asked };
}

function upstream() {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(String(input));
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  return calls;
}

describe('battle seat heads', () => {
  it('serves the head of the player in a seat, asked for by code and seat only', async () => {
    const { db } = fakeDb();
    const server = Fastify();
    await registerAvatarRoutes(server, db);
    const calls = upstream();

    const head = await server.inject({ method: 'GET', url: '/v1/battles/ABCDEF12/seats/0/avatar?s=40&v=q%2A%2A%2A' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-type'], 'image/png');
    assert.deepEqual(head.rawPayload, PNG);
    assert.deepEqual(calls, [`https://mc-heads.net/avatar/${MOJANG}/40`]);
    assert.doesNotMatch(head.body, new RegExp(PLAYER));
  });

  it('has no head for a bot, an empty seat or a battle that does not exist', async () => {
    const { db } = fakeDb();
    const server = Fastify();
    await registerAvatarRoutes(server, db);
    const calls = upstream();
    for (const url of ['/v1/battles/ABCDEF12/seats/1/avatar', '/v1/battles/ABCDEF12/seats/2/avatar', '/v1/battles/ZZZZZZ99/seats/0/avatar']) {
      const answer = await server.inject({ method: 'GET', url });
      assert.equal(answer.statusCode, 404, url);
    }
    assert.deepEqual(calls, []);
  });

  it('refuses a malformed code or seat before touching the database', async () => {
    const { db, asked } = fakeDb();
    const server = Fastify();
    await registerAvatarRoutes(server, db);
    upstream();
    for (const url of ['/v1/battles/abc/seats/0/avatar', '/v1/battles/ABCDEF12/seats/99/avatar', '/v1/battles/ABCDEF12/seats/0/avatar?x=1']) {
      const answer = await server.inject({ method: 'GET', url });
      assert.ok(answer.statusCode >= 400 && answer.statusCode < 500, url);
    }
    assert.equal(asked.length, 0);
  });

  it('only bots are filtered in SQL, and both head routes may be cached', async () => {
    const source = await readFile(path.resolve(import.meta.dirname, '../src/routes/avatars.ts'), 'utf8');
    assert.match(source, /WHERE b\.code = \$1 AND p\.seat = \$2 AND p\.is_bot = false/);
    assert.deepEqual([...CACHEABLE_AVATAR_ROUTES].sort(), ['/v1/avatars/:id', '/v1/battles/:code/seats/:seat/avatar']);
    const app = await readFile(path.resolve(import.meta.dirname, '../src/app.ts'), 'utf8');
    assert.match(app, /if \(!CACHEABLE_AVATAR_ROUTES\.has\(request\.routeOptions\.url \?\? ''\)\) \{/);
  });

  it('the page asks for opponents by seat, never by an id it does not have', async () => {
    const page = await readFile(
      path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop/assets/js/battles.js'),
      'utf8',
    );
    assert.match(page, /\/v1\/battles\/\$\{encodeURIComponent\(code\)\}\/seats\/\$\{seat\.seat\}\/avatar\?s=40&v=/);
    assert.match(page, /seatAvatar\(seat, battle\.code\)/);
    assert.doesNotMatch(page, /seat\.userId|seat\.user_id/);
  });
});
