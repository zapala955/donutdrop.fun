import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.js';
import { communityBotSignaturePayload } from '../src/lib/community-bot-auth.js';
import { hmacHex } from '../src/lib/crypto.js';
import type { Database } from '../src/lib/db.js';
import { maskedName } from '../src/lib/masked-name.js';
import { registerCommunityBotRoutes } from '../src/routes/community-bot.js';

/* The Discord bot's /profile must not undo the site's name masking.
 *
 * Somebody else's profile is posted into a public channel. The card's title was their Minecraft
 * name in full, whoever asked -- the one thing every public surface of the site masks. The route
 * now names the player in full only to the player themselves. These send properly signed requests
 * to the real route, over a database stub that answers with one linked account. */

const KEY = 'k'.repeat(48);
const PATH = '/internal/v1/community/profile';
const ME = '111111111111111111';
const SOMEONE = '222222222222222222';

const config = { communityBotEnabled: true, communityBotHmacKey: KEY } as unknown as AppConfig;

const queries: string[] = [];
const db = {
  async query(sql: string) {
    queries.push(sql);
    return {
      rowCount: 1,
      rows: [{
        minecraft_username: 'AnvilAndy',
        // What the SQL mask produces for this name; the query is checked to ask for it below.
        masked_username: 'A********',
        status: 'active',
        created_at: new Date('2026-09-01T00:00:00Z'),
        discord_verified_at: null,
        wagered_minor: '25000000',
      }],
    };
  },
} as unknown as Database;

let app: FastifyInstance;

before(async () => {
  app = Fastify();
  await registerCommunityBotRoutes(app, db, config);
  await app.ready();
});
after(() => app.close());

async function lookUp(body: Record<string, string>) {
  const timestamp = String(Date.now());
  const signature = hmacHex(KEY, communityBotSignaturePayload('POST', PATH, timestamp, body));
  const response = await app.inject({
    method: 'POST',
    url: PATH,
    headers: { 'x-community-timestamp': timestamp, 'x-community-signature': signature },
    payload: body,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { linked: boolean; username?: string };
}

describe('a profile looked up from Discord', () => {
  it('names the player in full to themselves', async () => {
    const profile = await lookUp({ discordUserId: ME, viewerDiscordUserId: ME });
    assert.equal(profile.username, 'AnvilAndy');
  });

  it('masks the name for anybody else, as the site does', async () => {
    const profile = await lookUp({ discordUserId: ME, viewerDiscordUserId: SOMEONE });
    assert.equal(profile.username, 'A********');
    assert.ok(!JSON.stringify(profile).includes('AnvilAndy'), 'the full name left the route');
  });

  it('masks it when the request does not say who is asking', async () => {
    const profile = await lookUp({ discordUserId: ME });
    assert.equal(profile.username, 'A********');
  });

  it('takes its mask from the one the site\'s public pages use', () => {
    assert.ok(queries.length > 0);
    for (const sql of queries) {
      assert.ok(sql.includes(`${maskedName('u.minecraft_username')} AS masked_username`));
    }
  });
});
