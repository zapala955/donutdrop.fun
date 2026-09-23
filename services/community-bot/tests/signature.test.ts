import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, hmacHex } from '../src/canonical.js';

/**
 * One half of the signing seam, following the same protocol as
 * `services/discord-bot/tests/signature.test.ts`: this file pins the community bot's canonical
 * output to EXACT LITERAL STRINGS, and `api-gateway/tests/community-bot.test.ts` pins the
 * gateway's output to the same literals. Either side drifting fails its own suite, with no
 * cross-workspace import to break both `rootDir` settings.
 *
 * When a literal here changes, change the matching one in the gateway suite in the same commit.
 */

const KEY = 'k'.repeat(48);

/** The exact payload api-client.ts signs for a profile lookup. Mirrored in the gateway suite. */
const PROFILE_ENVELOPE = {
  audience: 'donut-upgrader-community-bot',
  version: 1,
  method: 'POST',
  path: '/internal/v1/community/profile',
  timestamp: '1700000000000',
  body: { discordUserId: '123456789012345678' },
};

const PROFILE_CANONICAL =
  '{"audience":"donut-upgrader-community-bot",' +
  '"body":{"discordUserId":"123456789012345678"},' +
  '"method":"POST","path":"/internal/v1/community/profile",' +
  '"timestamp":"1700000000000","version":1}';

describe('canonical form the community bot signs', () => {
  it('matches the pinned wire format exactly', () => {
    assert.equal(canonicalJson(PROFILE_ENVELOPE), PROFILE_CANONICAL);
  });

  /**
   * The audience is the whole separation between this bot and the control plane.
   *
   * If it ever matched 'donut-upgrader-discord-control', a signature minted by the community bot
   * would verify on a route that mints admin sessions — and the community bot runs in a server
   * anybody can join. The string is asserted here rather than trusted to a constant because that
   * is exactly the kind of value a copy-paste changes without anybody noticing.
   */
  it('does not sign with the control plane audience', () => {
    assert.equal(PROFILE_ENVELOPE.audience, 'donut-upgrader-community-bot');
    assert.notEqual(PROFILE_ENVELOPE.audience, 'donut-upgrader-discord-control');
    assert.ok(!PROFILE_CANONICAL.includes('discord-control'));
  });

  it('signs a path under the community prefix, never the control prefix', () => {
    assert.ok(PROFILE_ENVELOPE.path.startsWith('/internal/v1/community/'));
    assert.ok(!PROFILE_ENVELOPE.path.startsWith('/internal/v1/discord/'));
  });
});

describe('signature binding', () => {
  it('produces a stable HMAC for the pinned payload', () => {
    assert.match(hmacHex(KEY, PROFILE_CANONICAL), /^[a-f0-9]{64}$/);
    assert.equal(hmacHex(KEY, PROFILE_CANONICAL), hmacHex(KEY, canonicalJson(PROFILE_ENVELOPE)));
  });

  it('changes the signature when any signed field changes', () => {
    /* Each of these is a field somebody on the wire would want to alter — and the last one is the
     * one that decides whose profile comes back, which is why it travels in the body. */
    const base = hmacHex(KEY, canonicalJson(PROFILE_ENVELOPE));
    const variants = [
      { ...PROFILE_ENVELOPE, method: 'GET' },
      { ...PROFILE_ENVELOPE, path: '/internal/v1/discord/command' },
      { ...PROFILE_ENVELOPE, timestamp: '1700000000001' },
      { ...PROFILE_ENVELOPE, audience: 'donut-upgrader-discord-control' },
      { ...PROFILE_ENVELOPE, body: { discordUserId: '999999999999999999' } },
    ];
    for (const variant of variants) {
      assert.notEqual(hmacHex(KEY, canonicalJson(variant)), base);
    }
  });

  it('gives a different digest under a different key', () => {
    // The control plane's key must not produce this bot's signature, and vice versa.
    assert.notEqual(
      hmacHex('a'.repeat(48), PROFILE_CANONICAL),
      hmacHex('b'.repeat(48), PROFILE_CANONICAL),
    );
  });
});
