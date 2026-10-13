import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ChatInputCommandInteraction, Client, Message } from 'discord.js';
import type { PlatformApi } from '../src/api-client.js';
import type { Database } from '../src/db.js';
import {
  buildCodeDm,
  dailyCommand,
  deliverDailyCode,
  formatCode,
  generateCode,
  normalizeCode,
  onDirectMessage,
  redeemUrl,
  runDailySender,
  subscribe,
} from '../src/features/daily-codes.js';

const GUILD = '223456789012345678';
const USER = '323456789012345678';
const SITE = 'https://donutluxe.com';
const NOW = new Date('2026-10-12T17:30:00Z');

// ── fakes ──────────────────────────────────────────────────────────────────

interface Handler {
  readonly match: RegExp;
  readonly answer: (values: readonly unknown[]) => { rows: unknown[]; rowCount: number };
}
function fakeDb(handlers: Handler[], settings: { enabled?: boolean; hour?: number } = {}) {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const db = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      if (/FROM discord_guild_settings/.test(sql)) {
        return {
          rows: [
            {
              guild_id: GUILD,
              daily_codes_enabled: settings.enabled ?? true,
              daily_codes_hour: settings.hour ?? 16,
            },
          ],
          rowCount: 1,
        };
      }
      const handler = handlers.find((entry) => entry.match.test(sql));
      return handler ? handler.answer(values) : { rows: [], rowCount: 0 };
    },
  } as unknown as Database;
  return {
    db,
    statements,
    count: (pattern: RegExp) => statements.filter((s) => pattern.test(s.sql)).length,
  };
}
const rows = (...list: unknown[]) => ({ rows: list, rowCount: list.length });

function fakeClient(options: { sendError?: unknown; fetchError?: unknown } = {}) {
  const sent: {
    to: string;
    payload: { embeds: { toJSON(): { fields?: { value: string }[] } }[] };
  }[] = [];
  const client = {
    users: {
      fetch: async (id: string) => {
        if (options.fetchError) throw options.fetchError;
        return {
          send: async (payload: unknown) => {
            if (options.sendError) throw options.sendError;
            sent.push({ to: id, payload: payload as never });
          },
        };
      },
    },
  } as unknown as Client;
  return { client, sent };
}
const discordError = (code: number) => Object.assign(new Error(`discord ${code}`), { code });

const claimOnce = (): Handler => {
  let claimed = false;
  return {
    match: /UPDATE discord_daily_subscribers SET last_sent_on/,
    answer: () => {
      if (claimed) return rows();
      claimed = true;
      return rows({ discord_user_id: USER });
    },
  };
};
const codeInsert: Handler = {
  match: /INSERT INTO discord_daily_codes/,
  answer: () => rows({ code: 'ABCD2345' }),
};

// ── codes ──────────────────────────────────────────────────────────────────

describe('codes', () => {
  it('are eight characters from an alphabet without 0, 1, I or O', () => {
    for (let index = 0; index < 200; index += 1) {
      assert.match(generateCode(), /^[A-HJ-NP-Z2-9]{8}$/);
    }
    assert.equal(
      generateCode(() => 0),
      'AAAAAAAA',
    );
    assert.equal(
      generateCode((max) => max - 1),
      '99999999',
    );
  });

  it('are shown with a dash and read back from any case, dash or spaces', () => {
    assert.equal(formatCode('ABCD2345'), 'ABCD-2345');
    assert.equal(normalizeCode('abcd-2345'), 'ABCD2345');
    assert.equal(normalizeCode('  ABCD 2345 '), 'ABCD2345');
    for (const bad of ['', 'hello', 'ABCD234', 'ABCD-23450', 'ABCD-234O', 'ABCD-234I']) {
      assert.equal(normalizeCode(bad), null, bad);
    }
  });
});

