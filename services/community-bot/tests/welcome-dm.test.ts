import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import type { PlatformApi, Promotions, RewardStatus } from '../src/api-client.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/db.js';
import {
  buildWelcomeDm,
  previewWelcomeDm,
  sendWelcomeDm,
  type WelcomeFacts,
} from '../src/features/welcome-dm.js';

const rewards: RewardStatus = {
  linked: false,
  username: null,
  enabled: true,
  amounts: { joinMinor: '5000000', tagMinor: '1000000' },
  minAccountAgeDays: 7,
  join: null,
  tag: null,
};
const promotions: Promotions = {
  signupBonus: { amountMinor: '2000000' },
  referral: { bonusMinor: '20000000' },
};
const facts = (overrides: Partial<WelcomeFacts> = {}): WelcomeFacts => ({
  guildName: 'DonutLuxe',
  displayName: 'Steve',
  siteUrl: 'https://donutluxe.com',
  rewards,
  promotions,
  ...overrides,
});
const json = (message: ReturnType<typeof buildWelcomeDm>) => ({
  embed: message.embeds[0]!.toJSON(),
  buttons: (message.components[0]!.toJSON().components as { url: string; label: string }[]).map(
    (button) => ({ url: button.url, label: button.label }),
  ),
});

describe('the welcome message', () => {
  it('names the site, the link command, the tag and the invites, with the platform’s own figures', () => {
    const { embed } = json(buildWelcomeDm(facts()));
    const text = JSON.stringify(embed);
    assert.match(embed.title ?? '', /Welcome to DonutLuxe/);
    assert.match(embed.description ?? '', /Steve/);
    assert.match(text, /\[donutluxe\.com\]\(https:\/\/donutluxe\.com\)/);
    assert.match(text, /\*\*\$2m\*\* free/, 'the signup bonus');
    assert.match(text, /\/link/);
    assert.match(text, /Linking pays \*\*\$5m\*\*/);
    assert.match(text, /at least 7 days old/);
    assert.match(text, /Server Tag/);
    assert.match(text, /\/tag/);
    assert.match(text, /\*\*\$1m\*\*/, 'the daily tag reward');
    assert.match(text, /\*\*\$20m per invite\*\*/);
    assert.match(text, /\/invites/);
    assert.match(text, /\/invite-leaderboard/);
  });

  it('carries three link buttons to the site, the Discord page and Invite & Earn', () => {
    const { buttons } = json(buildWelcomeDm(facts({ siteUrl: 'https://donutluxe.com/' })));
    assert.deepEqual(buttons, [
      { url: 'https://donutluxe.com', label: 'Play now' },
      { url: 'https://donutluxe.com/discord', label: 'Discord rewards' },
      { url: 'https://donutluxe.com/referrals', label: 'Invite & earn' },
    ]);
  });

  it('leaves a figure out rather than guessing it when the platform cannot be read', () => {
    const { embed } = json(buildWelcomeDm(facts({ rewards: null, promotions: null })));
    const text = JSON.stringify(embed);
    assert.doesNotMatch(text, /\$\d/, 'no invented amount');
    assert.doesNotMatch(text, /free\./);
    assert.match(text, /earn a bonus per invite/);
    assert.match(text, /\/link/);
    assert.match(text, /\/tag/);
  });

  it('stays inside Discord’s limits however long the names are', () => {
    const { embed } = json(
      buildWelcomeDm(facts({ guildName: 'S'.repeat(500), displayName: 'N'.repeat(500) })),
    );
    assert.ok((embed.title ?? '').length <= 256);
    assert.ok((embed.description ?? '').length <= 4096);
    for (const field of embed.fields ?? []) {
      assert.ok(field.name.length <= 256 && field.value.length <= 1024);
    }
    assert.ok((embed.fields ?? []).length <= 25);
  });
});

function fakeMember(options: { bot?: boolean; sendError?: unknown } = {}) {
  const events: string[] = [];
  const sent: unknown[] = [];
  const member = {
    id: '323456789012345678',
    displayName: 'Steve',
    user: { bot: options.bot ?? false },
    guild: { id: '223456789012345678', name: 'DonutLuxe' },
    send: async (payload: unknown) => {
      events.push('send');
      if (options.sendError) throw options.sendError;
      sent.push(payload);
    },
  } as unknown as GuildMember;
  return { member, events, sent };
}

function fakeDb(claimRows: number, events: string[]) {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const db = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      events.push('claim');
      return { rows: [], rowCount: claimRows };
    },
  } as unknown as Database;
  return { db, statements };
}

function fakeApi(events: string[]) {
  return {
    rewardStatus: async () => {
      events.push('rewards');
      return rewards;
    },
    promotions: async () => {
      events.push('promotions');
      return promotions;
    },
  } as unknown as PlatformApi;
}

const on = { enabled: true, siteUrl: 'https://donutluxe.com' };

