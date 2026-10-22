import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { PlatformApi } from '../src/api-client.js';
import { commandDefinitions } from '../src/commands.js';
import { linkFromServer } from '../src/features/rewards.js';

/* 2026-10-22: a Discord is linked on the site, by authorizing the app; `/link` no longer takes a
 * code. In the server it sends a member who is not linked to the site, and collects the join reward
 * for one who is (being in the server is what that reward is for). */

function interaction(guildId: string | null = '223456789012345678') {
  const calls: { kind: string; payload: unknown }[] = [];
  const value = {
    user: { id: '123456789012345678', username: 'member' },
    guildId,
    reply: async (payload: unknown) => void calls.push({ kind: 'reply', payload }),
    deferReply: async () => void calls.push({ kind: 'defer', payload: null }),
    editReply: async (payload: unknown) => void calls.push({ kind: 'edit', payload }),
  } as unknown as ChatInputCommandInteraction;
  return { interaction: value, calls };
}

describe('/link', () => {
  it('is a plain command: no code to type any more', () => {
    const link = commandDefinitions().find((entry) => entry.name === 'link');
    assert.ok(link, 'the /link command is registered');
    assert.deepEqual(link.options ?? [], []);
  });

  it('sends a member who is not linked to the site, with a button there', async () => {
    const asked: unknown[] = [];
    const api = {
      joinReward: async (body: unknown) => {
        asked.push(body);
        return { linked: false };
      },
    } as unknown as PlatformApi;
    const { interaction: command, calls } = interaction();
    await linkFromServer(api, command);
    assert.deepEqual(asked, [{ discordUserId: '123456789012345678', guildId: '223456789012345678' }]);
    const edit = JSON.stringify(calls.find((call) => call.kind === 'edit')?.payload);
    assert.match(edit, /Link Discord/);
    assert.match(edit, /authorize the app/);
    assert.match(edit, /"url":"https:\/\/donutluxe\.com\/discord"/);
  });

  it('collects the join reward for a member who is linked', async () => {
    const api = {
      joinReward: async () => ({ linked: true, username: 'Steve', paidMinor: '5000000', skipped: null }),
    } as unknown as PlatformApi;
    const { interaction: command, calls } = interaction();
    await linkFromServer(api, command);
    const edit = JSON.stringify(calls.find((call) => call.kind === 'edit')?.payload);
    assert.match(edit, /linked to \*\*Steve\*\*/);
    assert.match(edit, /Join reward/);
  });

  it('says why nothing was paid', async () => {
    const api = {
      joinReward: async () => ({
        linked: true,
        username: 'Steve',
        paidMinor: null,
        skipped: 'The join reward was already paid to this Discord or this account',
      }),
    } as unknown as PlatformApi;
    const { interaction: command, calls } = interaction();
    await linkFromServer(api, command);
    assert.match(JSON.stringify(calls.find((call) => call.kind === 'edit')?.payload), /already paid/);
  });

  it('works only inside the server, and says so when the site is not connected', async () => {
    const outside = interaction(null);
    await linkFromServer({ joinReward: async () => assert.fail('asked') } as unknown as PlatformApi, outside.interaction);
    assert.match(JSON.stringify(outside.calls.at(-1)?.payload), /Server only/);

    const offline = interaction();
    await linkFromServer(null, offline.interaction);
    assert.equal(offline.calls[0]?.kind, 'reply');
    assert.match(JSON.stringify(offline.calls[0]?.payload), /Not available here/);
  });

  it('is routed to the server-side handler, and the code pop-up is gone', async () => {
    const server = (await readFile(new URL('../src/server.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    assert.match(server, /case 'link':\n\s*return linkFromServer\(api, interaction\);/);
    assert.doesNotMatch(server, /submitLinkCode|link:code/);
  });
});
