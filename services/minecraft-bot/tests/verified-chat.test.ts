import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseVerifiedPlayerChat } from '../src/verified-chat.js';

describe('verified Minecraft player chat', () => {
  it('accepts only a protocol-verified sender UUID and plain content', () => {
    assert.deepEqual(
      parseVerifiedPlayerChat({
        sender: '12345678-1234-4234-9234-123456789abc',
        plainMessage: 'link ABCDEFGHJK',
        formattedMessage: 'Victim whispers to you: link ABCDEFGHJK',
        verified: true,
      }),
      {
        identity: 'mc:12345678123442349234123456789abc',
        message: 'link ABCDEFGHJK',
        normalizedUuid: '12345678123442349234123456789abc',
      },
    );
  });

  it('rejects spoofable system, formatted, and unsigned chat', () => {
    for (const packet of [
      {
        sender: '12345678-1234-4234-9234-123456789abc',
        plainMessage: 'link ABCDEFGHJK',
        verified: false,
      },
      {
        sender: null,
        formattedMessage: 'Victim whispers to you: link ABCDEFGHJK',
        verified: true,
      },
      {
        sender: '12345678-1234-4234-9234-123456789abc',
        formattedMessage: 'Victim whispers to you: link ABCDEFGHJK',
        verified: true,
      },
    ]) {
      assert.equal(parseVerifiedPlayerChat(packet), undefined);
    }
  });
});
