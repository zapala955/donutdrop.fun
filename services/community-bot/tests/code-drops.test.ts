import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ButtonInteraction, Client } from 'discord.js';
import type { CodeDrop, CodeDropTick, PlatformApi } from '../src/api-client.js';
import { loadConfig } from '../src/config.js';
import {
  DROP_PING_BUTTON,
  buildDropMessage,
  cadence,
  onDropPingButton,
  startCodeDrops,
} from '../src/features/code-drops.js';

/* The owner, 2026-11-11: a code every 2 hours, $10M each for the first 5, 3x wager to withdraw, and
 * a button on the post that gives the role every drop pings. */

const SITE = 'https://donutluxe.com';
const ROLE = '1570041127393042573';
const CHANNEL = '1570039925661892608';
const GUILD = '223456789012345678';
const USER = '323456789012345678';

const drop = (overrides: Partial<CodeDrop> = {}): CodeDrop => ({
  id: '00000000-0000-4000-8000-000000000001',
  code: 'ABCD2345',
  prizeMinor: '10000000',
  maxClaims: 5,
  claims: 0,
  wagerMultiplier: 3,
  slotStart: '2026-11-11T12:00:00.000Z',
  expiresAt: '2026-11-11T14:00:00.000Z',
  channelId: null,
  messageId: null,
  ...overrides,
});
const facts = (given: Partial<CodeDrop> = {}, extra: { over?: boolean; roleId?: string | null } = {}) => ({
  drop: drop(given),
  siteUrl: SITE,
  roleId: extra.roleId === undefined ? ROLE : extra.roleId,
  everyMinutes: 120,
  nextAt: new Date('2026-11-11T14:00:00.000Z'),
  ...(extra.over ? { over: true } : {}),
});
type Json = { title?: string; description?: string; fields?: { name: string; value: string }[]; footer?: { text: string } };
type ButtonJson = { custom_id?: string; url?: string; label: string };
const read = (built: ReturnType<typeof buildDropMessage>) => ({
  content: built.content,
  roles: (built.allowedMentions as { roles?: string[] } | undefined)?.roles ?? [],
  embed: (built.embeds![0] as { toJSON(): Json }).toJSON(),
  buttons: (built.components![0] as { toJSON(): { components: ButtonJson[] } }).toJSON().components,
});

describe('the drop post', () => {
  it('pings the role, shows the code, the prize, who can claim and the wager, with both buttons', () => {
    const post = read(buildDropMessage(facts()));
    assert.equal(post.content, `<@&${ROLE}> a new code just dropped`);
    assert.deepEqual(post.roles, [ROLE], 'only the code-pings role is ever pinged');
    assert.equal(post.embed.title, 'Code drop: $10m');
    assert.match(post.embed.description ?? '', /first \*\*5\*\* to redeem it on the site get \*\*\$10m\*\* each/);
    const field = (name: string) => post.embed.fields?.find((entry) => entry.name === name)?.value ?? '';
    assert.equal(field('Code'), '```ABCD-2345```');
    assert.equal(field('Claims left'), '**5** of 5');
    assert.match(field('How to claim'), /Wager it 3× \(\*\*\$30m\*\*\) before withdrawing it/);
    assert.match(field('How to claim'), /`\/link`/);
    assert.match(post.embed.footer?.text ?? '', /every 2 hours/);
    assert.deepEqual(
      post.buttons.map((button) => [button.label, button.url ?? button.custom_id]),
      [
        ['Redeem on DonutLuxe', `${SITE}/#redeem=ABCD2345`],
        ['Code pings', DROP_PING_BUTTON],
      ],
    );
  });

  it('counts claims down, and once they are gone pings nobody and drops the redeem button', () => {
    assert.equal(
      read(buildDropMessage(facts({ claims: 3 }))).embed.fields?.find((f) => f.name === 'Claims left')?.value,
      '**2** of 5',
    );
    const gone = read(buildDropMessage(facts({ claims: 5 })));
    assert.equal(gone.content, undefined);
    assert.deepEqual(gone.roles, []);
    assert.equal(gone.embed.title, 'Claimed: $10m');
    assert.match(gone.embed.fields?.find((f) => f.name === 'Code')?.value ?? '', /^~~/);
    assert.deepEqual(gone.buttons.map((button) => button.custom_id), [DROP_PING_BUTTON]);
  });

  it('reads as over once the next one is out, and pings nobody without a role', () => {
    assert.equal(read(buildDropMessage(facts({ claims: 2 }, { over: true }))).embed.title, 'Over: $10m');
    const quiet = read(buildDropMessage(facts({}, { roleId: null })));
    assert.equal(quiet.content, undefined);
    assert.deepEqual(quiet.roles, []);
  });

  it('says the cadence in words', () => {
    assert.equal(cadence(120), 'every 2 hours');
    assert.equal(cadence(60), 'every hour');
    assert.equal(cadence(45), 'every 45 minutes');
  });
});

