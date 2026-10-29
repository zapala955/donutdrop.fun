import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = async (relative: string) =>
  (await readFile(path.join(here, '..', relative), 'utf8')).replace(/\r\n/g, '\n');

/* The owner switches a bot off in the admin panel to log into its Minecraft account by hand, then
 * back on. While it is off the bot stays out of the game, is handed no work, and players are not
 * sent to it to deposit: a payment made while the owner is in the account lands in the owner's
 * chat, never the bot's, and nobody would be credited for it. */
describe('switching a bot off for manual play', () => {
  it('is stored on the bot row by an additive migration', async () => {
    const migration = await read('../../packages/db/migrations/083_bot_manual_play.sql');
    assert.match(migration, /ADD COLUMN parked_at timestamptz,/);
    assert.match(migration, /ADD COLUMN parked_by uuid REFERENCES users\(id\);/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v83\(\)/);
    assert.doesNotMatch(migration, /DROP|NOT NULL/);
  });

  it('is an admin action, audited both ways', async () => {
    const source = await read('src/routes/admin.ts');
    const route = source.slice(source.indexOf("'/v1/admin/bots/:id/manual-play'"));
    assert.match(route.slice(0, 200), /preHandler: guards\.requireAdmin/);
    assert.match(route, /SET parked_at = CASE WHEN \$2 THEN coalesce\(parked_at, now\(\)\) ELSE NULL END/);
    assert.match(route, /action: body\.off \? 'bot\.manual_play\.start' : 'bot\.manual_play\.end'/);
    assert.match(source, /const botManualPlaySchema = z\s*\.object\(\{\s*off: z\.boolean\(\),\s*reason: safeText\(3, 256\),/);
    // The console needs to know which bots are off.
    assert.match(source, /b\.observed_balance_display, b\.observed_balance_at, b\.parked_at,/);
  });

  it('tells the bot at its login, and only when it is off', async () => {
    const source = await read('src/routes/minecraft-in.ts');
    const route = source.slice(source.indexOf("'/internal/v1/minecraft/connection-route'"));
    assert.match(route, /parked_at IS NOT NULL AS parked/);
    assert.match(route, /\.\.\.\(row\?\.parked \? \{ parked: true \} : \{\}\),/);
  });

  it('hands the bot no work while it is off', async () => {
    const source = await read('src/routes/minecraft-in.ts');
    assert.match(
      source,
      /AND NOT EXISTS \(SELECT 1 FROM bot_accounts parked\s+WHERE parked\.id = bot_jobs\.bot_id AND parked\.parked_at IS NOT NULL\)/,
    );
  });

  it('sends no player to it to deposit, and never uses it as the vault', async () => {
    const source = await read('src/lib/bots.ts');
    const pick = source.slice(source.indexOf('export async function pickBot('));
    assert.match(pick.slice(0, 1500), /AND parked_at IS NULL/);
    const vault = source.slice(source.indexOf('export async function findVaultBot('));
    assert.match(vault.slice(0, 2500), /AND parked_at IS NULL/);
  });
});
