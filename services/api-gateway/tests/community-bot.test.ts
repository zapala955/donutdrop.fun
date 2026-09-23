import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hmacHex } from '../src/lib/crypto.js';
import { communityBotSignaturePayload } from '../src/lib/community-bot-auth.js';

/**
 * The gateway half of the signing seam.
 *
 * `services/community-bot/tests/signature.test.ts` pins the bot's canonical output to these exact
 * literals; this file pins the gateway's. Neither imports the other — that would break both
 * `rootDir` settings — so drift on either side fails that side's own suite.
 *
 * When a literal here changes, change the matching one in the bot suite in the same commit.
 */

const KEY = 'k'.repeat(48);

const PROFILE_CANONICAL =
  '{"audience":"donut-upgrader-community-bot",' +
  '"body":{"discordUserId":"123456789012345678"},' +
  '"method":"POST","path":"/internal/v1/community/profile",' +
  '"timestamp":"1700000000000","version":1}';

describe('the payload the gateway verifies a community bot request against', () => {
  it('matches the pinned wire format exactly', () => {
    assert.equal(
      communityBotSignaturePayload('POST', '/internal/v1/community/profile', '1700000000000', {
        discordUserId: '123456789012345678',
      }),
      PROFILE_CANONICAL,
    );
  });

  it('uppercases the method, so a lowercase verb signs the same', () => {
    assert.equal(
      communityBotSignaturePayload('post', '/internal/v1/community/profile', '1700000000000', {
        discordUserId: '123456789012345678',
      }),
      PROFILE_CANONICAL,
    );
  });

  /**
   * The separation from the control plane, asserted rather than assumed.
   *
   * The community bot runs in a server anybody can join. If its signatures verified on control
   * routes, a compromise of that process would be a compromise of the admin session mint. The
   * audience string inside the signed payload is what prevents it, so it is pinned here as a
   * literal — a constant would move silently with a careless rename.
   */
  it('signs a different audience from the control plane', () => {
    const payload = communityBotSignaturePayload(
      'POST',
      '/internal/v1/community/profile',
      '1700000000000',
      {},
    );
    assert.ok(payload.includes('"audience":"donut-upgrader-community-bot"'));
    assert.ok(!payload.includes('donut-upgrader-discord-control'));
  });

  it('binds the path, so one signature does not move to another route', () => {
    const body = { discordUserId: '123456789012345678' };
    const here = communityBotSignaturePayload(
      'POST',
      '/internal/v1/community/profile',
      '1700000000000',
      body,
    );
    const elsewhere = communityBotSignaturePayload(
      'POST',
      '/internal/v1/discord/command',
      '1700000000000',
      body,
    );
    assert.notEqual(hmacHex(KEY, here), hmacHex(KEY, elsewhere));
  });

  it('binds the Discord id, which is the field that decides whose profile comes back', () => {
    const mine = communityBotSignaturePayload(
      'POST',
      '/internal/v1/community/profile',
      '1700000000000',
      {
        discordUserId: '123456789012345678',
      },
    );
    const theirs = communityBotSignaturePayload(
      'POST',
      '/internal/v1/community/profile',
      '1700000000000',
      {
        discordUserId: '999999999999999999',
      },
    );
    assert.notEqual(hmacHex(KEY, mine), hmacHex(KEY, theirs));
  });
});