// ── the minute ──────────────────────────────────────────────────────────────

function fakeDiscord() {
  const sent: unknown[] = [];
  const edits: unknown[] = [];
  let failSend = false;
  const message = { id: '900000000000000001', channelId: CHANNEL, edit: async (body: unknown) => edits.push(body) };
  const channel = {
    isTextBased: () => true,
    send: async (body: unknown) => {
      if (failSend) throw new Error('Missing Access');
      sent.push(body);
      return message;
    },
    messages: { fetch: async () => message },
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  return { client, sent, edits, failNext: () => (failSend = true) };
}

function fakeApi(answers: CodeDropTick[]) {
  const reports: unknown[] = [];
  const api = {
    codeDropTick: async () => answers.shift() ?? { enabled: true, drop: null, announce: false, nextAt: '2026-11-11T14:00:00.000Z' },
    codeDropMessage: async (body: unknown) => {
      reports.push(body);
    },
  } as unknown as PlatformApi;
  return { api, reports };
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('the minute', () => {
  it('posts a drop the site says to announce, and reports where the message is', async () => {
    const discord = fakeDiscord();
    const { api, reports } = fakeApi([{ enabled: true, drop: drop(), announce: true, nextAt: '2026-11-11T14:00:00.000Z' }]);
    const errors: unknown[] = [];
    const stop = startCodeDrops(discord.client, api, { siteUrl: SITE, channelId: CHANNEL, roleId: ROLE, onError: (e) => errors.push(e) });
    await settle();
    stop();
    assert.deepEqual(errors, []);
    assert.equal(discord.sent.length, 1);
    assert.deepEqual(reports, [{ dropId: drop().id, channelId: CHANNEL, messageId: '900000000000000001' }]);
  });

  it('hands a drop back when the post fails, so the next minute tries again', async () => {
    const discord = fakeDiscord();
    discord.failNext();
    const { api, reports } = fakeApi([{ enabled: true, drop: drop(), announce: true, nextAt: '2026-11-11T14:00:00.000Z' }]);
    const errors: unknown[] = [];
    const stop = startCodeDrops(discord.client, api, { siteUrl: SITE, channelId: CHANNEL, roleId: ROLE, onError: (e) => errors.push(e) });
    await settle();
    stop();
    assert.deepEqual(reports, [{ dropId: drop().id, failed: true }]);
    assert.equal(errors.length, 1);
  });

  it('keeps claims left true on the post, editing only when they change, and never re-pinging', async () => {
    const discord = fakeDiscord();
    const posted = { channelId: CHANNEL, messageId: '900000000000000001' };
    const { api } = fakeApi([{ enabled: true, drop: drop({ ...posted, claims: 2 }), announce: false, nextAt: '2026-11-11T14:00:00.000Z' }]);
    const stop = startCodeDrops(discord.client, api, { siteUrl: SITE, channelId: CHANNEL, roleId: ROLE, onError: () => undefined });
    await settle();
    stop();
    assert.equal(discord.sent.length, 0);
    assert.equal(discord.edits.length, 1);
    assert.deepEqual((discord.edits[0] as { allowedMentions: unknown }).allowedMentions, { parse: [] });
  });

  it('does nothing while drops are switched off', async () => {
    const discord = fakeDiscord();
    const { api, reports } = fakeApi([{ enabled: false, drop: null, announce: false, nextAt: '2026-11-11T14:00:00.000Z' }]);
    const stop = startCodeDrops(discord.client, api, { siteUrl: SITE, channelId: CHANNEL, roleId: ROLE, onError: () => undefined });
    await settle();
    stop();
    assert.equal(discord.sent.length + discord.edits.length + reports.length, 0);
  });
});

// ── the pings button ────────────────────────────────────────────────────────

function pressed(member: { roles: Set<string>; failing?: boolean } | null) {
  const replies: { title?: string; description?: string }[] = [];
  const roles = member && {
    cache: { has: (id: string) => member.roles.has(id) },
    add: async (id: string) => {
      if (member.failing) throw new Error('Missing Permissions');
      member.roles.add(id);
    },
    remove: async (id: string) => {
      if (member.failing) throw new Error('Missing Permissions');
      member.roles.delete(id);
    },
  };
  const client = {
    guilds: { cache: new Map([[GUILD, { members: { fetch: async () => (member ? { roles } : Promise.reject(new Error('Unknown Member'))) } }]]) },
  } as unknown as Client;
  const interaction = {
    user: { id: USER },
    deferReply: async () => undefined,
    editReply: async (body: { embeds: { toJSON(): { title?: string; description?: string } }[] }) => {
      replies.push(body.embeds[0]!.toJSON());
    },
  } as unknown as ButtonInteraction;
  return { client, interaction, replies };
}

describe('the Code pings button', () => {
  it('gives the role, then takes it back on the next press', async () => {
    const member = { roles: new Set<string>() };
    const first = pressed(member);
    await onDropPingButton(first.client, GUILD, ROLE, first.interaction);
    assert.ok(member.roles.has(ROLE));
    assert.equal(first.replies[0]!.title, 'Code pings on');
    const second = pressed(member);
    await onDropPingButton(second.client, GUILD, ROLE, second.interaction);
    assert.ok(!member.roles.has(ROLE));
    assert.equal(second.replies[0]!.title, 'Code pings off');
  });

  it('turns away somebody who is not in the server, and says so when the role is above the bot', async () => {
    const stranger = pressed(null);
    await onDropPingButton(stranger.client, GUILD, ROLE, stranger.interaction);
    assert.equal(stranger.replies[0]!.title, 'Join the server first');
    const blocked = pressed({ roles: new Set(), failing: true });
    await onDropPingButton(blocked.client, GUILD, ROLE, blocked.interaction);
    assert.equal(blocked.replies[0]!.title, 'I could not change that');
  });
});

// ── wiring ──────────────────────────────────────────────────────────────────

describe('how it is wired', () => {
  const source = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');

  it('answers Code pings (and the old daily button) before the guild check, as a DM has no guild', async () => {
    const server = await source('../src/server.ts');
    const button = server.indexOf('interaction.customId === DROP_PING_BUTTON || interaction.customId === LEGACY_DAILY_BUTTON');
    assert.ok(button > 0);
    assert.ok(button < server.search(/if \(wrongGuild\(interaction\.guildId\)\) return;\s+await onButton\(interaction\);/));
    assert.match(server, /stopCodeDrops = startCodeDrops\(ready, api, \{/);
    assert.doesNotMatch(server, /startDailySender|dailyCommand|dailyInviteCommand/);
    assert.match(server, /case 'daily':\s*case 'daily-invite':\s*return dailyRetired\(interaction, config\.codeDropChannelId\);/);
  });

  it('registers no /daily any more, and the bot cannot claim a code', async () => {
    const commands = await source('../src/commands.ts');
    assert.doesNotMatch(commands, /setName\('daily'\)|setName\('daily-invite'\)|setName\('redeem'\)/);
    const drops = await source('../src/features/code-drops.ts');
    assert.doesNotMatch(drops, /codes\/redeem|wallet|FROM users/);
    assert.doesNotMatch(await source('../src/api-client.ts'), /codes\/redeem/);
  });

  it('posts in the owner’s channel and pings the owner’s role by default', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'drops-'));
    writeFileSync(path.join(dir, 'token'), 'token');
    writeFileSync(path.join(dir, 'db'), 'postgresql://user:pass@localhost:5432/db');
    const config = loadConfig({
      COMMUNITY_BOT_TOKEN_FILE: path.join(dir, 'token'),
      COMMUNITY_APPLICATION_ID: '123456789012345678',
      COMMUNITY_GUILD_ID: GUILD,
      DATABASE_URL_FILE: path.join(dir, 'db'),
    } as NodeJS.ProcessEnv);
    assert.equal(config.codeDropChannelId, CHANNEL);
    assert.equal(config.codeDropRoleId, ROLE);
  });
});
