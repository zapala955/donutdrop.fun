import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import type { Bot } from 'mineflayer';
import type { Logger } from 'pino';
import type { ApiClient } from '../src/api-client.js';
import { loadBotConfig } from '../src/config.js';
import { parseCommandCooldown, parsePayoutRefusal } from '../src/payment-chat.js';
import type { TransferAdapter } from '../src/transfer-adapter.js';
import { MinecraftWorker } from '../src/worker.js';

/* A /pay must not be refused by the server's cooldown between commands.
 *
 * 2026-10-10 07:30:13: the bot sent its idle /bal, then a $24M /pay a moment later. DonutSMP
 * answered in red, "You need to wait another 0.25 seconds to execute a command", and did not run
 * the /pay. Nothing confirmed it, so the withdrawal went to an operator as an unknown outcome,
 * though the bot's balance read the same $24,000,000 before and after. */

const environment = {
  NODE_ENV: 'test',
  MINECRAFT_HOST: 'donutsmp.net',
  MINECRAFT_USERNAME: 'bot-account@example.com',
  MINECRAFT_EXPECTED_USERNAME: 'DonutBot',
  MINECRAFT_PROFILES_FOLDER: '/tmp/minecraft-auth',
  BOT_ID: '10000000-0000-4000-8000-000000000001',
  API_INTERNAL_URL: 'http://api:3001/internal/v1/minecraft',
  BOT_WEBHOOK_SECRET: Buffer.alloc(32, 7).toString('base64'),
  BOT_TRANSFERS_ENABLED: 'true',
};

type Harness = {
  bot: Bot | undefined;
  snapshotHealthy: boolean;
  connectionController: AbortController | undefined;
  pollJobs(): Promise<void>;
  requestBalance(): void;
  pendingPayout: { payee: string; settle: (receipt: { payee: string; displayedAmount: string }) => void } | undefined;
  payoutConfirmMs: number;
  lastCommandAt: number;
  balanceReplyUntil: number;
  payoutPreparing: boolean;
  payoutCooldownSeen: boolean;
};

const payoutJob = {
  id: '50000000-0000-4000-8000-000000000005',
  kind: 'cash_payout' as const,
  reference_id: '60000000-0000-4000-8000-000000000006',
  payload: { withdrawalId: '60000000-0000-4000-8000-000000000006', payee: 'Sfouga55', amountMinor: '24000000' },
  leaseToken: 'cd'.repeat(32),
  leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
};

type Completion = { outcome: string; options: { retryable?: boolean; errorCode?: string } | undefined };

function payoutHarness() {
  const chats: { at: number; text: string }[] = [];
  const quits: string[] = [];
  let completed: Completion | undefined;
  const api = {
    claimJob: async () => payoutJob,
    completeJob: async (_job: unknown, outcome: string, options?: Completion['options']) => {
      completed = { outcome, options };
    },
  } as unknown as ApiClient;
  const bot = {
    entity: {},
    currentWindow: null,
    inventory: { craftingResultSlot: -1, selectedItem: null, slots: Array.from({ length: 36 }, () => null) },
    whisper: () => undefined,
    chat: (text: string) => chats.push({ at: Date.now(), text }),
    quit: (reason: string) => quits.push(reason),
  } as unknown as Bot;
  const log = { info: () => undefined, warn: () => undefined, fatal: () => undefined, error: () => undefined } as unknown as Logger;
  const transfers = {
    reviewedCapability: false,
    beginDeposit: async () => ({ outcome: 'cancelled' as const, reasonCode: 'UNUSED' }),
    executeWithdrawal: async () => {
      throw new Error('unexpected withdrawal');
    },
  } as unknown as TransferAdapter;
  const worker = new MinecraftWorker(loadBotConfig(environment), api, transfers, log);
  const harness = worker as unknown as Harness;
  harness.bot = bot;
  harness.snapshotHealthy = true;
  harness.connectionController = new AbortController();
  harness.payoutConfirmMs = 40;
  return { harness, chats, quits, completion: () => completed };
}

/**
 * One poll, answered the way the server would once the /pay is out. Waits on real time rather than
 * on event-loop ticks, because the /pay may now sit out the command gap before it is sent. A ref'd
 * interval keeps the loop alive for the worker's unref'd confirmation timer.
 */