describe('the code message', () => {
  const json = (facts: Parameters<typeof buildCodeDm>[0]) => {
    const message = buildCodeDm(facts);
    return {
      embed: message.embeds[0]!.toJSON(),
      button: message.components[0]!.toJSON().components[0] as { url: string; label: string },
    };
  };

  it('shows the code, the ceiling the operator set, and how to redeem', () => {
    const { embed, button } = json({
      code: 'ABCD2345',
      siteUrl: `${SITE}/`,
      maxPrizeMinor: '100000000',
    });
    const text = JSON.stringify(embed);
    assert.match(text, /ABCD-2345/);
    assert.match(text, /from nothing up to \*\*\$100m\*\*/);
    assert.match(text, /Redeem it on the site/);
    assert.match(text, /How to redeem/);
    assert.match(text, /Daily code/, 'the menu entry to look for, if the button is missing');
    assert.doesNotMatch(text, /\/redeem|Reply to this message/, 'nothing is redeemed in Discord');
    assert.match(text, /\/daily off/);
    assert.equal(button.label, 'Redeem on the site');
    assert.equal(button.url, `${SITE}/#redeem=ABCD2345`, 'the code rides in the fragment');
  });

  it('does not quote a figure it was not given', () => {
    const text = JSON.stringify(
      json({ code: 'ABCD2345', siteUrl: SITE, maxPrizeMinor: null }).embed,
    );
    assert.match(text, /up to \*\*a big prize\*\*/);
    assert.doesNotMatch(text, /\$\d/);
  });
});

describe('where a code is redeemed', () => {
  it('is the site, with the code in the fragment so it never reaches a server log', () => {
    assert.equal(redeemUrl(SITE, 'ABCD2345'), `${SITE}/#redeem=ABCD2345`);
    assert.equal(redeemUrl(`${SITE}/`, 'ABCD2345'), `${SITE}/#redeem=ABCD2345`);
    assert.equal(redeemUrl(`${SITE}//`), `${SITE}/`);
    assert.doesNotMatch(redeemUrl(SITE, 'ABCD2345'), /\?/);
  });
});

// ── opting in ──────────────────────────────────────────────────────────────

describe('subscribing', () => {
  it('says whether it is new, from what the insert reports', async () => {
    const created = fakeDb([
      { match: /INSERT INTO discord_daily_subscribers/, answer: () => rows({ inserted: true }) },
    ]);
    assert.equal(await subscribe(created.db, GUILD, USER), 'subscribed');
    const again = fakeDb([
      { match: /INSERT INTO discord_daily_subscribers/, answer: () => rows({ inserted: false }) },
    ]);
    assert.equal(await subscribe(again.db, GUILD, USER), 'already');
  });
});

// ── delivery ───────────────────────────────────────────────────────────────

