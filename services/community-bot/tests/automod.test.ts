import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect, sweepSpamState } from '../src/features/automod.js';
import { formatMoney, humanDuration, parseDuration } from '../src/ui.js';

/**
 * The automod rules decide whether somebody's message gets deleted, so the interesting cases are
 * the FALSE POSITIVES. A rule that catches every invite and also eats ordinary conversation is a
 * rule that gets switched off within a day, which protects nothing.
 */

const ALL_OFF = { invites: false, links: false, spam: false, caps: false };

describe('automod · invites', () => {
  const on = { ...ALL_OFF, invites: true };

  it('catches the shapes an invite actually arrives in', () => {
    for (const text of [
      'join discord.gg/abc123',
      'https://discord.gg/AbC-123',
      'discordapp.com/invite/xyz789',
      'https://discord.com/invite/someguild',
      'DISCORD.GG/SHOUTING',
    ]) {
      assert.equal(inspect(text, 'u', on)?.rule, 'invites', text);
    }
  });

  it('leaves ordinary talk about Discord alone', () => {
    /* The word is not the link. A server that deletes "check the discord" has a rule nobody can
     * live with, and this is the case a naive `includes('discord')` gets wrong. */
    for (const text of [
      'check the discord for details',
      'discord is down again',
      'my discord tag is bob',
    ]) {
      assert.equal(inspect(text, 'u', on), null, text);
    }
  });
});

describe('automod · caps', () => {
  const on = { ...ALL_OFF, caps: true };

  it('catches sustained shouting', () => {
    assert.equal(inspect('WHY IS NOBODY ANSWERING ME', 'u', on)?.rule, 'caps');
  });

  it('ignores short bursts and acronyms', () => {
    /* Below the length floor nothing is judged: "OK", "GG", "WTF" and a stray "LOL" are how people
     * talk, and a filter that eats them is a filter that gets turned off. */
    for (const text of ['OK', 'GG', 'WTF', 'LOL', 'NO WAY']) {
      assert.equal(inspect(text, 'u', on), null, text);
    }
  });

  it('measures letters, not punctuation', () => {
    // '!!!!!!!!!!' is not shouting in the sense this rule means, and it has no letters at all.
    assert.equal(inspect('!!!!!!!!!!!!!!!!', 'u', on), null);
  });
});

describe('automod · spam', () => {
  it('fires only past the burst limit, and counts per person', () => {
    const on = { ...ALL_OFF, spam: true };
    const now = 1_700_000_000_000;
    // Five in the window is fine; the sixth is the one that trips.
    for (let index = 0; index < 5; index += 1) {
      assert.equal(inspect('hi', 'guild:alice', on, now + index * 100), null);
    }
    assert.equal(inspect('hi', 'guild:alice', on, now + 600)?.rule, 'spam');

    // Somebody else's messages are counted separately — one loud member must not mute the room.
    assert.equal(inspect('hi', 'guild:bob', on, now + 700), null);
  });

  it('forgets a burst once the window has passed', () => {
    const on = { ...ALL_OFF, spam: true };
    const now = 1_800_000_000_000;
    for (let index = 0; index < 6; index += 1) inspect('hi', 'guild:carol', on, now + index * 100);
    // Eight seconds later the window is empty again, so a normal message is normal.
    assert.equal(inspect('hi', 'guild:carol', on, now + 20_000), null);
  });

  it('drops state for people who stopped talking', () => {
    const on = { ...ALL_OFF, spam: true };
    inspect('hi', 'guild:dave', on, 1_900_000_000_000);
    sweepSpamState(1_900_000_060_000);
    // Proven by behaviour rather than by reading the map: the next message starts a fresh count.
    assert.equal(inspect('hi', 'guild:dave', on, 1_900_000_060_001), null);
  });
});

describe('automod · everything off', () => {
  it('judges nothing when no rule is enabled', () => {
    assert.equal(inspect('discord.gg/abc SHOUTING http://x.com', 'u', ALL_OFF), null);
  });
});

describe('durations', () => {
  it('reads the forms people type', () => {
    assert.equal(parseDuration('30s'), 30);
    assert.equal(parseDuration('10m'), 600);
    assert.equal(parseDuration('2h'), 7200);
    assert.equal(parseDuration('1d12h'), 86_400 + 43_200);
  });

  it('returns null rather than a default for nonsense', () => {
    /* A silent default would mute somebody for an hour when the moderator typed "soon". Null
     * forces the caller to say it could not read the input. */
    for (const text of ['', 'soon', '10', 'm10', '5x', '-3m', '1.5h']) {
      assert.equal(parseDuration(text), null, text);
    }
  });

  it('refuses a duration nobody meant', () => {
    assert.equal(parseDuration('9999d'), null);
  });

  it('reads back what it parsed', () => {
    assert.equal(humanDuration(90), '1m 30s');
    assert.equal(humanDuration(86_400), '1d');
    assert.equal(humanDuration(0), '0s');
  });
});

describe('money', () => {
  it('writes amounts the way the site does', () => {
    assert.equal(formatMoney(0n), '$0');
    assert.equal(formatMoney(999n), '$999');
    assert.equal(formatMoney(1_000n), '$1k');
    assert.equal(formatMoney(1_500_000n), '$1.5m');
    assert.equal(formatMoney(1_000_000_000n), '$1b');
    assert.equal(formatMoney(2_500_000_000_000n), '$2.5t');
  });

  it('drops a trailing .0 rather than printing it', () => {
    // "$1.0m" is noise; "$1.5m" is information.
    assert.equal(formatMoney(1_000_000n), '$1m');
    assert.equal(formatMoney(1_050_000n), '$1m');
  });

  it('handles values past the safe-integer range', () => {
    /* Past 2^53 a JS number cannot hold the exact figure, which is why the whole path is bigint:
     * every division here is bigint division, so nothing is converted on the way through. */
    assert.equal(formatMoney(9_007_199_254_740_993n), '$9007.1t');
    assert.equal(formatMoney(123_456_789_000_000_000n), '$123456.7t');
  });

  it('keeps a negative readable', () => {
    assert.equal(formatMoney(-1_500_000n), '-$1.5m');
  });
});
