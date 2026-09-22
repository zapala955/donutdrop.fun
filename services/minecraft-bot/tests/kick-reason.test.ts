import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeKick } from '../src/worker.js';

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
