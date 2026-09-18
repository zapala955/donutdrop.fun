import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MINECRAFT_USERNAME_PATTERN,
  bedrockIdentityFor,
  isBedrockUsername,
  platformIdentityFor,
} from '../src/lib/minecraft-username.js';
import { resolveMinecraftAccount } from '../src/lib/minecraft-identity.js';

describe('minecraft usernames across both editions', () => {
  it('accepts Java names and the dotted names Floodgate gives Bedrock players', () => {
    for (const name of ['Notch', 'zapalka_955', 'abc', 'a'.repeat(16), '.Gamertag', '.ab']) {
      assert.ok(MINECRAFT_USERNAME_PATTERN.test(name), `${name} should be accepted`);
    }
  });

  it('holds both editions inside the 16 characters the schema stores', () => {
    // varchar(16) on users.minecraft_username is the real ceiling, and Floodgate truncates to it,
    // so a dotted name may carry 15 body characters where a Java one carries 16.
    assert.ok(MINECRAFT_USERNAME_PATTERN.test(`.${'a'.repeat(15)}`));
    assert.ok(!MINECRAFT_USERNAME_PATTERN.test(`.${'a'.repeat(16)}`));
    assert.ok(!MINECRAFT_USERNAME_PATTERN.test('a'.repeat(17)));
  });

  it('refuses the shapes a dot would otherwise smuggle in', () => {
    for (const name of ['.', '..ab', '.a', 'ab', 'no.dot.inside', 'has space', '.has space', '']) {
      assert.ok(!MINECRAFT_USERNAME_PATTERN.test(name), `${name} should be refused`);
    }
  });

  it('separates the two identity namespaces', () => {
    assert.ok(isBedrockUsername('.Gamertag'));
    assert.ok(!isBedrockUsername('Notch'));
    assert.equal(bedrockIdentityFor('.GamerTag'), 'bedrock:.gamertag');
  });

  it('gives one Bedrock player one identity whichever flow they arrive through', () => {
    // The chat-code flow sees a real Floodgate UUID; the payment flow never can. Storing the UUID
    // here would hand the same person two accounts, so the name wins on both paths.
    const signed = 'mc:00000000000000000009000000000001';
    assert.equal(platformIdentityFor('.GamerTag', signed), 'bedrock:.gamertag');
    assert.equal(platformIdentityFor('Notch', signed), signed);
  });

  it('resolves a Bedrock name without asking Mojang about an account it cannot have', async () => {
    // No network is stubbed here on purpose: if this reached fetch, the test would hang or throw
    // rather than return, which is exactly the regression worth catching.
    const account = await resolveMinecraftAccount('.GamerTag');
    assert.deepEqual(account, { identity: 'bedrock:.gamertag', username: '.GamerTag' });
  });

  it('still refuses a malformed name before any lookup', async () => {
    await assert.rejects(() => resolveMinecraftAccount('..nope'), /Invalid Minecraft username/);
  });
});
