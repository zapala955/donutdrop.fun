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
    /* One Discord carries a main account and up to discordMaxAccounts in all (migration 075): the
     * link goes through the one helper that enforces the limit, and the rewards stay keyed on the
     * Discord, so an alt collects nothing the main account did not. */
    assert.match(lib, /linkAccountToDiscord\(client, config, \{/);
    const accounts = await read('services/api-gateway/src/lib/discord-accounts.ts');
    assert.match(accounts, /if \(count >= config\.discordMaxAccounts\) \{/);
    assert.match(accounts, /'DISCORD_ACCOUNT_LIMIT'/);
    assert.match(accounts, /'ACCOUNT_ALREADY_LINKED'/);
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
      '/internal/v1/community/rewards/tag-watch',
      '/internal/v1/community/rewards/tag-seen',
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

  /* 2026-10-17, at the operator's request: the first tag reward is instant, every one after it
   * needs the tag worn for 24 hours straight. Checked end to end against a real Postgres when it
   * was built; these pin the pieces that make it hold. */
  it('pays the first tag reward at once and the rest only after 24 hours straight', async () => {
    const lib = await read('services/api-gateway/src/lib/discord-rewards.ts');
    assert.match(lib, /export const TAG_STREAK_HOURS = 24;/);
    // The sighting is recorded before anything is decided, so a claim with the tag off ends a streak.
    const claim = lib.slice(lib.indexOf('export async function claimTagReward'));
    assert.ok(claim.indexOf('recordTagSightings(client') < claim.indexOf('INSERT INTO discord_rewards'));
    // Only a previous tag reward, on either side of the link, makes the wait apply.
    assert.match(claim, /WHERE kind = 'tag' AND \(user_id = \$1 OR discord_user_id = \$2\)/);
    assert.match(claim, /if \(lastClaim\) \{\s*const due = tagDueAt\(since, lastClaim\);\s*if \(due > now\)/);
    assert.match(lib, /Math\.max\(wearingSince\.getTime\(\), lastClaim\.getTime\(\)\) \+ TAG_STREAK_MS/);
    // A streak survives a sighting only while the tag is on and the last sighting was recent.
    assert.match(lib, /WHEN EXCLUDED\.wearing_since IS NULL THEN NULL/);
    assert.match(lib, /AND w\.observed_at >= now\(\) - make_interval\(mins => \$3\) THEN w\.wearing_since/);
    const sql = await read('packages/db/migrations/071_discord_tag_wear.sql');
    assert.match(sql, /CREATE TABLE discord_tag_wear \(/);
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE ON TABLE discord_tag_wear TO donut_api_runtime;/);
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
