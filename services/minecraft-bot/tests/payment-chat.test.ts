import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeSystemChat,
  parsePaymentMessage,
  parsePaymentNotice,
} from '../src/payment-chat.js';

/* The log written after a payout has to show whatever the server said back. It used to drop
 * one-part messages and the action bar, so an unconfirmed payout logged nothing at all. */
test('describes every shape of server message after a payout', () => {
  const receipt = describeSystemChat({
    content: {
      text: '',
      extra: [
        { text: 'You paid wymiar ', color: 'white' },
        { text: '$ ', color: '#00ff00' },
        { text: '5M', color: 'white' },
      ],
    },
  });
  assert.equal(receipt, 'white:"You paid wymiar " | #00ff00:"$ " | white:"5M"');

  const onePart = describeSystemChat({ content: { text: 'You do not have enough money!', color: 'red' } });
  assert.equal(onePart, 'red:"You do not have enough money!"');

  const actionBar = describeSystemChat({ content: { text: 'Player not found' }, isActionBar: true });
  assert.equal(actionBar, 'actionbar none:"Player not found"');

  assert.equal(describeSystemChat({ content: 'plain words' }), '"plain words"');
  assert.equal(describeSystemChat({ content: { text: '' } }), undefined);
});

/**
 * Every fixture below is a real DonutSMP system_chat packet, captured from the live server by
 * paying the bot. They are kept verbatim: the parser's whole value is matching what the server
 * actually sends, so a hand-written approximation would test the wrong thing.
 */

const paidOne: unknown = {
  content: {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            {
              color: {
                type: 'string',
                value: 'white',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: 'misterofthex paid you ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: '#00FF00',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '$ ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: 'white',
              },
              italic: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '1',
              },
            },
          ],
        },
      },
      text: {
        type: 'string',
        value: '',
      },
    },
  },
  isActionBar: false,
};
const paidTwelveHundred: unknown = {
  content: {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            {
              color: {
                type: 'string',
                value: 'white',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: 'misterofthex paid you ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: '#00FF00',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '$ ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: 'white',
              },
              italic: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '1.2K',
              },
            },
          ],
        },
      },
      text: {
        type: 'string',
        value: '',
      },
    },
  },
  isActionBar: false,
};
const paidNineNineNine: unknown = {
  content: {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            {
              color: {
                type: 'string',
                value: 'white',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: 'misterofthex paid you ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: '#00FF00',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '$ ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: 'white',
              },
              italic: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '999',
              },
            },
          ],
        },
      },
      text: {
        type: 'string',
        value: '',
      },
    },
  },
  isActionBar: false,
};
const paidOneThousand: unknown = {
  content: {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            {
              color: {
                type: 'string',
                value: 'white',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: 'misterofthex paid you ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: '#00FF00',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '$ ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: 'white',
              },
              italic: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '1K',
              },
            },
          ],
        },
      },
      text: {
        type: 'string',
        value: '',
      },
    },
  },
  isActionBar: false,
};
const shardReward: unknown = {
  content: {
    type: 'compound',
    value: {
      extra: {
        type: 'list',
        value: {
          type: 'compound',
          value: [
            {
              color: {
                type: 'string',
                value: 'white',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: 'You earned ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: '#B34BFF',
              },
              obfuscated: {
                type: 'byte',
                value: 0,
              },
              strikethrough: {
                type: 'byte',
                value: 0,
              },
              underlined: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: '1 Shard ',
              },
              bold: {
                type: 'byte',
                value: 0,
              },
              italic: {
                type: 'byte',
                value: 0,
              },
            },
            {
              color: {
                type: 'string',
                value: 'white',
              },
              italic: {
                type: 'byte',
                value: 0,
              },
              text: {
                type: 'string',
                value: 'for playing the server',
              },
            },
          ],
        },
      },
      text: {
        type: 'string',
        value: '',
      },
    },
  },
  isActionBar: false,
};

test('reads an exact payment of 1', () => {
  assert.deepEqual(parsePaymentMessage(paidOne), { payer: 'misterofthex', amount: 1 });
});

test('reads an exact payment of 999, the largest unabbreviated amount', () => {
  assert.deepEqual(parsePaymentMessage(paidNineNineNine), { payer: 'misterofthex', amount: 999 });
});

test('refuses an abbreviated amount rather than guessing what "1.2K" meant', () => {
  // The player actually paid 1234. The message cannot say so, so no amount may be inferred.
  assert.equal(parsePaymentMessage(paidTwelveHundred), undefined);
  assert.deepEqual(parsePaymentNotice(paidTwelveHundred), {
    payer: 'misterofthex',
    displayedAmount: '1.2K',
  });
});

