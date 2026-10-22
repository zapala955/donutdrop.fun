import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import { ApiRefused, type PlatformApi } from '../src/api-client.js';
import { handleAccounts } from '../src/features/accounts.js';
import { commandDefinitions } from '../src/commands.js';

/* `/accounts`: the DonutLuxe accounts on a member's Discord (a main and its alts). Always about the
 * member's own Discord, and always ephemeral. */

const MEMBER = '123456789012345678';

function interaction(sub: string, account?: string) {
  const edits: unknown[] = [];
  const deferred: unknown[] = [];
  const value = {
    user: { id: MEMBER, username: 'member' },
    options: {
      getSubcommand: () => sub,
      getString: () => account ?? null,
    },
    deferReply: async (payload: unknown) => void deferred.push(payload),
    editReply: async (payload: unknown) => void edits.push(payload),
    reply: async (payload: unknown) => void edits.push(payload),
  } as unknown as ChatInputCommandInteraction;
  return { value, edits, deferred };
}

describe('/accounts', () => {
  it('lists the accounts on your Discord, main first, privately', async () => {
    const asked: string[] = [];
    const api = {
      accounts: async (discordUserId: string) => {
        asked.push(discordUserId);
        return {
          max: 5,
          accounts: [
            { username: 'Steve', main: true, active: true, linkedAt: null, lastLoginAt: null },
            { username: 'SteveAlt', main: false, active: true, linkedAt: null, lastLoginAt: null },
          ],
        };
      },
    } as unknown as PlatformApi;
    const { value, edits, deferred } = interaction('list');
    await handleAccounts(api, value);
    assert.deepEqual(asked, [MEMBER]);
    assert.match(JSON.stringify(deferred[0]), /"flags":64/); // MessageFlags.Ephemeral
    const text = JSON.stringify(edits[0]);
    assert.match(text, /\*\*Steve\*\* · ⭐ main/);
    assert.match(text, /\*\*SteveAlt\*\*/);
    assert.match(text, /2 of 5 accounts/);
  });

  it("makes one of your own accounts main, named by the interaction's Discord", async () => {
    const calls: unknown[] = [];
    const api = {
      setMainAccount: async (discordUserId: string, username: string) => {
        calls.push([discordUserId, username]);
        return { username };
      },
    } as unknown as PlatformApi;
    const { value, edits } = interaction('main', ' SteveAlt ');
    await handleAccounts(api, value);
    assert.deepEqual(calls, [[MEMBER, 'SteveAlt']]);
    assert.match(JSON.stringify(edits[0]), /\*\*SteveAlt\*\* is now your main account/);
  });

  it('unlinks one and says which account became main', async () => {
    const api = {
      unlinkAccount: async () => ({ unlinked: 'Steve', newMain: 'SteveAlt' }),
    } as unknown as PlatformApi;
    const { value, edits } = interaction('unlink', 'Steve');
    await handleAccounts(api, value);
    const text = JSON.stringify(edits[0]);
    assert.match(text, /\*\*Steve\*\* is no longer linked/);
    assert.match(text, /\*\*SteveAlt\*\* is your main account now/);
  });

  it("passes the site's refusal on in its own words", async () => {
    const api = {
      setMainAccount: async () => {
        throw new ApiRefused(
          'DISCORD_ACCOUNT_NOT_FOUND',
          'None of the accounts linked to this Discord has that name',
        );
      },
    } as unknown as PlatformApi;
    const { value, edits } = interaction('main', 'Nobody');
    await handleAccounts(api, value);
    assert.match(
      JSON.stringify(edits[0]),
      /None of the accounts linked to this Discord has that name/,
    );
  });

  it('is registered with list, main and unlink, and routed', async () => {
    const command = commandDefinitions().find((entry) => entry.name === 'accounts');
    assert.ok(command, 'the /accounts command is registered');
    const subs = (command.options ?? []).map((option) => (option as { name: string }).name);
    assert.deepEqual(subs, ['list', 'main', 'unlink']);
    const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    assert.match(server, /case 'accounts':\n        return handleAccounts\(api, interaction\);/);
  });
});
