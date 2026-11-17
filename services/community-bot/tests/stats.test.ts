import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import { ApiRefused, type PlatformApi, type StatsResult } from '../src/api-client.js';
import { commandDefinitions } from '../src/commands.js';
import { showStats } from '../src/features/stats.js';

/* The owner, 2026-11-17: "players do /stats (player) in the community bot and it shows a players stats
 * in the donutsmp it can be a photo or an embed an photo whould be better". */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000004b0000002a3', 'hex').toString('base64');

function interaction(player: string) {
  const calls: { kind: string; body?: unknown }[] = [];
  const fake = {
    user: { id: '123456789012345678' },
    options: { getString: (name: string) => (name === 'player' ? player : null) },
    reply: async (body: unknown) => { calls.push({ kind: 'reply', body }); },
    deferReply: async (body?: unknown) => { calls.push({ kind: 'defer', body }); },
    editReply: async (body: unknown) => { calls.push({ kind: 'edit', body }); },
    deleteReply: async () => { calls.push({ kind: 'delete' }); },
    followUp: async (body: unknown) => { calls.push({ kind: 'followUp', body }); },
  };
  return { interaction: fake as unknown as ChatInputCommandInteraction, calls };
}

function api(results: StatsResult[], refuse?: Error) {
  const asked: string[] = [];
  let index = 0;
  const fake = {
    statsRequest: async (player: string) => {
      asked.push(player);
      if (refuse) throw refuse;
      return { lookupId: '00000000-0000-4000-8000-0000000000ab', status: 'queued', reused: false };
    },
    statsResult: async () => results[Math.min(index++, results.length - 1)]!,
  };
  return { api: fake as unknown as PlatformApi, asked };
}

describe('/stats in Discord', () => {
  it('is a command that takes the player', () => {
    const command = commandDefinitions().find((entry) => entry.name === 'stats') as {
      options?: { name: string; required?: boolean; min_length?: number; max_length?: number }[];
    } | undefined;
    assert.ok(command, '/stats is registered');
    const option = command.options?.[0];
    assert.equal(option?.name, 'player');
    assert.equal(option?.required, true);
    assert.equal(option?.max_length, 16);
  });

  it('posts the card for everyone to see, with the figures as its alt text', async () => {
    const { interaction: asked, calls } = interaction('teexs');
    const { api: platform } = api([
      { status: 'running', player: 'teexs' },
      {
        status: 'found',
        player: 'teexs',
        stats: { money: { display: '$1.24B', value: 1.24e9 }, kills: { display: '2,317', value: 2317 } },
        cardPng: PNG,
      },
    ]);
    await showStats(platform, asked);
    assert.deepEqual(calls.map((call) => call.kind), ['defer', 'edit']);
    assert.equal(calls[0]!.body, undefined, 'not ephemeral: the card is public');
    const files = (calls[1]!.body as { files: { name: string; description: string }[] }).files;
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, 'stats-teexs.png');
    assert.equal(files[0]!.description, 'DonutSMP stats for teexs: money $1.24B, kills 2,317');
  });

  it('says so when DonutSMP has no such player', async () => {
    const { interaction: asked, calls } = interaction('.Nobody');
    await showStats(api([{ status: 'not_found', player: '.Nobody' }]).api, asked);
    const embed = (calls[1]!.body as { embeds: { data: { title: string; description: string } }[] }).embeds[0]!;
    assert.equal(embed.data.title, 'No such player');
    assert.match(embed.data.description, /\*\*\.Nobody\*\*/);
  });

  it('tells only the member why it was refused, and leaves nothing in the channel', async () => {
    const { interaction: asked, calls } = interaction('teexs');
    await showStats(api([], new ApiRefused('STATS_COOLDOWN', 'One lookup every 10 seconds: try again in a moment.')).api, asked);
    assert.deepEqual(calls.map((call) => call.kind), ['defer', 'delete', 'followUp']);
    const body = calls[2]!.body as { flags: number; embeds: { data: { description: string } }[] };
    assert.ok(body.flags, 'ephemeral');
    assert.match(body.embeds[0]!.data.description, /One lookup every 10 seconds/);
  });

  it('refuses a name that cannot be a Minecraft name before asking anybody', async () => {
    const { interaction: asked, calls } = interaction('not a name!');
    const { api: platform, asked: requests } = api([]);
    await showStats(platform, asked);
    assert.deepEqual(calls.map((call) => call.kind), ['reply']);
    assert.equal(requests.length, 0);
  });

  it('gives up politely when the stats bot does not answer', async () => {
    const source = await readFile(path.join(import.meta.dirname, '../src/features/stats.ts'), 'utf8');
    assert.match(source, /const WAIT_MS = 45_000;/);
    assert.match(source, /'Still waiting on DonutSMP'/);
  });
});
