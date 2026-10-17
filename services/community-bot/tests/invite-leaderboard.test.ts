import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

/* 2026-10-17: the invite board is a contest for the community, so the people who run the server
 * are left off it -- the owner, anybody with Administrator, and the bot's configured owners. */
describe('the invite leaderboard', () => {
  it('ranks members only, never the server admins', async () => {
    const source = await readFile(new URL('../src/features/invites.ts', import.meta.url), 'utf8');
    const board = source.slice(source.indexOf('async function adminsAmong'), source.indexOf('/** `/invite-check`'));
    assert.match(board, /const admins = new Set<string>\(ownerIds\);/);
    assert.match(board, /admins\.add\(guild\.ownerId\);/);
    assert.match(board, /member\.permissions\.has\(PermissionFlagsBits\.Administrator\)/);
    // Read a pool, drop the admins, then take ten -- so ten members still show.
    assert.match(board, /LIMIT \$2`,\s*\[interaction\.guildId, LEADERBOARD_POOL\]/);
    assert.match(board, /pool\.rows\.filter\(\(row\) => !admins\.has\(row\.inviter_id\)\)\.slice\(0, 10\)/);
    const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    assert.match(server, /inviteLeaderboard\(db, interaction, config\.ownerIds\)/);
  });
});
