import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../src/config.js';
import { communityBotSignaturePayload } from '../src/lib/community-bot-auth.js';
import { hmacHex } from '../src/lib/crypto.js';
import type { Database } from '../src/lib/db.js';
import { registerCommunityBotRoutes } from '../src/routes/community-bot.js';

/* The owner, 2026-11-17: "sync users vip levels with their roles on the site". The bot asks for every
 * linked member's VIP tier and sets the matching role. */

const KEY = 'k'.repeat(48);
const PATH = '/internal/v1/community/vip-roles';
const config = { communityBotEnabled: true, communityBotHmacKey: KEY, vipEnabled: true } as unknown as AppConfig;

const queries: string[] = [];
const db = {
  async query(sql: string) {
    queries.push(sql);
    return {
      rowCount: 4,
      rows: [
        { discord_user_id: '111111111111111111', wagered_minor: null },
        { discord_user_id: '222222222222222222', wagered_minor: '250000000' },
        { discord_user_id: '333333333333333333', wagered_minor: '15000000000' },
        { discord_user_id: '444444444444444444', wagered_minor: '120000000000' },
      ],
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

describe('VIP tiers for the Discord roles', () => {
  it('lists every linked member with their tier', async () => {
    const timestamp = String(Date.now());
    const response = await app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        'x-community-timestamp': timestamp,
        'x-community-signature': hmacHex(KEY, communityBotSignaturePayload('POST', PATH, timestamp, {})),
      },
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      members: [
        { discordUserId: '111111111111111111', tier: 'bronze' },
        { discordUserId: '222222222222222222', tier: 'silver' },
        { discordUserId: '333333333333333333', tier: 'diamond' },
        { discordUserId: '444444444444444444', tier: 'high_roller' },
      ],
    });
  });

  it('takes the account /profile shows: verified, active, not a test twin, the main one first', () => {
    const sql = queries.find((query) => query.includes('DISTINCT ON (u.discord_user_id)'));
    assert.ok(sql);
    assert.match(sql, /u\.discord_verified_at IS NOT NULL/);
    assert.match(sql, /u\.demo_of IS NULL AND u\.status = 'active'/);
    assert.match(sql, /ORDER BY u\.discord_user_id, u\.discord_main DESC, u\.discord_verified_at, u\.id/);
  });

  it('refuses an unsigned request', async () => {
    const response = await app.inject({ method: 'POST', url: PATH, payload: {} });
    assert.equal(response.statusCode, 401);
  });
});
