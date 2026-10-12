import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');
const front = (relative: string) => read(`../../../DONUTDROP FRONTEND/Donut Drop/${relative}`);

describe('the Discord bot settings in the dashboard', () => {
  it('are read by any admin and changed only by an admin with MFA, with a reason, audited', async () => {
    const source = await read('../src/routes/admin-discord.ts');
    assert.match(source, /'\/v1\/admin\/discord-bot',\s*\{ preHandler: requireAdminRead/);
    assert.match(
      source,
      /app\.patch\(\s*'\/v1\/admin\/discord-bot\/:guildId',\s*\{ preHandler: guards\.requireAdmin \}/,
    );
    assert.match(source, /reason: safeText\(3, 256\)/);
    assert.match(source, /action: 'discord_bot\.update'/);
    // Before and after both go in the audit row.
    assert.match(source, /previous: \{/);
    assert.match(source, /next: \{/);
    const app = await read('../src/app.ts');
    assert.match(app, /registerAdminDiscordRoutes\(app, db, config\)/);
  });

  it('accept whole Discord ids only, at most twenty, once each', async () => {
    const source = await read('../src/routes/admin-discord.ts');
    assert.match(source, /const SNOWFLAKE = \/\^\[0-9\]\{5,32\}\$\//);
    assert.match(source, /MAX_TEST_OWNERS = 20/);
    assert.match(source, /new Set\(body\.testOwnerIds\)/);
    const sql = await read('../../../packages/db/migrations/063_discord_bot_dashboard.sql');
    // 20 ids of 32 digits and 19 commas is 659 characters; the column and the constraint agree.
    assert.match(sql, /test_owner_ids varchar\(660\)/);
    assert.match(sql, /\^\(\[0-9\]\{5,32\}\(,\[0-9\]\{5,32\}\)\*\)\?\$/);
  });

  it('add two columns with defaults and nothing else', async () => {
    const sql = await read('../../../packages/db/migrations/063_discord_bot_dashboard.sql');
    assert.doesNotMatch(sql, /DROP |DELETE |TRUNCATE|ALTER COLUMN/i);
    assert.match(sql, /ADD COLUMN welcome_dm_enabled boolean NOT NULL DEFAULT true/);
    assert.match(sql, /ADD COLUMN test_owner_ids varchar\(660\) NOT NULL DEFAULT ''/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v63\(\) RETURNS boolean/);
  });

  it('are shown and edited under Programs in the console', async () => {
    const html = await front('admin/index.html');
    assert.match(html, /id="discordBotTable"/);
    const js = await front('admin/admin.js');
    assert.match(js, /async function loadDiscordBot/);
    assert.match(js, /api\.get\('\/v1\/admin\/discord-bot'\)/);
    assert.match(js, /api\.patch\(`\/v1\/admin\/discord-bot\/\$\{guild\.guildId\}`/);
    assert.match(
      js,
      /programs: async \(\) => \{\s*await loadPrograms\(\);\s*await loadDiscordBot\(\);/,
    );
    // Checked in the console before it is sent, so a typo is said in words, not as a 400.
    assert.match(js, /is not a Discord user id/);
  });

  it('are read by the bot each time, so a save is live without a restart', async () => {
    const welcome = await read('../../community-bot/src/features/welcome-dm.ts');
    assert.match(welcome, /welcome_dm_enabled/);
    assert.match(welcome, /parseOwnerIds\(settings\.test_owner_ids\)/);
    const db = await read('../../community-bot/src/db.ts');
    assert.match(db, /welcome_dm_enabled: boolean/);
    assert.match(db, /test_owner_ids: string/);
  });
});
