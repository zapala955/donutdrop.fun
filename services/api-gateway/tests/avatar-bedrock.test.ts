import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerAvatarRoutes } from '../src/routes/avatars.js';
import type { Database } from '../src/lib/db.js';

/*
 * Bedrock heads, end to end through the route with the network faked: the gamertag in the
 * identity is looked up at GeyserMC, the skin's texture id is what mc-heads is asked for, and
 * nothing that names the player is sent anywhere else.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TEXTURE = 'a'.repeat(64);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function fakeDb(identities: Record<string, string>): Database {
  return {
    query: async (_sql: string, params: unknown[]) => {
      const identity = identities[String(params[0])];
      return { rows: identity ? [{ minecraft_identity: identity }] : [] };
    },
  } as unknown as Database;
}

async function app(identities: Record<string, string>) {
  const server = Fastify();
  await registerAvatarRoutes(server, fakeDb(identities));
  return server;
}

function network(known: Record<string, number>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const xuid = /xbox\/xuid\/(.+)$/.exec(url);
    if (xuid) {
      const id = known[decodeURIComponent(xuid[1]!)];
      return id ? Response.json({ xuid: id }) : new Response('{}', { status: 404 });
    }
    if (/\/v2\/skin\/\d+$/.test(url)) return Response.json({ texture_id: TEXTURE, is_steve: true });
    if (url.startsWith('https://mc-heads.net/avatar/')) {
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }
    return new Response('', { status: 500 });
  }) as typeof fetch;
  return calls;
}

describe('bedrock avatars', () => {
  it('draws a Bedrock head from the skin GeyserMC knows, without the name reaching mc-heads', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const server = await app({ [id]: 'bedrock:.steve_joe' });
    const calls = network({ 'steve joe': 2535400000000001 });

    const [small, large] = await Promise.all([
      server.inject({ url: `/v1/avatars/${id}?s=22` }),
      server.inject({ url: `/v1/avatars/${id}?s=40` }),
    ]);
    assert.equal(small.statusCode, 200);
    assert.equal(large.statusCode, 200);
    assert.equal(small.headers['content-type'], 'image/png');

    // Floodgate turned a space into an underscore: tried as written, then with the space.
    assert.deepEqual(calls.filter((url) => url.includes('/xbox/xuid/')), [
      'https://api.geysermc.org/v2/xbox/xuid/steve_joe',
      'https://api.geysermc.org/v2/xbox/xuid/steve%20joe',
    ]);
    // Two sizes rendered at once shared one lookup.
    assert.equal(calls.filter((url) => url.includes('/v2/skin/')).length, 1);
    const heads = calls.filter((url) => url.startsWith('https://mc-heads.net/'));
    assert.deepEqual(heads.sort(), [`https://mc-heads.net/avatar/${TEXTURE}/22`, `https://mc-heads.net/avatar/${TEXTURE}/40`]);
    assert.ok(heads.every((url) => !/steve/i.test(url)), 'the gamertag never goes to mc-heads');
    await server.close();
  });

  it('falls back to the initials when GeyserMC does not know the gamertag, and asks again later, not per render', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const server = await app({ [id]: 'bedrock:.nobody_here' });
    const calls = network({});
    const first = await server.inject({ url: `/v1/avatars/${id}` });
    const again = await server.inject({ url: `/v1/avatars/${id}?s=40` });
    assert.equal(first.statusCode, 404);
    assert.equal(again.statusCode, 404);
    // The 22px miss looked it up; the 40px render reused the remembered miss.
    assert.equal(calls.filter((url) => url.includes('/xbox/xuid/')).length, 2);
    assert.ok(!calls.some((url) => url.startsWith('https://mc-heads.net/')));
    await server.close();
  });

  it('still fetches a Java head by its Mojang UUID', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const server = await app({ [id]: `mc:${'b'.repeat(32)}` });
    const calls = network({});
    const res = await server.inject({ url: `/v1/avatars/${id}` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [`https://mc-heads.net/avatar/${'b'.repeat(32)}/22`]);
    await server.close();
  });
});
