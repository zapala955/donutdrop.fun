import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  Collection,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
} from 'discord.js';
import type { PlatformApi, RewardStatus } from '../src/api-client.js';
import type { Database } from '../src/db.js';
import {
  DAILY_ON_BUTTON,
  buildDailyInviteDm,
  dailyPitch,
  onDailyButton,
} from '../src/features/daily-codes.js';
import {
  dailyInviteCommand,
  forgetInviteJobs,
  humanMemberIds,
  inviteJob,
  pendingRecipients,
  runInvite,
  type InviteJob,
  type Pacing,
} from '../src/features/daily-invite.js';
import {
  buildWelcomeDm,
  dailyOffer,
  sendWelcomeDm,
  type WelcomeFacts,
} from '../src/features/welcome-dm.js';

const GUILD = '223456789012345678';
const OWNER = '111111111111111111';
const SITE = 'https://donutluxe.com';
const discordError = (code: number, message = `discord ${code}`) =>
  Object.assign(new Error(message), { code });

// ── an in-memory stand-in for the three tables this feature touches ────────

interface Model {
  enabled: boolean;
  /** The dashboard's list of extra owners, as stored: comma separated. */
  testOwnerIds: string;
  /** invited: id -> outcome */
  invites: Map<string, string>;
  subscribers: Set<string>;
  statements: { sql: string; values: readonly unknown[] }[];
}
function model(initial: Partial<Pick<Model, 'enabled' | 'testOwnerIds'>> = {}): Model {
  return {
    enabled: initial.enabled ?? true,
    testOwnerIds: initial.testOwnerIds ?? '',
    invites: new Map(),
    subscribers: new Set(),
    statements: [],
  };
}
function dbFor(state: Model, onSettingsRead?: () => void): Database {
  return {
    query: async (sql: string, values: readonly unknown[] = []) => {
      state.statements.push({ sql, values });
      if (/FROM discord_guild_settings/.test(sql)) {
        onSettingsRead?.();
        return {
          rows: [
            {
              guild_id: GUILD,
              welcome_dm_enabled: true,
              test_owner_ids: state.testOwnerIds,
              daily_codes_enabled: state.enabled,
              daily_codes_hour: 16,
            },
          ],
          rowCount: 1,
        };
      }
      if (/^\s*SELECT discord_user_id FROM discord_daily_invites/.test(sql)) {
        const ids = [...state.invites.keys(), ...state.subscribers];
        return { rows: ids.map((id) => ({ discord_user_id: id })), rowCount: ids.length };
      }
      if (/INSERT INTO discord_daily_invites \(guild_id, discord_user_id\)\s+SELECT/.test(sql)) {
        const id = String(values[1]);
        if (state.invites.has(id) || state.subscribers.has(id)) return { rows: [], rowCount: 0 };
        state.invites.set(id, 'claimed');
        return { rows: [{ discord_user_id: id }], rowCount: 1 };
      }
      if (/INSERT INTO discord_daily_invites \(guild_id, discord_user_id, outcome\)/.test(sql)) {
        const id = String(values[1]);
        if (!state.invites.has(id)) state.invites.set(id, String(values[2]));
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE discord_daily_invites SET outcome/.test(sql)) {
        state.invites.set(String(values[1]), String(values[2]));
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM discord_daily_invites/.test(sql)) {
        const id = String(values[1]);
        if (state.invites.get(id) === 'claimed') state.invites.delete(id);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM discord_daily_invites\s+WHERE guild_id = \$1 GROUP BY outcome/.test(sql)) {
        const counts = new Map<string, number>();
        for (const outcome of state.invites.values()) {
          counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
        }
        return {
          rows: [...counts].map(([outcome, n]) => ({ outcome, n: String(n) })),
          rowCount: counts.size,
        };
      }
      if (/count\(\*\)::text AS n FROM discord_daily_subscribers/.test(sql)) {
        return { rows: [{ n: String(state.subscribers.size) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Database;
}

interface Sent {
  to: string;
  payload: { content?: string; embeds: { toJSON(): { title?: string; description?: string } }[] };
}
function fakeClient(
  options: { fail?: Record<string, unknown> | undefined; members?: string[] | undefined } = {},
) {
  const sent: Sent[] = [];
  const client = {
    application: { fetch: async () => ({ owner: null }) },
    users: {
      fetch: async (id: string) => ({
        send: async (payload: Sent['payload']) => {
          const failure = options.fail?.[id];
          if (failure) throw failure;
          sent.push({ to: id, payload });
        },
      }),
    },
    guilds: {
      cache: {
        get: () => ({
          members: {
            fetch: async (id: string) => {
              if (options.members && !options.members.includes(id)) throw discordError(10007);
              return { id };
            },
          },
        }),
      },
    },
  } as unknown as Client;
  return { client, sent };
}

const pacing = (log: number[] = []): Pacing => ({
  spacingMs: 1_000,
  sleep: async (ms) => void log.push(ms),
  random: () => 0.5,
  now: () => 1_700_000_000_000,
});

const newJob = (total: number): InviteJob => ({
  guildId: GUILD,
  startedBy: OWNER,
  startedAt: 0,
  total,
  sent: 0,
  closed: 0,
  skipped: 0,
  running: true,
  stopRequested: false,
  endedAt: null,
  endReason: null,
});
const message = buildDailyInviteDm({ siteUrl: SITE, maxPrizeMinor: '100000000' });

// ── the messages ───────────────────────────────────────────────────────────

describe('the invitation', () => {
  const read = (maxPrizeMinor: string | null) => {
    const built = buildDailyInviteDm({ siteUrl: `${SITE}/`, maxPrizeMinor });
    return {
      text: JSON.stringify(built.embeds[0]!.toJSON()),
      buttons: built.components[0]!.toJSON().components as {
        custom_id?: string;
        url?: string;
        label: string;
      }[],
    };
  };

  it('says what it is, what it can pay, and how to start', () => {
    const { text } = read('100000000');
    assert.match(text, /A free code in your DMs, every day/);
    assert.match(text, /nothing up to \*\*\$100m\*\*/);
    assert.match(text, /\/daily on/);
    assert.match(text, /\/redeem/);
    assert.match(text, /\/link/);
    assert.match(text, /wagered/);
    assert.match(text, /\/daily off/);
    assert.match(text, /only get this message once/);
  });

  it('has a button that turns daily codes on, then a link to the site', () => {
    const { buttons } = read('100000000');
    assert.equal(buttons[0]!.custom_id, DAILY_ON_BUTTON);
    assert.equal(buttons[0]!.label, 'Get my daily code');
    assert.equal(buttons[1]!.url, SITE, 'no trailing slash');
  });

  it('quotes no figure it was not given', () => {
    const { text } = read(null);
    assert.match(text, /up to \*\*a big prize\*\*/);
    assert.doesNotMatch(text, /\$\d/);
    assert.match(dailyPitch(null), /a big prize/);
  });
});

describe('the welcome message and daily codes', () => {
  const rewards: RewardStatus = {
    linked: false,
    username: null,
    enabled: true,
    amounts: { joinMinor: '5000000', tagMinor: '1000000' },
    dailyCodes: { enabled: true, maxPrizeMinor: '100000000' },
    minAccountAgeDays: 7,
    join: null,
    tag: null,
  };
  const facts = (overrides: Partial<WelcomeFacts> = {}): WelcomeFacts => ({
    guildName: 'DonutLuxe',
    displayName: 'Steve',
    siteUrl: SITE,
    rewards,
    promotions: null,
    ...overrides,
  });
  const read = (given: WelcomeFacts) => {
    const built = buildWelcomeDm(given);
    return {
      fields: built.embeds[0]!.toJSON().fields ?? [],
      buttons: built.components[0]!.toJSON().components as { custom_id?: string; label: string }[],
    };
  };

  it('offers daily codes with the button first when they are on', () => {
    const { fields, buttons } = read(facts({ dailyCodes: { maxPrizeMinor: '100000000' } }));
    const field = fields.find((entry) => /Daily codes/.test(entry.name));
    assert.ok(field, 'a Daily codes section');
    assert.match(field!.value, /nothing up to \*\*\$100m\*\*/);
    assert.equal(buttons[0]!.custom_id, DAILY_ON_BUTTON);
    assert.deepEqual(
      buttons.slice(1).map((button) => button.label),
      ['Play now', 'Discord rewards', 'Invite & earn'],
    );
  });

  it('is exactly what it was when they are off', () => {
    const { fields, buttons } = read(facts());
    assert.ok(!fields.some((entry) => /Daily codes/.test(entry.name)));
    assert.equal(buttons.length, 3);
    assert.ok(buttons.every((button) => !button.custom_id));
  });

  it('offers them only when the dashboard switch is on and the platform has not said otherwise', () => {
    assert.deepEqual(dailyOffer({ daily_codes_enabled: true }, rewards), {
      maxPrizeMinor: '100000000',
    });
    assert.equal(dailyOffer({ daily_codes_enabled: false }, rewards), null);
    assert.equal(
      dailyOffer(
        { daily_codes_enabled: true },
        { ...rewards, dailyCodes: { enabled: false, maxPrizeMinor: '1' } },
      ),
      null,
    );
    assert.deepEqual(dailyOffer({ daily_codes_enabled: true }, null), { maxPrizeMinor: null });
    const { dailyCodes: _omitted, ...older } = rewards; // a gateway too old to report daily codes
    assert.deepEqual(dailyOffer({ daily_codes_enabled: true }, older), { maxPrizeMinor: null });
  });

  describe('when sent to a new member', () => {
    const memberFor = (error?: unknown) => {
      const sent: unknown[] = [];
      const member = {
        id: '323456789012345678',
        displayName: 'Steve',
        user: { bot: false },
        guild: { id: GUILD, name: 'DonutLuxe' },
        send: async (payload: unknown) => {
          if (error) throw error;
          sent.push(payload);
        },
      } as unknown as GuildMember;
      return { member, sent };
    };
    const api = {
      rewardStatus: async () => rewards,
      promotions: async () => null,
    } as unknown as PlatformApi;
    const welcomeDb = (state: Model) => {
      const base = dbFor(state);
      return {
        query: async (sql: string, values: readonly unknown[] = []) =>
          /INSERT INTO discord_invited_members/.test(sql)
            ? { rows: [{ member_id: '1' }], rowCount: 1 }
            : base.query(sql, values),
      } as unknown as Database;
    };
    const on = { enabled: true, siteUrl: SITE };

    it('records that they were offered daily codes, so a broadcast skips them', async () => {
      const state = model();
      const { member, sent } = memberFor();
      assert.equal(await sendWelcomeDm(welcomeDb(state), api, member, on), 'sent');
      assert.equal(sent.length, 1);
      assert.equal(state.invites.get('323456789012345678'), 'sent');
    });

    it('records a closed DM too, since there is nobody to broadcast to', async () => {
      const state = model();
      const { member } = memberFor(discordError(50007));
      assert.equal(await sendWelcomeDm(welcomeDb(state), api, member, on), 'closed');
      assert.equal(state.invites.get('323456789012345678'), 'closed');
    });

    it('records nothing while daily codes are off', async () => {
      const state = model({ enabled: false });
      const { member, sent } = memberFor();
      assert.equal(await sendWelcomeDm(welcomeDb(state), api, member, on), 'sent');
      assert.equal(sent.length, 1);
      assert.equal(state.invites.size, 0);
    });
  });
});

// ── who is left to invite ──────────────────────────────────────────────────

describe('who is left to invite', () => {
  it('leaves out everybody already invited and everybody who already has daily codes', async () => {
    const state = model();
    state.invites.set('2', 'sent');
    state.invites.set('3', 'closed');
    state.subscribers.add('4');
    assert.deepEqual(await pendingRecipients(dbFor(state), GUILD, ['1', '2', '3', '4', '5']), [
      '1',
      '5',
    ]);
  });

  it('reads every page of members and skips bots', async () => {
    const humans = Array.from({ length: 2_300 }, (_, index) => String(100000 + index));
    const everyone = humans.flatMap((id, index) => (index % 10 === 0 ? [id, `bot${id}`] : [id]));
    const calls: (string | undefined)[] = [];
    const guild = {
      members: {
        list: async ({ limit, after }: { limit: number; after?: string }) => {
          calls.push(after);
          const start = after ? everyone.indexOf(after) + 1 : 0;
          return new Collection(
            everyone
              .slice(start, start + limit)
              .map((id) => [id, { id, user: { bot: id.startsWith('bot') } }]),
          );
        },
      },
    } as unknown as Guild;
    const ids = await humanMemberIds(guild);
    assert.equal(ids.length, 2_300);
    assert.ok(ids.every((id) => !id.startsWith('bot')));
    assert.equal(calls.length, 3, 'three pages of up to a thousand');
  });
});

// ── the broadcast ──────────────────────────────────────────────────────────

describe('sending the invitations', () => {
  it('sends one message to each member, in order, and records each', async () => {
    const state = model();
    const { client, sent } = fakeClient();
    const job = newJob(3);
    await runInvite(dbFor(state), client, job, ['1', '2', '3'], message, pacing());
    assert.deepEqual(
      sent.map((entry) => entry.to),
      ['1', '2', '3'],
    );
    assert.deepEqual(
      [...state.invites],
      [
        ['1', 'sent'],
        ['2', 'sent'],
        ['3', 'sent'],
      ],
    );
    assert.equal(job.sent, 3);
    assert.equal(job.endReason, 'Finished');
    assert.equal(job.running, false);
    assert.notEqual(job.endedAt, null);
  });

  it('claims each member before sending to them', async () => {
    const state = model();
    const order: string[] = [];
    const inner = dbFor(state);
    const db = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (/INSERT INTO discord_daily_invites \(guild_id, discord_user_id\)\s+SELECT/.test(sql))
          order.push('claim');
        return inner.query(sql, values as never);
      },
    } as unknown as Database;
    const client = {
      users: { fetch: async () => ({ send: async () => void order.push('send') }) },
    } as unknown as Client;
    await runInvite(db, client, newJob(1), ['1'], message, pacing());
    assert.deepEqual(order, ['claim', 'send']);
  });

  it('never sends a second time to anybody who has been invited, however often it is run', async () => {
    const state = model();
    const { client, sent } = fakeClient();
    await runInvite(dbFor(state), client, newJob(2), ['1', '2'], message, pacing());
    const again = newJob(2);
    await runInvite(dbFor(state), client, again, ['1', '2'], message, pacing());
    assert.equal(sent.length, 2);
    assert.equal(again.skipped, 2);
    assert.equal(again.sent, 0);
  });

  it('skips somebody who turned daily codes on after the list was made', async () => {
    const state = model();
    state.subscribers.add('2');
    const { client, sent } = fakeClient();
    const job = newJob(2);
    await runInvite(dbFor(state), client, job, ['1', '2'], message, pacing());
    assert.deepEqual(
      sent.map((entry) => entry.to),
      ['1'],
    );
    assert.equal(job.skipped, 1);
  });

  it('counts a closed DM and carries on', async () => {
    const state = model();
    const { client, sent } = fakeClient({ fail: { '2': discordError(50007) } });
    const job = newJob(3);
    await runInvite(dbFor(state), client, job, ['1', '2', '3'], message, pacing());
    assert.deepEqual(
      sent.map((entry) => entry.to),
      ['1', '3'],
    );
    assert.equal(job.closed, 1);
    assert.equal(state.invites.get('2'), 'closed');
    assert.equal(job.endReason, 'Finished');
  });

  it('stops at anything that is not an ordinary closed DM, and gives that member back', async () => {
    const state = model();
    const { client, sent } = fakeClient({
      fail: { '3': discordError(40003, 'You are opening direct messages too fast.') },
    });
    const job = newJob(5);
    await runInvite(dbFor(state), client, job, ['1', '2', '3', '4', '5'], message, pacing());
    assert.deepEqual(
      sent.map((entry) => entry.to),
      ['1', '2'],
    );
    assert.match(job.endReason ?? '', /opening direct messages too fast/);
    assert.match(job.endReason ?? '', /Nothing was lost/);
    assert.equal(state.invites.has('3'), false, 'put back, so a later run reaches them');
    assert.equal(state.invites.has('4'), false, 'and nobody after them was touched');
    assert.equal(job.running, false);
  });

  it('stops before the next message when an owner asks', async () => {
    const state = model();
    const { client, sent } = fakeClient();
    const job = newJob(4);
    const sleeps: number[] = [];
    await runInvite(dbFor(state), client, job, ['1', '2', '3', '4'], message, {
      ...pacing(sleeps),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) job.stopRequested = true;
      },
    });
    assert.deepEqual(
      sent.map((entry) => entry.to),
      ['1', '2'],
    );
    assert.match(job.endReason ?? '', /Stopped by an owner/);
  });

  it('stops when daily codes are switched off in the dashboard, checked before every send', async () => {
    const state = model();
    const { client, sent } = fakeClient();
    let reads = 0;
    const db = dbFor(state, () => {
      reads += 1;
      if (reads === 3) state.enabled = false;
    });
    const job = newJob(5);
    await runInvite(db, client, job, ['1', '2', '3', '4', '5'], message, pacing());
    assert.deepEqual(
      sent.map((entry) => entry.to),
      ['1', '2'],
    );
    assert.match(job.endReason ?? '', /switched off in the dashboard/);
  });

  it('waits between messages, never sending in a burst', async () => {
    const waits: number[] = [];
    await runInvite(
      dbFor(model()),
      fakeClient().client,
      newJob(3),
      ['1', '2', '3'],
      message,
      pacing(waits),
    );
    assert.deepEqual(waits, [1_500, 1_500, 1_500], 'the spacing plus jitter, after each send');
  });

  it('reports a failure of its own as the reason, instead of throwing', async () => {
    const db = {
      query: async () => {
        throw new Error('database is down');
      },
    } as unknown as Database;
    const job = newJob(1);
    await runInvite(db, fakeClient().client, job, ['1'], message, pacing());
    assert.match(job.endReason ?? '', /database is down/);
    assert.equal(job.running, false);
  });
});

// ── the command ────────────────────────────────────────────────────────────

describe('/daily-invite', () => {
  const MEMBER = '444444444444444444';

  function run(
    sub: string,
    options: {
      userId?: string;
      members?: { id: string; bot?: boolean }[];
      state?: Model;
      count?: number | null;
      fail?: Record<string, unknown>;
      extra?: string[];
    } = {},
  ) {
    const state = options.state ?? model();
    const replies: { title?: string; description?: string; fields?: { value: string }[] }[] = [];
    const roster = options.members ?? [
      { id: '1' },
      { id: '2' },
      { id: '3' },
      { id: '4', bot: true },
    ];
    const fake = fakeClient({ fail: options.fail });
    const interaction = {
      guild: {
        id: GUILD,
        ownerId: OWNER,
        members: {
          list: async () =>
            new Collection(
              roster.map((entry) => [
                entry.id,
                { id: entry.id, user: { bot: entry.bot ?? false } },
              ]),
            ),
        },
      },
      user: { id: options.userId ?? OWNER },
      client: fake.client,
      options: {
        getSubcommand: () => sub,
        getInteger: () => options.count ?? null,
      },
      deferReply: async () => undefined,
      editReply: async (payload: { embeds: { toJSON(): (typeof replies)[number] }[] }) => {
        replies.push(payload.embeds[0]!.toJSON());
      },
    } as unknown as ChatInputCommandInteraction;
    let finished: (job: InviteJob) => void = () => undefined;
    const done = new Promise<InviteJob>((resolve) => (finished = resolve));
    const api = {
      rewardStatus: async () => ({ dailyCodes: { enabled: true, maxPrizeMinor: '100000000' } }),
    } as unknown as PlatformApi;
    const result = dailyInviteCommand(dbFor(state), api, interaction, {
      siteUrl: SITE,
      extraOwnerIds: options.extra ?? [],
      pacing: pacing(),
      onFinished: async (job) => finished(job),
    });
    return { result, replies, sent: fake.sent, state, done };
  }

  it('is for owners only, and sends nothing to anybody else', async () => {
    forgetInviteJobs();
    for (const sub of ['preview', 'send', 'status', 'stop']) {
      const { result, replies, sent, state } = run(sub, { userId: MEMBER });
      await result;
      assert.equal(replies.at(-1)!.title, 'Owners only', sub);
      assert.equal(sent.length, 0, sub);
      assert.equal(state.invites.size, 0, sub);
    }
  });

  it('preview: DMs the owners, once each, and nobody else, and records nobody', async () => {
    forgetInviteJobs();
    const ENV_OWNER = '333333333333333333';
    const DASHBOARD_OWNER = '1514304386589790398';
    const { result, replies, sent, state } = run('preview', {
      extra: [ENV_OWNER, OWNER],
      state: model({ testOwnerIds: `${DASHBOARD_OWNER},${ENV_OWNER}` }),
      members: [{ id: MEMBER }, { id: '1' }, { id: '2' }],
    });
    await result;
    assert.deepEqual(
      sent.map((entry) => entry.to),
      [OWNER, ENV_OWNER, DASHBOARD_OWNER],
      'the server owner, the environment list, the dashboard list: once each',
    );
    assert.match(sent[0]!.payload.content ?? '', /Preview/);
    assert.match(JSON.stringify(sent[0]!.payload.embeds[0]!.toJSON()), /\$100m/);
    assert.equal(replies.at(-1)!.title, 'Preview sent');
    assert.match(replies.at(-1)!.description ?? '', new RegExp(`<@${DASHBOARD_OWNER}>`));
    assert.equal(state.invites.size, 0, 'a preview never counts as the one invitation');
  });

  it('preview: still reaches the others when one owner has closed DMs, and says who', async () => {
    forgetInviteJobs();
    const ENV_OWNER = '333333333333333333';
    const { result, replies, sent } = run('preview', {
      extra: [ENV_OWNER],
      fail: { [OWNER]: discordError(50007) },
    });
    await result;
    assert.deepEqual(
      sent.map((entry) => entry.to),
      [ENV_OWNER],
    );
    assert.equal(replies.at(-1)!.title, 'Preview sent');
    assert.match(replies.at(-1)!.description ?? '', new RegExp(`closed: <@${OWNER}>`));
  });

  it('preview: says so, as a failure, when no owner can be reached', async () => {
    forgetInviteJobs();
    const { result, replies } = run('preview', { fail: { [OWNER]: discordError(50007) } });
    await result;
    assert.equal(replies.at(-1)!.title, 'Preview not sent');
    assert.match(replies.at(-1)!.description ?? '', /Nobody could be reached/);
  });

  it('preview: raises anything that is not a closed DM', async () => {
    forgetInviteJobs();
    const { result } = run('preview', { fail: { [OWNER]: discordError(500, 'boom') } });
    await assert.rejects(() => result, /boom/);
  });

  it('send: refuses, and sends nothing, until daily codes are switched on in the dashboard', async () => {
    forgetInviteJobs();
    const { result, replies, sent } = run('send', { state: model({ enabled: false }) });
    await result;
    assert.equal(replies.at(-1)!.title, 'Switch daily codes on first');
    assert.equal(sent.length, 0);
    assert.equal(inviteJob(GUILD), undefined);
  });

  it('send: invites every human member once, never a bot, and tells the starter when it ends', async () => {
    forgetInviteJobs();
    const { result, replies, sent, state, done } = run('send');
    await result;
    assert.equal(replies.at(-1)!.title, 'Sending');
    assert.match(replies.at(-1)!.description ?? '', /Inviting \*\*3\*\* members/);
    const job = await done;
    const members = sent.filter((entry) => entry.to !== OWNER).map((entry) => entry.to);
    assert.deepEqual(members, ['1', '2', '3']);
    assert.equal(state.invites.has('4'), false, 'the bot');
    assert.equal(job.sent, 3);
    assert.equal(job.endReason, 'Finished');
  });

  it('send: a second run has nobody left', async () => {
    forgetInviteJobs();
    const state = model();
    const first = run('send', { state });
    await first.result;
    await first.done;
    const second = run('send', { state });
    await second.result;
    assert.equal(second.replies.at(-1)!.title, 'Nobody left');
    assert.equal(second.sent.length, 0);
  });

  it('send: count limits one run, and the next run carries on from there', async () => {
    forgetInviteJobs();
    const state = model();
    const first = run('send', { state, count: 2 });
    await first.result;
    assert.match(first.replies.at(-1)!.description ?? '', /\*\*2\*\* members \(of 3 still to do\)/);
    await first.done;
    assert.deepEqual([...state.invites.keys()], ['1', '2']);
    const second = run('send', { state });
    await second.result;
    await second.done;
    assert.deepEqual([...state.invites.keys()], ['1', '2', '3']);
  });

  it('send: will not start a second run while one is going', async () => {
    forgetInviteJobs();
    const gate = run('send');
    await gate.result;
    // The first run is still registered as running until its promise settles; force the state.
    const job = inviteJob(GUILD)!;
    await gate.done;
    job.running = true;
    const again = run('send');
    await again.result;
    assert.match(JSON.stringify(again.replies.at(-1)), /Daily invites: sending/);
    assert.equal(again.sent.length, 0);
    job.running = false;
  });

  it('status: shows what has been done, ever, and who has daily codes', async () => {
    forgetInviteJobs();
    const state = model();
    state.invites.set('1', 'sent');
    state.invites.set('2', 'sent');
    state.invites.set('3', 'closed');
    state.subscribers.add('9');
    const { result, replies } = run('status', { state });
    await result;
    const text = JSON.stringify(replies.at(-1));
    assert.match(text, /\*\*2\*\* reached, \*\*1\*\* with closed DMs/);
    assert.match(text, /for \*\*1\*\* members/);
  });

  it('stop: says there is nothing to stop when nothing runs, and ends a run that is going', async () => {
    forgetInviteJobs();
    const idle = run('stop');
    await idle.result;
    assert.equal(idle.replies.at(-1)!.title, 'Nothing to stop');

    const gate = run('send');
    await gate.result;
    await gate.done;
    const job = inviteJob(GUILD)!;
    job.running = true;
    const stopping = run('stop');
    await stopping.result;
    assert.equal(stopping.replies.at(-1)!.title, 'Stopping');
    assert.equal(job.stopRequested, true);
    job.running = false;
  });
});

// ── the button ─────────────────────────────────────────────────────────────

describe('the Get my daily code button', () => {
  function click(options: { members?: string[]; enabled?: boolean }) {
    const state = model({ enabled: options.enabled ?? true });
    const replies: { title?: string; description?: string }[] = [];
    const interaction = {
      user: { id: '323456789012345678' },
      deferReply: async () => undefined,
      editReply: async (payload: {
        embeds: { toJSON(): { title?: string; description?: string } }[];
      }) => {
        replies.push(payload.embeds[0]!.toJSON());
      },
    } as unknown as ButtonInteraction;
    const fake = fakeClient({ members: options.members });
    return { state, replies, interaction, ...fake };
  }

  it('turns codes on for a member, in a DM with no guild, and sends the first code', async () => {
    const { state, replies, interaction, client, sent } = click({
      members: ['323456789012345678'],
    });
    const db = {
      query: async (sql: string, values: readonly unknown[] = []) => {
        if (/INSERT INTO discord_daily_subscribers/.test(sql))
          return { rows: [{ inserted: true }], rowCount: 1 };
        if (/UPDATE discord_daily_subscribers SET last_sent_on/.test(sql))
          return { rows: [{ discord_user_id: '1' }], rowCount: 1 };
        if (/INSERT INTO discord_daily_codes/.test(sql))
          return { rows: [{ code: 'ABCD2345' }], rowCount: 1 };
        return dbFor(state).query(sql, values as never);
      },
    } as unknown as Database;
    await onDailyButton(db, client, null, SITE, GUILD, interaction);
    assert.equal(replies.at(-1)!.title, 'Daily codes on');
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0]!.payload.embeds[0]!.toJSON()), /ABCD-2345/);
  });

  it('turns it down, kindly, for somebody who has left the server', async () => {
    const { state, replies, interaction, client, sent } = click({ members: [] });
    await onDailyButton(dbFor(state), client, null, SITE, GUILD, interaction);
    assert.equal(replies.at(-1)!.title, 'Join the server first');
    assert.equal(sent.length, 0);
  });

  it('says not yet while the dashboard switch is off, and subscribes nobody', async () => {
    const { state, replies, interaction, client, sent } = click({
      members: ['323456789012345678'],
      enabled: false,
    });
    await onDailyButton(dbFor(state), client, null, SITE, GUILD, interaction);
    assert.equal(replies.at(-1)!.title, 'Not yet');
    assert.equal(sent.length, 0);
  });
});