test('refuses "1K" even though the real amount was a round 1000', () => {
  assert.equal(parsePaymentMessage(paidOneThousand), undefined);
  assert.deepEqual(parsePaymentNotice(paidOneThousand), {
    payer: 'misterofthex',
    displayedAmount: '1K',
  });
});

test('ignores an unrelated three-part server message', () => {
  // Same shape as a payment, different currency colour and wording.
  assert.equal(parsePaymentMessage(shardReward), undefined);
});

test('ignores messages that are not payments at all', () => {
  assert.equal(parsePaymentMessage(undefined), undefined);
  assert.equal(parsePaymentMessage(null), undefined);
  assert.equal(parsePaymentMessage({}), undefined);
  assert.equal(parsePaymentMessage({ content: { value: {} } }), undefined);
});

test('accepts the plain untagged component form as well as the NBT form', () => {
  const plain: unknown = {
    isActionBar: false,
    content: {
      text: '',
      extra: [
        { color: 'white', text: 'Notch paid you ' },
        { color: '#00FF00', text: '$ ' },
        { color: 'white', text: '250' },
      ],
    },
  };
  assert.deepEqual(parsePaymentMessage(plain), { payer: 'Notch', amount: 250 });
});

test('refuses a lookalike whose currency segment is not the server green', () => {
  // What a forged message would most plausibly get wrong.
  const forged: unknown = {
    isActionBar: false,
    content: {
      text: '',
      extra: [
        { color: 'white', text: 'Notch paid you ' },
        { color: 'green', text: '$ ' },
        { color: 'white', text: '250' },
      ],
    },
  };
  assert.equal(parsePaymentMessage(forged), undefined);
});

test('refuses an action bar message carrying payment-shaped text', () => {
  const actionBar: unknown = {
    isActionBar: true,
    content: {
      text: '',
      extra: [
        { color: 'white', text: 'Notch paid you ' },
        { color: '#00FF00', text: '$ ' },
        { color: 'white', text: '250' },
      ],
    },
  };
  assert.equal(parsePaymentMessage(actionBar), undefined);
});

/* ── Bedrock payers ──
 *
 * These use the plain component form rather than a captured NBT packet. The dot is the only thing
 * under test: DonutSMP composes a Bedrock receipt exactly as it composes a Java one, and refusing
 * the name would drop the payment silently instead of crediting it. */

test('reads a payment from a Floodgate (Bedrock) player', () => {
  const bedrock: unknown = {
    isActionBar: false,
    content: {
      text: '',
      extra: [
        { color: 'white', text: '.Gamertag paid you ' },
        { color: '#00FF00', text: '$ ' },
        { color: 'white', text: '250' },
      ],
    },
  };
  assert.deepEqual(parsePaymentMessage(bedrock), { payer: '.Gamertag', amount: 250 });
  assert.deepEqual(parsePaymentNotice(bedrock), { payer: '.Gamertag', displayedAmount: '250' });
});

test('reports an abbreviated Bedrock receipt as a notice, same as a Java one', () => {
  const bedrock: unknown = {
    isActionBar: false,
    content: {
      text: '',
      extra: [
        { color: 'white', text: '.Gamertag paid you ' },
        { color: '#00FF00', text: '$ ' },
        { color: 'white', text: '1.2K' },
      ],
    },
  };
  assert.equal(parsePaymentMessage(bedrock), undefined);
  assert.deepEqual(parsePaymentNotice(bedrock), { payer: '.Gamertag', displayedAmount: '1.2K' });
});

test('refuses a name carrying more than the one leading dot Floodgate adds', () => {
  const forged: unknown = {
    isActionBar: false,
    content: {
      text: '',
      extra: [
        { color: 'white', text: '..Gamertag paid you ' },
        { color: '#00FF00', text: '$ ' },
        { color: 'white', text: '250' },
      ],
    },
  };
  assert.equal(parsePaymentMessage(forged), undefined);
  assert.equal(parsePaymentNotice(forged), undefined);
});

test('reads a deposit receipt in billions', () => {
  /* The scale ladder runs to T, but nothing had ever exercised B on the deposit path. A billion
   * arriving as an unparsed notice would be a payment the bot saw and never reported. */
  const billions: unknown = {
    isActionBar: false,
    content: {
      text: '',
      extra: [
        { color: 'white', text: 'q9w paid you ' },
        { color: '#00FF00', text: '$ ' },
        { color: 'white', text: '1.5B' },
      ],
    },
  };
  assert.deepEqual(parsePaymentNotice(billions), { payer: 'q9w', displayedAmount: '1.5B' });
  // Abbreviated, so there is no exact figure to take — the gateway expands the displayed one.
  assert.equal(parsePaymentMessage(billions), undefined);
});
