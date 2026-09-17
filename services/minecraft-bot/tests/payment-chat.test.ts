import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePaymentMessage } from '../src/payment-chat.js';

/**
 * Every fixture below is a real DonutSMP system_chat packet, captured from the live server by
 * paying the bot. They are kept verbatim: the parser's whole value is matching what the server
 * actually sends, so a hand-written approximation would test the wrong thing.
 */

const paidOne: unknown = {
  "content": {
    "type": "compound",
    "value": {
      "extra": {
        "type": "list",
        "value": {
          "type": "compound",
          "value": [
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "misterofthex paid you "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "#00FF00"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "$ "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "italic": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "1"
              }
            }
          ]
        }
      },
      "text": {
        "type": "string",
        "value": ""
      }
    }
  },
  "isActionBar": false
};
const paidTwelveHundred: unknown = {
  "content": {
    "type": "compound",
    "value": {
      "extra": {
        "type": "list",
        "value": {
          "type": "compound",
          "value": [
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "misterofthex paid you "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "#00FF00"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "$ "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "italic": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "1.2K"
              }
            }
          ]
        }
      },
      "text": {
        "type": "string",
        "value": ""
      }
    }
  },
  "isActionBar": false
};
const paidNineNineNine: unknown = {
  "content": {
    "type": "compound",
    "value": {
      "extra": {
        "type": "list",
        "value": {
          "type": "compound",
          "value": [
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "misterofthex paid you "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "#00FF00"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "$ "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "italic": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "999"
              }
            }
          ]
        }
      },
      "text": {
        "type": "string",
        "value": ""
      }
    }
  },
  "isActionBar": false
};
const paidOneThousand: unknown = {
  "content": {
    "type": "compound",
    "value": {
      "extra": {
        "type": "list",
        "value": {
          "type": "compound",
          "value": [
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "misterofthex paid you "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "#00FF00"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "$ "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "italic": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "1K"
              }
            }
          ]
        }
      },
      "text": {
        "type": "string",
        "value": ""
      }
    }
  },
  "isActionBar": false
};
const shardReward: unknown = {
  "content": {
    "type": "compound",
    "value": {
      "extra": {
        "type": "list",
        "value": {
          "type": "compound",
          "value": [
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "You earned "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "#B34BFF"
              },
              "obfuscated": {
                "type": "byte",
                "value": 0
              },
              "strikethrough": {
                "type": "byte",
                "value": 0
              },
              "underlined": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "1 Shard "
              },
              "bold": {
                "type": "byte",
                "value": 0
              },
              "italic": {
                "type": "byte",
                "value": 0
              }
            },
            {
              "color": {
                "type": "string",
                "value": "white"
              },
              "italic": {
                "type": "byte",
                "value": 0
              },
              "text": {
                "type": "string",
                "value": "for playing the server"
              }
            }
          ]
        }
      },
      "text": {
        "type": "string",
        "value": ""
      }
    }
  },
  "isActionBar": false
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
});

test('refuses "1K" even though the real amount was a round 1000', () => {
  assert.equal(parsePaymentMessage(paidOneThousand), undefined);
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