// ── wiring ─────────────────────────────────────────────────────────────────

describe('how it is wired', () => {
  const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');

  it('answers the button before the guild check, because a DM has no guild', async () => {
    const server = await read('../src/server.ts');
    const branch = server.slice(server.indexOf('if (interaction.isButton()) {'));
    assert.ok(
      branch.indexOf('DAILY_ON_BUTTON') < branch.indexOf('wrongGuild(interaction.guildId)'),
      'the daily button is handled first',
    );
    assert.match(
      server,
      /onDailyButton\(db, client, api, config\.siteUrl, config\.guildId, interaction\)/,
    );
    assert.match(server, /case 'daily-invite':/);
  });

  it('registers /daily-invite for administrators, with preview, send, status and stop', async () => {
    const commands = await read('../src/commands.ts');
    const block = commands.slice(
      commands.indexOf("setName('daily-invite')"),
      commands.indexOf("setName('redeem')"),
    );
    assert.match(block, /setDefaultMemberPermissions\(ADMINISTRATOR\)/);
    for (const sub of ['preview', 'send', 'status', 'stop'])
      assert.match(block, new RegExp(`setName\\('${sub}'\\)`));
    assert.match(block, /setName\('count'\)[\s\S]{0,200}setMaxValue\(20000\)/);
  });

  it('uses the owner rule /test uses, and never reads the users table or a wallet', async () => {
    const source = await read('../src/features/daily-invite.ts');
    assert.match(source, /currentOwners\(db, interaction, options\.extraOwnerIds\)/);
    assert.doesNotMatch(source, /FROM users|UPDATE users|wallet_transactions/i);
  });

  it('types the claim statement’s parameters, which Postgres needs and a mock cannot check', async () => {
    const source = await read('../src/features/daily-invite.ts');
    assert.match(source, /SELECT \$1::varchar, \$2::varchar/);
  });

  it('adds one new table and nothing else', async () => {
    const sql = await read('../../../packages/db/migrations/065_daily_code_invites.sql');
    assert.doesNotMatch(sql, /DROP |DELETE FROM|TRUNCATE|ALTER /i);
    assert.match(sql, /CREATE TABLE discord_daily_invites/);
    assert.match(sql, /PRIMARY KEY \(guild_id, discord_user_id\)/);
    assert.match(sql, /outcome IN \('claimed', 'sent', 'closed'\)/);
    assert.match(sql, /CREATE FUNCTION donut_schema_ready_v65\(\) RETURNS boolean/);
  });
});
