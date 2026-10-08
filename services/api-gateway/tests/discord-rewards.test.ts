import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { normalizeLinkCode, snowflakeCreatedAt } from '../src/lib/discord-rewards.js';

/*
 * The Discord rewards pay real balance for things a Discord account did, through a bot in a server
 * anybody can join. What keeps that honest is structural -- unique indexes, who mints the link code,
 * what every reward adds to the wager requirement -- so these pin the structure.
 */
const root = path.resolve(import.meta.dirname, '../../..');
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('discord rewards', () => {
  it('reads an account’s age from its snowflake, not from the bot', () => {
    // Discord's own documented example: 175928847299117063 was created 2016-04-30T11:18:25.796Z.
    assert.equal(
      snowflakeCreatedAt('175928847299117063').toISOString(),
      '2016-04-30T11:18:25.796Z',
    );
  });

  it('forgives case, spaces and dashes in a typed code', () => {
    assert.equal(normalizeLinkCode(' ab3d-ef9h '), 'AB3DEF9H');
  });

  it('pays each reward at most once by index, not by a check that can race', async () => {
    const sql = await read('packages/db/migrations/056_dice_discord_rewards.sql');
    assert.match(
      sql,
      /CREATE UNIQUE INDEX discord_rewards_join_user_idx ON discord_rewards \(user_id\) WHERE kind = 'join';/,
    );
    assert.match(sql, /ON discord_rewards \(discord_user_id\) WHERE kind = 'join';/);
    assert.match(sql, /ON discord_rewards \(user_id, reward_day\) WHERE kind = 'tag';/);
    assert.match(sql, /ON discord_rewards \(invitee_discord_id\) WHERE kind = 'invite';/);
    assert.match(sql, /'discord_join_reward', 'discord_tag_reward', 'discord_invite_reward'/);
    // Only the hash of a link code is stored.
    assert.match(sql, /code_hash char\(64\) PRIMARY KEY/);
  });

  it('mints the link code on the site, for a session, and consumes it once', async () => {
    const site = await read('services/api-gateway/src/routes/discord-rewards.ts');
    assert.match(site, /'\/v1\/discord\/link-code',\s+\{ preHandler: guards\.requireCsrf/);
    const lib = await read('services/api-gateway/src/lib/discord-rewards.ts');
    assert.match(
      lib,
      /SET consumed_at = now\(\)\s+WHERE code_hash = \$1 AND consumed_at IS NULL AND expires_at > now\(\)/,
    );
    assert.match(lib, /'DISCORD_ALREADY_LINKED'/);
    // Every reward is withdrawable only once wagered, like the sign-up bonus.
    assert.match(lib, /requirementFor\(amount, config\.signupBonusWagerMultiplier\)/);
    // The invite reward was removed (2026-10-08): linking pays the join reward and nothing else.
    assert.doesNotMatch(lib, /payInviteReward|discord_invite_reward|kind: 'invite'/);
    assert.doesNotMatch(lib, /INSERT INTO discord_rewards[\s\S]{0,120}'invite'/);
  });

  it('lets the community bot reach the rewards only over its signed channel', async () => {
    const bot = await read('services/api-gateway/src/routes/community-bot.ts');
    for (const route of [
      '/internal/v1/community/link',
      '/internal/v1/community/rewards/tag',
      '/internal/v1/community/rewards/status',
    ]) {
      const at = bot.indexOf(`'${route}'`);
      assert.ok(at > 0, route);
      assert.match(
        bot.slice(at, at + 400),
        /verifyCommunityBotSignature\(request, config\);/,
        route,
      );
    }
    // And the whole set disappears when the community bot is switched off.
    assert.match(bot, /if \(!config\.communityBotEnabled\) return;/);
  });
});

describe('lava rain', () => {
  it('settles closed drops on a clock and can open drops by itself', async () => {
    const social = await read('services/api-gateway/src/routes/social.ts');
    assert.match(social, /setInterval\(\(\) => void tick\(\), 15_000\)/);
    assert.match(
      social,
      /await settleClosedRain\(\);\s+if \(await autoDropRain\(\)\) liveEvents\.publish\('rain'\);/,
    );
    // The automatic drop takes the same lock as a manual one, so they cannot open two at once.
    const auto = social.slice(social.indexOf('async function autoDropRain'));
    assert.match(
      auto.slice(0, 1500),
      /pg_advisory_xact_lock\(hashtextextended\('lava-rain-create', 0\)\)/,
    );
    assert.match(auto.slice(0, 1500), /VALUES \(\$1, \$2, NULL,/);
  });
});
