import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeKick, isBanKick, isHeldOffKick } from '../src/worker.js';

/* The vault account was banned on 2026-10-07 and reconnected once a minute for a day afterwards,
 * from the same address the teller uses. A ban now parks the bot for hours instead. */
describe('a ban kick', () => {
  it('is told apart from an ordinary disconnect', () => {
    assert.equal(
      isBanKick('§cYou are permanently banned for botting.\n\n§7Date: §f07/10/2026'),
      true,
    );
    assert.equal(isBanKick('You are banned from this server'), true);
    assert.equal(isBanKick('multiplayer.disconnect.duplicate_login'), false);
    assert.equal(isBanKick('Server restarting'), false);
    assert.equal(isBanKick('Check out our banner shop'), false);
  });

  it('parks the bot instead of reconnecting, and keeps the process alive while it waits', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
    assert.match(source, /const BANNED_RETRY_MS = 6 \* 60 \* 60_000;/);
    assert.match(source, /if \(isBanKick\(text\)\) this\.banned = true;/);
    const end = source.slice(source.indexOf('if (!this.stopped && this.banned) {'));
    // Not unref'd: an idle process that exits is restarted by Docker straight away.
    assert.match(end.slice(0, 700), /setTimeout\(\(\) => this\.connect\(\), BANNED_RETRY_MS\);\r?\n/);
    assert.doesNotMatch(end.slice(0, end.indexOf('} else if')), /unref\(\)/);
  });
});

/* 2026-10-16: a relog landed on DonutSMP's maintenance, and its network then held the vault's old
 * session for nine minutes while the bot knocked once a minute. */
describe('a kick that says the server cannot let the account in yet', () => {
  it('is told apart from a ban and from an ordinary disconnect', () => {
    assert.equal(isHeldOffKick('You are already online\nYou are connected to proxy: 7eab12058666'), true);
    assert.equal(
      isHeldOffKick('Follow us on discord: discord.gg/donutsmp§cWe are under maintenance, please wait a few minutes and try again.'),
      true,
    );
    assert.equal(isHeldOffKick('You are banned from this server'), false);
    assert.equal(isHeldOffKick('Server restarting'), false);
    assert.equal(isHeldOffKick('multiplayer.disconnect.duplicate_login'), false);
  });

  it('waits longer after each refusal in a row, with the process held open', async () => {
    const { readFile } = await import('node:fs/promises');
    const { heldOffRetryMs } = await import('../src/worker.js');
    /* 2026-10-28: knocking every 300 s on the dot kept wymiar out for 36 minutes; a ten-minute
     * silence let it straight in. So the waits grow, and never land on the same beat twice. */
    assert.equal(heldOffRetryMs(0, () => 0), 5 * 60_000);
    assert.equal(heldOffRetryMs(1, () => 0), 10 * 60_000);
    assert.equal(heldOffRetryMs(2, () => 0), 15 * 60_000);
    assert.equal(heldOffRetryMs(9, () => 0), 15 * 60_000);
    assert.equal(heldOffRetryMs(0, () => 0.999), 5 * 60_000 + 59_940);
    const source = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
    assert.match(source, /else if \(isHeldOffKick\(text\)\) this\.heldOff = true;/);
    // Back to the shortest wait once the bot is in game again.
    assert.match(source, /'Mineflayer bot spawned'\);\r?\n\s*this\.heldOffStreak = 0;/);
    const branch = source.slice(source.indexOf('} else if (!this.stopped && this.heldOff) {'));
    const body = branch.slice(0, branch.indexOf('} else if', 10));
    assert.match(body, /const wait = heldOffRetryMs\(this\.heldOffStreak\);\s*this\.heldOffStreak \+= 1;/);
    assert.match(body, /this\.heldOff = false;/);
    assert.match(body, /\}, wait\);\r?\n\s*this\.timers\.add\(timer\);/);
    assert.doesNotMatch(body, /unref\(\)/);
  });
});

/**
 * Every kick in the log read `reason: "[object Object]"`.
 *
 * The server sends a chat component and the handler ran `String()` over it, so the one field that
 * says why a bot cannot stay connected was discarded on the way to being written down. A bot that
 * is being refused and a bot that is being duplicate-logged-in looked identical.
 */