async function runPayout(
  harness: Harness,
  answer: (harness: Harness) => void,
): Promise<void> {
  const keepAlive = setInterval(() => undefined, 20);
  try {
    const poll = harness.pollJobs();
    const deadline = Date.now() + 5_000;
    while (!harness.pendingPayout && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(harness.pendingPayout, 'the /pay was never sent');
    answer(harness);
    await poll;
  } finally {
    clearInterval(keepAlive);
  }
}

const confirm = (harness: Harness) =>
  harness.pendingPayout?.settle({ payee: 'Sfouga55', displayedAmount: '24M' });

describe('a /pay and the server\'s command cooldown', () => {
  it('waits out the gap after the bot\'s last command before sending /pay', async () => {
    const { harness, chats, completion } = payoutHarness();
    const balanceAt = Date.now();
    harness.lastCommandAt = balanceAt; // the idle /bal, just sent
    await runPayout(harness, confirm);
    const pay = chats.find((chat) => chat.text.startsWith('/pay '));
    assert.ok(pay, 'no /pay was sent');
    assert.ok(pay.at - balanceAt >= 1_400, `the /pay went ${pay.at - balanceAt}ms after the last command`);
    assert.equal(completion()?.outcome, 'completed');
  });

  it('waits for a /bal answer that is still due', async () => {
    const { harness, chats } = payoutHarness();
    const started = Date.now();
    harness.balanceReplyUntil = started + 2_000;
    await runPayout(harness, confirm);
    const pay = chats.find((chat) => chat.text.startsWith('/pay '));
    assert.ok(pay && pay.at - started >= 1_900, 'the /pay went inside the /bal reply window');
  });

  it('sends at once when nothing was sent recently', async () => {
    const { harness, chats } = payoutHarness();
    const started = Date.now();
    await runPayout(harness, confirm);
    const pay = chats.find((chat) => chat.text.startsWith('/pay '));
    assert.ok(pay && pay.at - started < 500, 'a payout waited with no command before it');
  });

  it('sends no /bal while a /pay is waiting to go', () => {
    const { harness, chats } = payoutHarness();
    harness.payoutPreparing = true;
    harness.requestBalance();
    assert.deepEqual(chats, [], 'a /bal was sent in front of a waiting /pay');
  });

  it('reports a /pay the cooldown refused as not sent and retryable, without reconnecting', async () => {
    const { harness, completion, quits } = payoutHarness();
    await runPayout(harness, (h) => {
      h.payoutCooldownSeen = true; // the red line arrived; no confirmation follows
    });
    assert.equal(completion()?.outcome, 'failed');
    assert.equal(completion()?.options?.errorCode, 'PAYOUT_NOT_SENT');
    assert.equal(completion()?.options?.retryable, true);
    assert.deepEqual(quits, [], 'it reconnected a connection that had just answered');
  });

  it('still calls it paid when a confirmation arrives despite a cooldown line', async () => {
    const { harness, completion } = payoutHarness();
    await runPayout(harness, (h) => {
      h.payoutCooldownSeen = true;
      confirm(h);
    });
    assert.equal(completion()?.outcome, 'completed');
  });

  it('keeps silence with no cooldown line an unknown outcome for a human', async () => {
    const { harness, completion } = payoutHarness();
    await runPayout(harness, () => undefined);
    assert.equal(completion()?.options?.errorCode, 'PAYOUT_UNCONFIRMED');
    assert.notEqual(completion()?.options?.retryable, true);
  });
});

test('recognises the server\'s command cooldown line, and nothing like it', () => {
  // As logged from the live server: one red part.
  const logged = { content: { text: 'You need to wait another 0.25 seconds to execute a command', color: 'red' } };
  assert.equal(parseCommandCooldown(logged), true);
  assert.equal(
    parseCommandCooldown({
      content: {
        type: 'compound',
        value: {
          text: { type: 'string', value: 'You need to wait another 1 second to execute a command.' },
          color: { type: 'string', value: 'red' },
        },
      },
    }),
    true,
  );
  // Not red; a player typing it; other red errors; a refusal for funds.
  assert.equal(parseCommandCooldown({ content: { text: 'You need to wait another 0.25 seconds to execute a command', color: 'white' } }), false);
  assert.equal(
    parseCommandCooldown({
      content: { text: '', extra: [{ text: 'Steve: ', color: 'gray' }, { text: 'You need to wait another 0.25 seconds to execute a command', color: 'red' }] },
    }),
    false,
  );
  assert.equal(parseCommandCooldown({ content: { text: 'Player not found', color: 'red' } }), false);
  assert.equal(parseCommandCooldown({ content: { text: "You don't have enough funds to do this", color: 'red' } }), false);
  assert.equal(parseCommandCooldown(null), false);
  // And the funds refusal still reads as before.
  assert.equal(parsePayoutRefusal({ content: { text: "You don't have enough funds to do this", color: 'red' } }), 'insufficient_funds');
});
