import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Client } from 'discord.js';
import type { PlatformApi, RainPost, RainRules, RainTick } from '../src/api-client.js';
import { loadConfig } from '../src/config.js';
import { RAIN_PING_BUTTON, buildRainMessage, claimUrl, rulesText, startRainPosts } from '../src/features/rain-posts.js';

/* The owner, 2026-11-14: every Lava Rain announced in channel 1571305826965131456, pinging role
 * 1571306576311230624, with the server tag and a $25M deposit in the last 3 days to enter. */

const SITE = 'https://donutluxe.com';
const CHANNEL = '1571305826965131456';
const ROLE = '1571306576311230624';
const GUILD = '223456789012345678';

const rules: RainRules = {
  tagRequired: true,
  minDepositMinor: '25000000',
  depositWindowHours: 72,
  minWageredMinor: '10000000',
  wagerWindowMinutes: 60,
};
const rain = (overrides: Partial<RainPost> = {}): RainPost => ({
  id: '00000000-0000-4000-8000-0000000000aa',
  poolMinor: '742000000',
  status: 'open',
  closesAt: '2026-11-14T22:05:00.000Z',
  claimMinutes: 5,
  claimants: 0,
  perClaimMinor: null,
  channelId: null,
  messageId: null,
  ...overrides,
});
const facts = (r: RainPost) => ({ rain: r, rules, siteUrl: SITE, roleId: ROLE });
const embedOf = (built: ReturnType<typeof buildRainMessage>) =>
  (built.embeds![0] as unknown as { toJSON(): { title: string; description: string; fields?: { name: string; value: string }[] } }).toJSON();

describe('the rain post', () => {
  it('pings the rain role with the pool, and only that role, while it falls', () => {
    const built = buildRainMessage(facts(rain()));
    assert.equal(built.content, `<@&${ROLE}> Lava Rain is falling: $742m`);
    assert.deepEqual(built.allowedMentions, { roles: [ROLE] });
    const shown = embedOf(built);
    assert.equal(shown.title, 'Lava Rain: $742m');
    assert.match(shown.description, /next \*\*5 minutes\*\*/);
    const who = shown.fields!.find((field) => field.name === 'Who can claim')!.value;
    assert.match(who, /Wear the \*\*DonutLuxe\*\* server tag/);
    assert.match(who, /\*\*\$25m\*\* deposited in the last 3 days/);
    assert.match(who, /\*\*\$10m\*\* wagered in the last 1 hour/);
    // One claim per connection is kept, but not written in the post (the owner, 2026-11-15).
    assert.doesNotMatch(JSON.stringify(shown), /connection/i);
    // No wager-requirement line: the site says it, as with code drops.
    assert.doesNotMatch(JSON.stringify(shown), /20x|wager req/i);
  });

  it('says what it paid once it pays out, and pings nobody', () => {
    const paid = buildRainMessage(facts(rain({ status: 'settled', claimants: 12, perClaimMinor: '61833333' })));
    assert.equal(paid.content, undefined);
    assert.deepEqual(paid.allowedMentions, { roles: [] });
    assert.equal(embedOf(paid).title, 'Lava Rain paid: $742m');
    assert.match(embedOf(paid).description, /\*\*12\*\* players: \*\*\$61\.8m\*\* each/);
    const none = buildRainMessage(facts(rain({ status: 'expired' })));
    assert.equal(embedOf(none).title, 'Lava Rain over: $742m');
  });

  it('links the claim to the site with the chat open on the rain card, and carries the pings button', () => {
    assert.equal(claimUrl(SITE), 'https://donutluxe.com/?rain=1');
    const row = JSON.stringify(buildRainMessage(facts(rain())).components);
    assert.match(row, /https:\/\/donutluxe\.com\/\?rain=1/);
    assert.ok(row.includes(RAIN_PING_BUTTON));
    assert.equal(rulesText({ ...rules, tagRequired: false, minDepositMinor: '0', minWageredMinor: '0' }), 'Everybody with a site account.');
  });
});

function fakeDiscord() {
  const sent: unknown[] = [];
  const edits: unknown[] = [];
  const message = { id: '900000000000000001', channelId: CHANNEL, edit: async (body: unknown) => edits.push(body) };
  const channel = {
    isTextBased: () => true,
    send: async (body: unknown) => {
      sent.push(body);
      return message;
    },
    messages: { fetch: async () => message },
  };
  const client = { channels: { fetch: async () => channel } } as unknown as Client;
  return { client, sent, edits };
}

function fakeApi(answers: RainTick[]) {
  const reports: unknown[] = [];
  const api = {
    rainTick: async () => answers.shift() ?? { enabled: true, rain: null, announce: false, rules },
    rainMessage: async (body: unknown) => {
      reports.push(body);
    },
  } as unknown as PlatformApi;
  return { api, reports };
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('the ask', () => {
  it('posts a drop the site says to announce in the rain channel, and reports where it is', async () => {
    const discord = fakeDiscord();
    const { api, reports } = fakeApi([{ enabled: true, rain: rain(), announce: true, rules }]);
    const errors: unknown[] = [];
    const stop = startRainPosts(discord.client, api, { siteUrl: SITE, channelId: CHANNEL, roleId: ROLE, onError: (e) => errors.push(e) });
    await settle();
    stop();
    assert.deepEqual(errors, []);
    assert.equal(discord.sent.length, 1);
    assert.deepEqual(reports, [{ rainId: rain().id, channelId: CHANNEL, messageId: '900000000000000001' }]);
  });

  it('edits the post when the drop pays out, without pinging again', async () => {
    const discord = fakeDiscord();
    const posted = { channelId: CHANNEL, messageId: '900000000000000001' };
    const { api } = fakeApi([{ enabled: true, rain: rain({ ...posted, status: 'settled', claimants: 3, perClaimMinor: '247333333' }), announce: false, rules }]);
    const stop = startRainPosts(discord.client, api, { siteUrl: SITE, channelId: CHANNEL, roleId: ROLE, onError: () => undefined });
    await settle();
    stop();
    assert.equal(discord.sent.length, 0);
    assert.equal(discord.edits.length, 1);
    assert.deepEqual((discord.edits[0] as { allowedMentions: unknown }).allowedMentions, { parse: [] });
  });

  it('defaults to the owner\'s rain channel and role', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rain-'));
    writeFileSync(path.join(dir, 'token'), 'token');
    writeFileSync(path.join(dir, 'db'), 'postgresql://x:y@localhost/z');
    const config = loadConfig({
      COMMUNITY_BOT_TOKEN_FILE: path.join(dir, 'token'),
      COMMUNITY_APPLICATION_ID: '123456789012345678',
      COMMUNITY_GUILD_ID: GUILD,
      DATABASE_URL_FILE: path.join(dir, 'db'),
    } as NodeJS.ProcessEnv);
    assert.equal(config.rainChannelId, CHANNEL);
    assert.equal(config.rainRoleId, ROLE);
  });
});
