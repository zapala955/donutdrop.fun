import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectLink, isOwnDomainOnly } from '../src/lib/link-filter.js';

/**
 * The false positives are the point of this file.
 *
 * A chat filter that refuses "let me know in chat" is a filter that gets turned off, and a filter
 * that is off blocks nothing at all. So the sentences below are weighted towards what players
 * actually type in a Minecraft gambling chat — short, unpunctuated, full of two-letter words that
 * are also real top-level domains.
 */

const blocked = (text: string) => detectLink(text)?.rule ?? null;

describe('links people are trying to post', () => {
  it('catches an ordinary address', () => {
    for (const text of [
      'example.com',
      'go to example.com now',
      'https://example.com/path',
      'HTTP://EXAMPLE.COM',
      'discord.gg/abcdef',
      'www.example.com',
      'sub.example.co.uk',
    ]) {
      assert.ok(blocked(text), text);
    }
  });

  it('catches the space bypass the report was about', () => {
    for (const text of [
      'blabla com',
      'join blabla com',
      'freegems xyz',
      'myserver net',
      'someplace org',
    ]) {
      assert.ok(blocked(text), text);
    }
  });

  /**
   * The documented gap, asserted so nobody closes it by accident.
   *
   * A TLD that is also an English word cannot be matched on a space alone -- "the item store" and
   * "are you online" are sentences. Those domains are still caught the moment they are written
   * with a dot, a bracketed dot or a path, which is every way anyone actually posts one.
   */
  it('lets a word-like TLD past on a bare space, and catches it any other way', () => {
    assert.equal(blocked('myshop store'), null);
    assert.equal(blocked('coolsite online'), null);

    assert.ok(blocked('myshop.store'));
    assert.ok(blocked('myshop(dot)store'));
    assert.ok(blocked('myshop store/deals'));
  });

  it('catches a written-out or bracketed dot', () => {
    for (const text of [
      'example dot com',
      'example(dot)com',
      'example [dot] com',
      'example{dot}com',
      'example(.)com',
      'example [.] com',
    ]) {
      assert.ok(blocked(text), text);
    }
  });

  it('catches a spaced-out real dot', () => {
    assert.ok(blocked('example . com'));
    assert.ok(blocked('example .com'));
  });

  it('catches a short TLD once there is a path after it', () => {
    /* `gg` and `ly` are too word-like to match on a space alone, so the slash is what makes them
     * safe to catch. This is how discord.gg links get posted once the dot is blocked. */
    for (const text of ['discord gg/abcdef', 'bit ly/xyz', 'goo gl/aaa']) {
      assert.ok(blocked(text), text);
    }
  });

  it('catches a scheme somebody has broken up', () => {
    for (const text of ['hxxp://evil.com', 'h t t p://evil.com', 'ftp://files.example.net']) {
      assert.ok(blocked(text), text);
    }
  });

  it('sees through invisible characters', () => {
    // A zero-width space inside the word, which renders as a domain and reads as two labels.
    assert.ok(blocked('disc\u200bord.gg/abc'));
    assert.ok(blocked('exa\ufeffmple.com'));
  });

  it('sees through dot homoglyphs', () => {
    for (const text of ['example\u3002com', 'example\uff0ecom', 'example\u00b7com']) {
      assert.ok(blocked(text), text);
    }
  });

  it('catches a raw IP', () => {
    assert.ok(blocked('join 192.168.0.1'));
    assert.ok(blocked('join 192 168 0 1'));
  });
});

describe('things players actually say', () => {
  /**
   * Every one of these contains a word that is also a real TLD — in, me, gg, at, is, it, so, to,
   * am, us, no, be. A filter matching "word space TLD" against the full list refuses all of them.
   */
  it('does not refuse ordinary sentences', () => {
    for (const text of [
      'let me know in chat',
      'nice gg',
      'gg wp',
      'get back to me',
      'that was so lucky',
      'who is up for a duel',
      'i am in',
      'send it to me',
      'im in',
      'he is at spawn',
      'im in/out for the next one',
      'buy/sell in chat',
      'that sucked. in the next round i go again',
      'lost it all. no more for me',
      'thanks a lot',
      'anyone want to trade',
      'i won 5m on roulette',
      'max bet is 1b right',
      'this site is so good',
      'up or down',
      'w or l',
      'first time here, what do i do',
    ]) {
      assert.equal(blocked(text), null, text);
    }
  });

  it('does not refuse talk about the games', () => {
    for (const text of [
      'upgrader at 2x is free money',
      'cases are better than upgrader',
      'roulette red 5 times in a row',
      'case battles when',
      'i hit 100x on upgrader',
      'vip gold 1 now',
    ]) {
      assert.equal(blocked(text), null, text);
    }
  });

  it('does not refuse decimals or money', () => {
    for (const text of ['i bet 1.5m', 'balance is 4.21k', 'up 0.5 percent', 'won 12.75m']) {
      assert.equal(blocked(text), null, text);
    }
  });
});

describe('the site talking about itself', () => {
  it('allows its own address and nothing else', () => {
    assert.ok(isOwnDomainOnly('check donutdrop.fun/crates', 'donutdrop.fun'));
    assert.ok(isOwnDomainOnly('https://donutdrop.fun', 'donutdrop.fun'));
    assert.ok(isOwnDomainOnly('www.donutdrop.fun is up', 'donutdrop.fun'));
  });

  it('is not fooled by a lookalike host', () => {
    /* The exact host, not a suffix. `donutdrop.fun.example.com` is somebody else's domain wearing
     * this one as a label, and it is the first thing anybody would try. */
    assert.equal(isOwnDomainOnly('donutdrop.fun.example.com', 'donutdrop.fun'), false);
    assert.equal(isOwnDomainOnly('notdonutdrop.fun', 'donutdrop.fun'), false);
  });

  it('refuses a message that carries a second link alongside its own', () => {
    assert.equal(isOwnDomainOnly('donutdrop.fun is better than evil.com', 'donutdrop.fun'), false);
  });
});