describe('reading a kick reason', () => {
  it('pulls the text out of a chat component', () => {
    assert.equal(describeKick({ text: 'You are banned from this server' }), 'You are banned from this server');
    assert.equal(
      describeKick({ text: 'Kicked: ', extra: [{ text: 'too many accounts' }] }),
      'Kicked: too many accounts',
    );
  });

  /* The most important one to be able to read, and the only one that is never literal text: the
   * vanilla duplicate-login kick arrives as a translation key. */
  it('keeps a translation key when there is no literal text', () => {
    assert.equal(
      describeKick({ translate: 'multiplayer.disconnect.duplicate_login' }),
      'multiplayer.disconnect.duplicate_login',
    );
  });

  it('parses a component that arrived as a JSON string', () => {
    assert.equal(describeKick('{"text":"Server full"}'), 'Server full');
    // And leaves a plain string alone rather than mangling it.
    assert.equal(describeKick('Connection throttled'), 'Connection throttled');
  });

  /* The shape DonutSMP's "already online" kick arrived in: every value wrapped as `{ type, value }`,
   * and a list carrying its element type once with bare compounds inside. */
  it('reads a component sent as NBT', () => {
    const str = (value: string) => ({ type: 'string', value });
    const nbt = {
      type: 'compound',
      value: {
        extra: {
          type: 'list',
          value: {
            type: 'compound',
            value: [
              { color: str('red'), text: str('You are already online\n') },
              { color: str('gray'), text: str('You are connected to proxy: ') },
              { color: str('white'), text: str('7eab12058666') },
            ],
          },
        },
        text: str(''),
      },
    };
    const expected = 'You are already online\nYou are connected to proxy: 7eab12058666';
    assert.equal(describeKick(nbt), expected);
    assert.equal(describeKick(JSON.stringify(nbt)), expected);
    assert.equal(isHeldOffKick(describeKick(nbt)), true);
    // An ordinary component that happens to have a `type` key is not mistaken for NBT.
    assert.equal(describeKick({ type: 'text', text: 'Server full' }), 'Server full');
  });

  it('falls back to the raw JSON rather than to the word object', () => {
    const rendered = describeKick({ reasonCode: 42, nested: { code: 'IP_LIMIT' } });
    assert.doesNotMatch(rendered, /\[object Object\]/);
    assert.match(rendered, /IP_LIMIT/);
  });

  it('never returns [object Object], whatever it is handed', () => {
    for (const input of [{}, [], null, undefined, 0, { extra: [] }, { with: [{}] }]) {
      assert.doesNotMatch(describeKick(input), /\[object Object\]/, `failed on ${JSON.stringify(input)}`);
    }
  });

  it('survives a self-referencing component instead of hanging', () => {
    const loop: Record<string, unknown> = { text: 'a' };
    loop['extra'] = [loop];
    assert.doesNotThrow(() => describeKick(loop));
  });

  it('bounds what it writes into the log', () => {
    assert.ok(describeKick({ text: 'x'.repeat(5000) }).length <= 500);
  });
});

/* 2026-10-28: an unconfirmed payout ended the teller's connection on purpose. The reconnect timer
 * was unref'd, so the idle process exited, Docker restarted it at once, and the new login landed
 * while DonutSMP still held the old session: "You are already online", then five minutes held off.
 * The container had restarted 135 times that way. */
describe('an ordinary disconnect', () => {
  it('waits out the gap in the same process, so the server has let the old session go', async () => {
    const { readFile } = await import('node:fs/promises');
    const { RECONNECT_GAP_MS } = await import('../src/worker.js');
    const source = (await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    assert.ok(RECONNECT_GAP_MS >= 10_000);
    const ordinary = source.slice(source.indexOf('} else if (!this.stopped) {'));
    const branch = ordinary.slice(0, ordinary.indexOf('\n      }\n'));
    assert.match(branch, /setTimeout\(\(\) => \{\s*this\.timers\.delete\(timer\);\s*this\.connect\(\);\s*\}, RECONNECT_GAP_MS\);/);
    assert.match(branch, /this\.timers\.add\(timer\);/);
    // An unref'd timer lets the process exit and Docker log straight back in.
    assert.doesNotMatch(branch, /\.unref\(\)/);
  });
});