describe('delivering a code', () => {
  it('sends nothing while the dashboard switch is off', async () => {
    const { db, count } = fakeDb([claimOnce(), codeInsert], { enabled: false });
    const { client, sent } = fakeClient();
    assert.equal(await deliverDailyCode(db, client, null, SITE, GUILD, USER, NOW), 'off');
    assert.equal(sent.length, 0);
    assert.equal(count(/UPDATE discord_daily_subscribers SET last_sent_on/), 0);
  });

  it('claims the day first, then mints the code, then sends exactly one DM', async () => {
    const { db, statements } = fakeDb([claimOnce(), codeInsert]);
    const { client, sent } = fakeClient();
    assert.equal(await deliverDailyCode(db, client, null, SITE, GUILD, USER, NOW), 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, USER);
    assert.match(JSON.stringify(sent[0]!.payload.embeds[0]!.toJSON()), /ABCD-2345/);
    const order = statements.map((s) => s.sql);
    assert.ok(
      order.findIndex((sql) => /last_sent_on = \$3::date/.test(sql)) <
        order.findIndex((sql) => /INSERT INTO discord_daily_codes/.test(sql)),
      'the day is claimed before the code exists',
    );
    // The claim is for today in UTC, and only if they have not had it.
    const claim = statements.find((s) => /last_sent_on = \$3::date/.test(s.sql))!;
    assert.deepEqual(claim.values, [GUILD, USER, '2026-10-12']);
    assert.match(claim.sql, /last_sent_on IS NULL OR last_sent_on < \$3::date/);
  });

  it('does not send a second code the same day, however often it is asked', async () => {
    const { db } = fakeDb([claimOnce(), codeInsert]);
    const { client, sent } = fakeClient();
    assert.equal(await deliverDailyCode(db, client, null, SITE, GUILD, USER, NOW), 'sent');
    assert.equal(await deliverDailyCode(db, client, null, SITE, GUILD, USER, NOW), 'already');
    assert.equal(sent.length, 1);
  });

  it('counts a closed DM, and unsubscribes after three in a row', async () => {
    let failures = 0;
    const handlers = (): Handler[] => [
      {
        match: /UPDATE discord_daily_subscribers SET last_sent_on/,
        answer: () => rows({ discord_user_id: USER }),
      },
      codeInsert,
      { match: /SET failures = failures \+ 1/, answer: () => rows({ failures: (failures += 1) }) },
      { match: /DELETE FROM discord_daily_subscribers/, answer: () => ({ rows: [], rowCount: 1 }) },
    ];
    const { db, count } = fakeDb(handlers());
    const { client } = fakeClient({ sendError: discordError(50007) });
    assert.equal(await deliverDailyCode(db, client, null, SITE, GUILD, USER, NOW), 'closed');
    assert.equal(await deliverDailyCode(db, client, null, SITE, GUILD, USER, NOW), 'closed');
    assert.equal(count(/DELETE FROM discord_daily_subscribers/), 0, 'two failures are not enough');
    assert.equal(await deliverDailyCode(db, client, null, SITE, GUILD, USER, NOW), 'unreachable');
    assert.equal(count(/DELETE FROM discord_daily_subscribers/), 1);
  });

  it('unsubscribes at once somebody who no longer exists, and raises anything unexpected', async () => {
    const gone = fakeDb([
      claimOnce(),
      codeInsert,
      { match: /SET failures = failures \+ 1/, answer: () => rows({ failures: 1 }) },
    ]);
    const missing = fakeClient({ fetchError: discordError(10013) });
    assert.equal(
      await deliverDailyCode(gone.db, missing.client, null, SITE, GUILD, USER, NOW),
      'unreachable',
    );
    assert.equal(gone.count(/DELETE FROM discord_daily_subscribers/), 1);

    const broken = fakeDb([claimOnce(), codeInsert]);
    const failing = fakeClient({ sendError: discordError(500) });
    await assert.rejects(
      () => deliverDailyCode(broken.db, failing.client, null, SITE, GUILD, USER, NOW),
      /discord 500/,
    );
  });

  it('puts the operator’s ceiling in the message when the site can say it', async () => {
    const { db } = fakeDb([claimOnce(), codeInsert]);
    const { client, sent } = fakeClient();
    const api = {
      rewardStatus: async () => ({ dailyCodes: { enabled: true, maxPrizeMinor: '100000000' } }),
    } as unknown as PlatformApi;
    await deliverDailyCode(db, client, api, SITE, GUILD, USER, NOW);
    assert.match(JSON.stringify(sent[0]!.payload.embeds[0]!.toJSON()), /\$100m/);
  });
});

describe('the sender', () => {
  const due = (...ids: string[]): Handler => ({
    match: /SELECT discord_user_id FROM discord_daily_subscribers/,
    answer: () => rows(...ids.map((id) => ({ discord_user_id: id }))),
  });

  it('waits for the hour the dashboard sets', async () => {
    const { db, count } = fakeDb([due(USER)], { hour: 18 });
    const { client } = fakeClient();
    assert.equal(await runDailySender(db, client, null, SITE, GUILD, NOW, 0), 0);
    assert.equal(count(/SELECT discord_user_id FROM discord_daily_subscribers/), 0);
  });

  it('does nothing while sending is switched off', async () => {
    const { db } = fakeDb([due(USER)], { enabled: false });
    const { client, sent } = fakeClient();
    assert.equal(await runDailySender(db, client, null, SITE, GUILD, NOW, 0), 0);
    assert.equal(sent.length, 0);
  });

  it('sends to everybody who is due once the hour has come, and asks only for those not yet sent today', async () => {
    const { db, statements } = fakeDb(
      [
        due('323456789012345678', '423456789012345678'),
        {
          match: /UPDATE discord_daily_subscribers SET last_sent_on/,
          answer: () => rows({ ok: 1 }),
        },
        codeInsert,
        { match: /SET failures = 0/, answer: () => rows() },
      ],
      { hour: 16 },
    );
    const { client, sent } = fakeClient();
    assert.equal(await runDailySender(db, client, null, SITE, GUILD, NOW, 0), 2);
    assert.deepEqual(
      sent.map((entry) => entry.to),
      ['323456789012345678', '423456789012345678'],
    );
    const query = statements.find((s) =>
      /SELECT discord_user_id FROM discord_daily_subscribers/.test(s.sql),
    )!;
    assert.match(query.sql, /last_sent_on IS NULL OR last_sent_on < \$2::date/);
    assert.deepEqual(query.values, [GUILD, '2026-10-12']);
  });
});

// ── commands ───────────────────────────────────────────────────────────────

