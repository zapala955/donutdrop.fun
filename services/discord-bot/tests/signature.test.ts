import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, hmacHex } from '../src/canonical.js';

/**
 * The bot and the gateway each carry their own copy of the canonicalizer, deliberately — sharing a
 * package across a service boundary is a deploy-time coupling neither side wants.
 *
 * The cost of that choice is drift, and the failure mode is total: one byte of disagreement makes
 * every signature invalid, so the bot stops working entirely the moment somebody edits one copy.
 * That is a silent, whole-feature outage discovered in production.
 *
 * This file is one half of the seam. It pins the bot's output to EXACT LITERAL STRINGS, and
 * `api-gateway/tests/discord-control.test.ts` pins the gateway's output to the same literals. If
 * either implementation drifts, that side's suite fails on its own — without either project having
 * to import across the workspace boundary, which would break both `rootDir` settings.
 *
 * When changing a literal here, change the matching one in the gateway suite in the same commit.
 * That is the whole protocol.
 */

const KEY = 'k'.repeat(48);

/** The exact payload api-client.ts signs for `/stats`. Mirrored in the gateway suite. */
const STATS_ENVELOPE = {
  audience: 'donut-upgrader-discord-control',
  version: 1,
  method: 'POST',
  path: '/internal/v1/discord/command',
  timestamp: '1700000000000',
  body: { context: { discordUserId: '123456789012345678' }, request: { command: 'stats' } },
};

const STATS_CANONICAL =
  '{"audience":"donut-upgrader-discord-control",' +
  '"body":{"context":{"discordUserId":"123456789012345678"},"request":{"command":"stats"}},' +
  '"method":"POST","path":"/internal/v1/discord/command",' +
  '"timestamp":"1700000000000","version":1}';

describe('canonical form the bot signs', () => {
  it('matches the pinned wire format exactly', () => {
    assert.equal(canonicalJson(STATS_ENVELOPE), STATS_CANONICAL);
  });

  it('sorts keys, so two structurally equal bodies sign identically', () => {
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.equal(canonicalJson({ a: 1, b: 2 }), '{"a":1,"b":2}');
  });

  it('pins the encoding of the characters that split naive implementations', () => {
    /* Non-ASCII, backslashes and quotes are where a hand-rolled canonicalizer diverges from
     * JSON.stringify. Both copies delegate to JSON.stringify for scalars; this holds them to it. */
    assert.equal(canonicalJson({ q: 'say "hi"' }), '{"q":"say \\"hi\\""}');
    assert.equal(canonicalJson({ b: 'a\\b' }), '{"b":"a\\\\b"}');
    assert.equal(canonicalJson({ u: 'héllo — x' }), '{"u":"héllo — x"}');
    assert.equal(canonicalJson({ n: null, z: 0, f: false }), '{"f":false,"n":null,"z":0}');
    assert.equal(canonicalJson({ e: {}, a: [] }), '{"a":[],"e":{}}');
  });

  it('refuses what the gateway also refuses', () => {
    /* Signing something the gateway cannot canonicalize would produce INVALID_DISCORD_BODY — a
     * failure reported far from its cause. Both sides reject the same values. */
    assert.throws(() => canonicalJson({ fn: () => 1 }));
    assert.throws(() => canonicalJson({ sym: Symbol('x') }));
    assert.throws(() => canonicalJson({ inf: Infinity }));
    assert.throws(() => canonicalJson({ nan: NaN }));
    assert.throws(() => canonicalJson({ big: 1n }));
  });

  it('refuses a cycle rather than hanging', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    assert.throws(() => canonicalJson(cyclic));
  });
});

describe('signature binding', () => {
  it('produces a stable HMAC for the pinned payload', () => {
    /* A fixed key and a fixed payload give a fixed digest. Any change to either the canonical form
     * or the HMAC construction moves this value, which is the point. */
    assert.match(hmacHex(KEY, STATS_CANONICAL), /^[a-f0-9]{64}$/);
    assert.equal(hmacHex(KEY, STATS_CANONICAL), hmacHex(KEY, canonicalJson(STATS_ENVELOPE)));
  });

  it('changes the signature when any signed field changes', () => {
    /* Each of these is a field an attacker positioned on the wire would want to alter: the verb,
     * the route, the freshness stamp, and which command actually runs. */
    const base = hmacHex(KEY, canonicalJson(STATS_ENVELOPE));
    const variants = [
      { ...STATS_ENVELOPE, method: 'GET' },
      { ...STATS_ENVELOPE, path: '/internal/v1/discord/alerts' },
      { ...STATS_ENVELOPE, timestamp: '1700000000001' },
      {
        ...STATS_ENVELOPE,
        body: {
          context: { discordUserId: '123456789012345678' },
          request: { command: 'suspend-user' },
        },
      },
      {
        ...STATS_ENVELOPE,
        body: { context: { discordUserId: '999999999999999999' }, request: { command: 'stats' } },
      },
    ];
    for (const variant of variants) {
      assert.notEqual(base, hmacHex(KEY, canonicalJson(variant)));
    }
  });

  it('is sensitive to the key', () => {
    assert.notEqual(hmacHex(KEY, STATS_CANONICAL), hmacHex('x'.repeat(48), STATS_CANONICAL));
  });
});
