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

/* The server refusing the bot's own /pay. Logged from the live server as
 * red:"You don't have enough funds to do this" after every short payout of 2026-09-28..30. */
test('recognises the server refusing a payout for funds, and nothing else', async () => {
  const { parsePayoutRefusal } = await import('../src/payment-chat.js');
  const tagged = (text: string, color: string) => ({
    content: {
      type: 'compound',
      value: { text: { type: 'string', value: text }, color: { type: 'string', value: color } },
    },
  });

  assert.equal(parsePayoutRefusal({ content: { text: "You don't have enough funds to do this", color: 'red' } }), 'insufficient_funds');
  assert.equal(parsePayoutRefusal(tagged("You don't have enough funds to do this", 'red')), 'insufficient_funds');
  // Root left empty with the words in one red part; a curly apostrophe; a trailing full stop.
  assert.equal(
    parsePayoutRefusal({ content: { text: '', extra: [{ text: 'You don\u2019t have enough funds to do this.', color: 'red' }] } }),
    'insufficient_funds',
  );

  // Not red: not the server's error line.
  assert.equal(parsePayoutRefusal({ content: { text: "You don't have enough funds to do this", color: 'white' } }), undefined);
  // A player typing the words arrives with a name in front of them.
  assert.equal(
    parsePayoutRefusal({ content: { text: '', extra: [{ text: 'Steve: ', color: 'gray' }, { text: "You don't have enough funds to do this", color: 'red' }] } }),
    undefined,
  );
  // Other red errors are not a refusal for funds.
  assert.equal(parsePayoutRefusal({ content: { text: 'Player not found', color: 'red' } }), undefined);
  assert.equal(parsePayoutRefusal({ content: "You don't have enough funds to do this" }), undefined);
  assert.equal(parsePayoutRefusal(null), undefined);
});

/* /bal, now the only way a bot learns what it holds (DonutSMP switched its stats API off). The
 * exact wording was never captured, so the reader is tested against every plausible shape and
 * against the lookalikes it must refuse. */
test('reads the balance from the reply to /bal, and refuses anything ambiguous', async () => {
  const { parseBalanceReply } = await import('../src/payment-chat.js');
  const parts = (...texts: Array<[string, string]>) => ({
    content: { text: '', extra: texts.map(([text, color]) => ({ text, color })) },
  });

  // The receipt's own styling: white words, a green "$ ", a white abbreviated figure.
  const abbreviated = parseBalanceReply(parts(['Your balance is ', 'white'], ['$ ', '#00ff00'], ['1.97M', 'white']));
  assert.deepEqual(abbreviated, { displayed: '$1.97M', low: 1_970_000n, step: 10_000n });
  // One plain line, exact with cents (dropped: the platform counts whole dollars).
  assert.deepEqual(parseBalanceReply({ content: { text: 'Balance: $1,234,567.89', color: 'gold' } }), {
    displayed: '$1,234,567.89',
    low: 1_234_567n,
    step: 1n,
  });
  assert.deepEqual(parseBalanceReply({ content: 'You have $250K' }), { displayed: '$250K', low: 250_000n, step: 1_000n });
  assert.deepEqual(parseBalanceReply({ content: 'Your balance is $0' }), { displayed: '$0', low: 0n, step: 1n });
  // NBT-tagged, as current servers send it.
  const tagged = {
    content: {
      type: 'compound',
      value: {
        text: { type: 'string', value: 'Your money: ' },
        extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: '$2B' } }] } },
      },
    },
  };
  assert.deepEqual(parseBalanceReply(tagged), { displayed: '$2B', low: 2_000_000_000n, step: 1_000_000_000n });

  // Lookalikes: payments, refusals, two figures, no figure, no mention of a balance.
  assert.equal(parseBalanceReply(parts(['You paid wymiar ', 'white'], ['$ ', '#00ff00'], ['5M', 'white'])), undefined);
  assert.equal(parseBalanceReply({ content: "You don't have enough funds to do this" }), undefined);
  assert.equal(parseBalanceReply({ content: 'Balance: $1M (bank $2M)' }), undefined);
  assert.equal(parseBalanceReply({ content: 'Your balance is loading' }), undefined);
  assert.equal(parseBalanceReply({ content: 'Steve: sell me $5M of shards' }), undefined);
  assert.equal(parseBalanceReply(null), undefined);
});

test('reads its balance on join, after money moves and only now and then otherwise, and reports it on the heartbeat', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
  // Sent through sendCommand, which every command uses so a /pay can keep clear of it.
  assert.match(source, /this\.sendCommand\(bot, '\/bal'\);/);
  /* Never on a fixed clock. The vault account was banned for botting after two days of /bal every
   * 120 seconds exactly; the idle read is a fresh random gap of at least twenty minutes. */
  assert.doesNotMatch(source, /this\.schedule\(\(\) => this\.requestBalance\(\)/);
  assert.match(source, /const BALANCE_IDLE_MIN_MS = 20 \* 60_000;/);
  assert.match(source, /BALANCE_IDLE_MIN_MS \+ Math\.floor\(Math\.random\(\) \* \(BALANCE_IDLE_MAX_MS - BALANCE_IDLE_MIN_MS\)\)/);
  assert.match(source, /this\.scheduleIdleBalance\(\);/);
  // Never while a /pay waits for its answer, nor while one waits to be sent.
  const request = source.slice(source.indexOf('private requestBalance(): void {'));
  assert.match(
    request.slice(0, 600),
    /if \(this\.pendingPayout \|\| this\.payoutPreparing \|\| this\.transferring\)/,
  );
  // Only inside its own window, and logged verbatim whether or not it was understood.
  assert.match(source, /if \(Date\.now\(\) < this\.balanceReplyUntil\) \{/);
  assert.match(source, /'system chat after \/bal'/);
  // Carried on the heartbeat, and dropped with the session it described.
  assert.match(source, /lowMinor: balance\.low\.toString\(\),/);
  assert.match(source, /this\.balanceTimer = undefined;\s+this\.balanceReplyUntil = 0;\s+this\.observedBalance = undefined;/);
});