describe('sending it', () => {
  it('claims the member first, then looks the figures up, then sends one message', async () => {
    const { member, events, sent } = fakeMember();
    const { db, statements } = fakeDb(1, events);
    const outcome = await sendWelcomeDm(db, fakeApi(events), member, on);
    assert.equal(outcome, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(events[0], 'claim', 'the once-only mark is written before anything is sent');
    assert.equal(events.at(-1), 'send');
    assert.match(statements[0]!.sql, /ON CONFLICT \(guild_id, member_id\)/);
    assert.match(statements[0]!.sql, /WHERE discord_invited_members\.welcomed_at IS NULL/);
    assert.match(statements[0]!.sql, /RETURNING member_id/);
    assert.deepEqual(statements[0]!.values, ['223456789012345678', '323456789012345678']);
  });

  it('sends nothing to a member who has had it (a rejoin) or lost the race to another join', async () => {
    const { member, events, sent } = fakeMember();
    const { db } = fakeDb(0, events);
    assert.equal(await sendWelcomeDm(db, fakeApi(events), member, on), 'skipped');
    assert.equal(sent.length, 0);
    assert.deepEqual(events, ['claim'], 'and does not even look anything up');
  });

  it('sends nothing to a bot, or when it is switched off, and does not touch the database', async () => {
    for (const [member, options] of [
      [fakeMember({ bot: true }).member, on],
      [fakeMember().member, { ...on, enabled: false }],
    ] as const) {
      const events: string[] = [];
      const { db } = fakeDb(1, events);
      assert.equal(await sendWelcomeDm(db, fakeApi(events), member, options), 'skipped');
      assert.deepEqual(events, []);
    }
  });

  it('treats closed DMs as the ordinary case, and still raises anything else', async () => {
    const closed = fakeMember({
      sendError: Object.assign(new Error('Cannot send'), { code: 50007 }),
    });
    assert.equal(
      await sendWelcomeDm(fakeDb(1, closed.events).db, fakeApi(closed.events), closed.member, on),
      'closed',
    );
    const broken = fakeMember({ sendError: Object.assign(new Error('boom'), { code: 500 }) });
    await assert.rejects(
      () => sendWelcomeDm(fakeDb(1, broken.events).db, fakeApi(broken.events), broken.member, on),
      /boom/,
    );
  });

  it('still sends, without figures, when the platform is not configured at all', async () => {
    const { member, events, sent } = fakeMember();
    assert.equal(await sendWelcomeDm(fakeDb(1, events).db, null, member, on), 'sent');
    assert.doesNotMatch(JSON.stringify(sent[0]), /\$\d/);
  });
});

describe('/welcome-preview', () => {
  function interaction(sendError?: unknown) {
    const calls: { kind: string; payload: unknown }[] = [];
    const dm: unknown[] = [];
    const value = {
      guild: { name: 'DonutLuxe' },
      user: {
        id: '123456789012345678',
        displayName: 'Manager',
        send: async (payload: unknown) => {
          if (sendError) throw sendError;
          dm.push(payload);
        },
      },
      deferReply: async (payload: unknown) => void calls.push({ kind: 'defer', payload }),
      editReply: async (payload: unknown) => void calls.push({ kind: 'edit', payload }),
    } as unknown as ChatInputCommandInteraction;
    return { value, calls, dm };
  }

  it('sends the manager their own copy and says so, privately', async () => {
    const { value, calls, dm } = interaction();
    await previewWelcomeDm(null, value, on);
    assert.equal(dm.length, 1);
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['defer', 'edit'],
    );
  });

  it('shows it in the reply instead when the manager’s DMs are closed', async () => {
    const { value, calls, dm } = interaction(Object.assign(new Error('x'), { code: 50007 }));
    await previewWelcomeDm(null, value, on);
    assert.equal(dm.length, 0);
    const edit = calls[1]!.payload as { content: string; embeds: unknown[] };
    assert.match(edit.content, /DMs are closed/);
    assert.equal(edit.embeds.length, 1);
  });
});

describe('how it is wired', () => {
  const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');

  it('goes out last on a join, in its own catch, and the preview needs Manage Server', async () => {
    const server = await read('../src/server.ts');
    const join = server.slice(server.indexOf('client.on(Events.GuildMemberAdd'));
    const welcomed = join.indexOf('onMemberJoin(db, member, origin)');
    const dm = join.indexOf('sendWelcomeDm(db, api, member');
    assert.ok(welcomed > 0 && dm > welcomed, 'after the role and the welcome post');
    assert.match(join.slice(dm, dm + 400), /welcome DM failed/);
    assert.match(server, /case 'welcome-preview':/);
    const commands = await read('../src/commands.ts');
    assert.match(
      commands,
      /setName\('welcome-preview'\)[\s\S]{0,200}setDefaultMemberPermissions\(MANAGE_GUILD\)/,
    );
  });

  it('adds one nullable column and nothing else', async () => {
    const sql = await read('../../../packages/db/migrations/062_discord_welcome_dm.sql');
    assert.doesNotMatch(sql, /DROP |UPDATE |DELETE |ALTER COLUMN/i);
    assert.match(sql, /ALTER TABLE discord_invited_members ADD COLUMN welcomed_at timestamptz/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v62\(\) RETURNS boolean/);
  });
});

describe('its settings', () => {
  function configFor(extra: Record<string, string> = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), 'welcome-config-'));
    const token = path.join(directory, 'token');
    const database = path.join(directory, 'database');
    writeFileSync(token, 'bot-token\n');
    writeFileSync(database, 'postgresql://user:pass@localhost:5432/db\n');
    return loadConfig({
      COMMUNITY_BOT_TOKEN_FILE: token,
      COMMUNITY_APPLICATION_ID: '123456789012345678',
      COMMUNITY_GUILD_ID: '223456789012345678',
      DATABASE_URL_FILE: database,
      ...extra,
    });
  }

  it('is on by default, pointing at the live address with no trailing slash', () => {
    const config = configFor();
    assert.equal(config.welcomeDmEnabled, true);
    assert.equal(config.siteUrl, 'https://donutluxe.com');
  });

  it('can be switched off and pointed elsewhere from the environment', () => {
    const config = configFor({
      WELCOME_DM_ENABLED: 'false',
      COMMUNITY_SITE_URL: 'https://example.test///',
    });
    assert.equal(config.welcomeDmEnabled, false);
    assert.equal(config.siteUrl, 'https://example.test');
  });
});