function command(sub: string, extra: { code?: string } = {}) {
  const replies: { title?: string; description?: string }[] = [];
  const interaction = {
    guildId: GUILD,
    user: { id: USER },
    options: {
      getSubcommand: () => sub,
      getString: () => extra.code ?? '',
    },
    deferReply: async () => undefined,
    editReply: async (payload: {
      embeds: { toJSON(): { title?: string; description?: string } }[];
    }) => {
      replies.push(payload.embeds[0]!.toJSON());
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

describe('/daily', () => {
  const subscribed: Handler = {
    match: /INSERT INTO discord_daily_subscribers/,
    answer: () => rows({ inserted: true }),
  };

  it('on: subscribes and sends the first code straight away', async () => {
    const { db, count } = fakeDb([
      subscribed,
      claimOnce(),
      codeInsert,
      { match: /SET failures = 0/, answer: () => rows() },
    ]);
    const { client, sent } = fakeClient();
    const { interaction, replies } = command('on');
    await dailyCommand(db, client, null, SITE, interaction);
    assert.equal(sent.length, 1);
    assert.equal(count(/INSERT INTO discord_daily_subscribers/), 1);
    assert.equal(replies[0]!.title, 'Daily codes on');
    assert.match(replies[0]!.description ?? '', /first code is in your DMs now/);
    assert.match(replies[0]!.description ?? '', /16:00 UTC/);
  });

  it('on: says so, and subscribes nobody, while sending is switched off', async () => {
    const { db, count } = fakeDb([subscribed], { enabled: false });
    const { client } = fakeClient();
    const { interaction, replies } = command('on');
    await dailyCommand(db, client, null, SITE, interaction);
    assert.equal(replies[0]!.title, 'Not yet');
    assert.equal(count(/INSERT INTO discord_daily_subscribers/), 0);
  });

  it('on: tells somebody whose DMs are closed how to open them, and does not keep the subscription', async () => {
    const { db, count } = fakeDb([
      subscribed,
      { match: /UPDATE discord_daily_subscribers SET last_sent_on/, answer: () => rows({ ok: 1 }) },
      codeInsert,
      { match: /SET failures = failures \+ 1/, answer: () => rows({ failures: 1 }) },
      { match: /DELETE FROM discord_daily_subscribers/, answer: () => ({ rows: [], rowCount: 1 }) },
    ]);
    const { client } = fakeClient({ sendError: discordError(50007) });
    const { interaction, replies } = command('on');
    await dailyCommand(db, client, null, SITE, interaction);
    assert.equal(replies[0]!.title, 'Could not DM you');
    assert.match(replies[0]!.description ?? '', /Direct Messages/);
    assert.ok(count(/DELETE FROM discord_daily_subscribers/) >= 1);
  });

  it('off: unsubscribes, and is honest when there was nothing to turn off', async () => {
    const on = fakeDb([
      { match: /DELETE FROM discord_daily_subscribers/, answer: () => ({ rows: [], rowCount: 1 }) },
    ]);
    const first = command('off');
    await dailyCommand(on.db, fakeClient().client, null, SITE, first.interaction);
    assert.equal(first.replies[0]!.title, 'Daily codes off');
    const off = fakeDb([]);
    const second = command('off');
    await dailyCommand(off.db, fakeClient().client, null, SITE, second.interaction);
    assert.equal(second.replies[0]!.title, 'Already off');
  });

  it('status: says whether today’s code is used', async () => {
    const { db } = fakeDb([
      {
        match: /FROM discord_daily_subscribers WHERE guild_id/,
        answer: () => rows({ last_sent_on: '2026-10-12' }),
      },
      {
        match: /FROM discord_daily_codes/,
        answer: () => rows({ redeemed_at: new Date(), prize_minor: '1000000' }),
      },
    ]);
    const { interaction, replies } = command('status');
    await dailyCommand(db, fakeClient().client, null, SITE, interaction);
    assert.equal(replies[0]!.title, 'Daily codes: on');
    assert.match(replies[0]!.description ?? '', /code is used \(\$1m\)/);
  });
});

// ── replying to the DM ─────────────────────────────────────────────────────

function dm(content: string, options: { bot?: boolean; guild?: string | null; id?: string } = {}) {
  const replies: {
    embed: { title?: string; description?: string };
    buttons: { url: string; label: string }[];
  }[] = [];
  const message = {
    content,
    guildId: options.guild ?? null,
    author: { id: options.id ?? USER, bot: options.bot ?? false },
    reply: async (payload: {
      embeds: { toJSON(): { title?: string; description?: string } }[];
      components: { toJSON(): { components: { url: string; label: string }[] } }[];
    }) => {
      replies.push({
        embed: payload.embeds[0]!.toJSON(),
        buttons: payload.components[0]!.toJSON().components,
      });
    },
  } as unknown as Message;
  return { message, replies };
}

describe('replying to the DM', () => {
  it('points a code sent back to the site, with the code filled in, and redeems nothing', async () => {
    const { message, replies } = dm('abcd-2345', { id: '501' + USER });
    await onDirectMessage(message, SITE, 1_000);
    assert.equal(replies[0]!.embed.title, 'Redeem it on the site');
    assert.match(replies[0]!.embed.description ?? '', /not here/);
    assert.equal(replies[0]!.buttons.length, 1);
    assert.equal(replies[0]!.buttons[0]!.label, 'Redeem on the site');
    assert.equal(replies[0]!.buttons[0]!.url, `${SITE}/#redeem=ABCD2345`);
  });

  it('ignores bots and anything said in a server', async () => {
    for (const input of [dm('ABCD2345', { bot: true }), dm('ABCD2345', { guild: GUILD })]) {
      await onDirectMessage(input.message, SITE, 1_000);
      assert.equal(input.replies.length, 0);
    }
  });

  it('points anything else to the command and the site, but at most once every few minutes', async () => {
    const id = '601' + USER;
    const first = dm('hello?', { id });
    await onDirectMessage(first.message, SITE, 10_000);
    assert.equal(first.replies[0]!.embed.title, 'Daily codes');
    assert.match(first.replies[0]!.embed.description ?? '', /\/daily on/);
    assert.equal(first.replies[0]!.buttons[0]!.url, `${SITE}/`, 'no code, so a plain link');
    const second = dm('anybody there?', { id });
    await onDirectMessage(second.message, SITE, 10_000 + 60_000);
    assert.equal(second.replies.length, 0, 'no reply loop');
    const later = dm('hello again', { id });
    await onDirectMessage(later.message, SITE, 10_000 + 6 * 60_000);
    assert.equal(later.replies.length, 1);
  });

  it('answers a code at most once every few minutes too, however fast they are sent', async () => {
    const id = '701' + USER;
    let answered = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const sent = dm('ABCD2345', { id });
      await onDirectMessage(sent.message, SITE, 100_000 + attempt * 1_000);
      answered += sent.replies.length;
    }
    assert.equal(answered, 1);
  });
});

// ── wiring ─────────────────────────────────────────────────────────────────

describe('how it is wired', () => {
  const read = (relative: string) => readFile(path.resolve(import.meta.dirname, relative), 'utf8');

  it('listens to DMs, routes the commands and starts the sender', async () => {
    const server = await read('../src/server.ts');
    assert.match(server, /GatewayIntentBits\.DirectMessages/);
    assert.match(server, /Partials\.Channel/);
    assert.match(
      server,
      /if \(!message\.guildId\) \{\s*void onDirectMessage\(message, config\.siteUrl\)/,
    );
    assert.match(server, /case 'daily':/);
    assert.doesNotMatch(server, /case 'redeem':/, 'nothing is redeemed in Discord');
    assert.match(server, /startDailySender\(db, ready, api, config\.siteUrl, config\.guildId/);
  });

  it('registers /daily with on, off and status, and no /redeem', async () => {
    const commands = await read('../src/commands.ts');
    const daily = commands.slice(
      commands.indexOf("setName('daily')"),
      commands.indexOf("setName('daily-invite')"),
    );
    for (const sub of ['on', 'off', 'status'])
      assert.match(daily, new RegExp(`setName\\('${sub}'\\)`));
    assert.doesNotMatch(commands, /setName\('redeem'\)/);
  });

  it('writes only its own two tables, and cannot redeem a code at all', async () => {
    const source = await read('../src/features/daily-codes.ts');
    assert.doesNotMatch(source, /FROM users|UPDATE users|INSERT INTO users|wallet_transactions/i);
    assert.doesNotMatch(source, /redeemDailyCode|daily-code\/redeem/);
    assert.doesNotMatch(await read('../src/api-client.ts'), /redeemDailyCode|daily-code\/redeem/);
    assert.match(source, /discord_daily_subscribers/);
    assert.match(source, /discord_daily_codes/);
  });
});
