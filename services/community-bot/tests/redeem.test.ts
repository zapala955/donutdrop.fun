import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from 'discord.js';
import { formatCode, normalizeCode, onDirectMessage, redeemUrl } from '../src/features/redeem.js';

const GUILD = '223456789012345678';
const USER = '323456789012345678';
const SITE = 'https://donutluxe.com';

describe('codes', () => {
  it('are shown with a dash and read back from any case, dash or spaces', () => {
    assert.equal(formatCode('ABCD2345'), 'ABCD-2345');
    assert.equal(normalizeCode('abcd-2345'), 'ABCD2345');
    assert.equal(normalizeCode('  ABCD 2345 '), 'ABCD2345');
    for (const bad of ['', 'hello', 'ABCD234', 'ABCD-23450', 'ABCD-234O', 'ABCD-234I']) {
      assert.equal(normalizeCode(bad), null, bad);
    }
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
  it('points a code sent to the bot to the site, with the code filled in, and redeems nothing', async () => {
    const { message, replies } = dm('abcd-2345', { id: '501' + USER });
    await onDirectMessage(message, SITE, 1_000);
    assert.equal(replies[0]!.embed.title, 'Redeem it on the site');
    assert.match(replies[0]!.embed.description ?? '', /not here/);
    assert.equal(replies[0]!.buttons[0]!.label, 'Redeem on the site');
    assert.equal(replies[0]!.buttons[0]!.url, `${SITE}/#redeem=ABCD2345`);
  });

  it('ignores bots and anything said in a server', async () => {
    for (const input of [dm('ABCD2345', { bot: true }), dm('ABCD2345', { guild: GUILD })]) {
      await onDirectMessage(input.message, SITE, 1_000);
      assert.equal(input.replies.length, 0);
    }
  });

  it('points anything else to the Redeem code window, at most once every few minutes', async () => {
    const id = '601' + USER;
    const first = dm('hello?', { id });
    await onDirectMessage(first.message, SITE, 10_000);
    assert.equal(first.replies[0]!.embed.title, 'Codes');
    assert.match(first.replies[0]!.embed.description ?? '', /Redeem code/);
    assert.doesNotMatch(first.replies[0]!.embed.description ?? '', /\/daily/);
    assert.equal(first.replies[0]!.buttons[0]!.url, `${SITE}/`, 'no code, so a plain link');
    const second = dm('anybody there?', { id });
    await onDirectMessage(second.message, SITE, 10_000 + 60_000);
    assert.equal(second.replies.length, 0, 'no reply loop');
  });
});
