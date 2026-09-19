import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { Bot } from 'mineflayer';
import type { Logger } from 'pino';
import type { ApiClient, DepositLease, WithdrawalBotJob } from '../src/api-client.js';
import { loadBotConfig } from '../src/config.js';
import type { DepositTransferRequest, TransferAdapter } from '../src/transfer-adapter.js';
import { MinecraftWorker } from '../src/worker.js';

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

type WorkerHarness = {
  bot: Bot | undefined;
  snapshotHealthy: boolean;
  inventoryRevision: number;
  transferring: boolean;
  connectionController: AbortController | undefined;
  handleVerifiedPlayerCommand(
    username: string,
    identity: string,
    rawMessage: string,
  ): Promise<void>;
  pollJobs(): Promise<void>;
  pendingPayout:
    | { payee: string; settle: (receipt: { payee: string; displayedAmount: string }) => void }
    | undefined;
  payoutConfirmMs: number;
  snapshot(): Promise<void>;
  invalidateSnapshotState(): void;
  finishTransferReconciliation(): Promise<void>;
};

function validLease(offsetMs = 150_000): DepositLease {
  return {
    leaseId: '20000000-0000-4000-8000-000000000001',
    depositId: '30000000-0000-4000-8000-000000000001',
    leaseToken: 'ab'.repeat(32),
    expiresAt: new Date(Date.now() + offsetMs).toISOString(),
  };
}

function createHarness(
  api: ApiClient,
  transfers: TransferAdapter,
  logOverrides: Partial<Logger> = {},
): {
  harness: WorkerHarness;
  whispers: string[];
  reconciliationCount: () => number;
} {
  const whispers: string[] = [];
  const bot = {
    entity: {},
    currentWindow: null,
    inventory: {
      craftingResultSlot: -1,
      selectedItem: null,
      slots: Array.from({ length: 36 }, () => null),
    },
    whisper: (_username: string, message: string) => whispers.push(message),
  } as unknown as Bot;
  const log = {
    info: () => undefined,
    warn: () => undefined,
    fatal: () => undefined,
    error: () => undefined,
    ...logOverrides,
  } as unknown as Logger;
  const worker = new MinecraftWorker(loadBotConfig(environment), api, transfers, log);
  const harness = worker as unknown as WorkerHarness;
  harness.bot = bot;
  harness.snapshotHealthy = true;
  harness.connectionController = new AbortController();
  let reconciliations = 0;
  harness.finishTransferReconciliation = async () => {
    reconciliations += 1;
    harness.transferring = false;
    harness.snapshotHealthy = false;
  };
  return { harness, whispers, reconciliationCount: () => reconciliations };
}

function withdrawalNotUsed(): Promise<void> {
  throw new Error('unexpected withdrawal');
}

describe('lease-bound deposit worker', () => {
  it('takes the mutex before authorization and sends an exact lease-bound receipt', async () => {
    const lease = validLease();
    let harness: WorkerHarness;
    let transferRequest: DepositTransferRequest | undefined;
    let confirmation: unknown[] | undefined;
    const api = {
      authorizeDeposit: async () => {
        assert.equal(harness.transferring, true);
        return lease;
      },
      confirmDeposit: async (...parameters: unknown[]) => {
        confirmation = parameters;
      },
    } as unknown as ApiClient;
    const transfers: TransferAdapter = {
      reviewedCapability: true,
      beginDeposit: async (_bot, request, signal) => {
        transferRequest = request;
        assert.equal(signal.aborted, false);
        return {
          outcome: 'confirmed',
          items: [{ fingerprint: 'cd'.repeat(32), quantity: 2 }],
        };
      },
      executeWithdrawal: withdrawalNotUsed,
    };
    const created = createHarness(api, transfers);
    harness = created.harness;

    await harness.handleVerifiedPlayerCommand(
      'PlayerOne',
      `mc:${'a'.repeat(32)}`,
      'deposit ABCDEFGHJKMN',
    );

    assert.equal(transferRequest?.lease, lease);
    assert.equal(transferRequest?.depositCode, 'ABCDEFGHJKMN');
    assert.ok((transferRequest?.operationDeadlineEpochMs ?? 0) > Date.now());
    assert.deepEqual(confirmation, [
      'ABCDEFGHJKMN',
      'PlayerOne',
      `mc:${'a'.repeat(32)}`,
      lease,
      [{ fingerprint: 'cd'.repeat(32), quantity: 2 }],
    ]);
    assert.equal(created.reconciliationCount(), 1);
    assert.equal(harness.transferring, false);
    assert.match(created.whispers.at(-1) ?? '', /deposit confirmed/i);
  });

  it('refuses a stale or too-short lease before invoking the adapter', async () => {
    let adapterCalls = 0;
    let confirmations = 0;
    const api = {
      authorizeDeposit: async () => validLease(25_000),
      confirmDeposit: async () => {
        confirmations += 1;
      },
    } as unknown as ApiClient;
    const transfers: TransferAdapter = {
      reviewedCapability: true,
      beginDeposit: async () => {
        adapterCalls += 1;
        return { outcome: 'confirmed', items: [] };
      },
      executeWithdrawal: withdrawalNotUsed,
    };
    const created = createHarness(api, transfers);

    await created.harness.handleVerifiedPlayerCommand(
      'PlayerOne',
      `mc:${'a'.repeat(32)}`,
      'deposit ABCDEFGHJKMN',
    );

    assert.equal(adapterCalls, 0);
    assert.equal(confirmations, 0);
    assert.equal(created.reconciliationCount(), 1);
    assert.match(created.whispers.at(-1) ?? '', /authorization expired/i);
  });

  it('serializes concurrent deposit commands before either can obtain another lease', async () => {
    let authorizationCalls = 0;
    let releaseAuthorization: ((value: null) => void) | undefined;
    let markAuthorizationStarted: (() => void) | undefined;
    const authorizationStarted = new Promise<void>((resolve) => {
      markAuthorizationStarted = resolve;
    });
    const authorizationResult = new Promise<null>((resolve) => {
      releaseAuthorization = resolve;
    });
    const api = {
      authorizeDeposit: async () => {
        authorizationCalls += 1;
        markAuthorizationStarted?.();
        return authorizationResult;
      },
    } as unknown as ApiClient;
    const transfers: TransferAdapter = {
      reviewedCapability: true,
      beginDeposit: async () => {
        throw new Error('unexpected transfer');
      },
      executeWithdrawal: withdrawalNotUsed,
    };
    const created = createHarness(api, transfers);

    const first = created.harness.handleVerifiedPlayerCommand(
      'PlayerOne',
      `mc:${'a'.repeat(32)}`,
      'deposit ABCDEFGHJKMN',
    );
    await authorizationStarted;
    await created.harness.handleVerifiedPlayerCommand(
      'PlayerTwo',
      `mc:${'b'.repeat(32)}`,
      'deposit ZYXWVUTSRQPN',
    );
    assert.equal(authorizationCalls, 1);
    assert.match(created.whispers.at(-1) ?? '', /custody bot is busy/i);
    releaseAuthorization?.(null);
    await first;
    assert.equal(created.reconciliationCount(), 1);
  });

  it('treats adapter exceptions and malformed confirmed items as ambiguous', async () => {
    for (const beginDeposit of [
      async () => {
        throw new Error('transport disconnected');
      },
      async () => ({
        outcome: 'confirmed' as const,
        items: [
          { fingerprint: 'cd'.repeat(32), quantity: 1 },
          { fingerprint: 'cd'.repeat(32), quantity: 1 },
        ],
      }),
    ]) {
      let confirmations = 0;
      let fatalLogs = 0;
      const api = {
        authorizeDeposit: async () => validLease(),
        confirmDeposit: async () => {
          confirmations += 1;
        },
      } as unknown as ApiClient;
      const transfers: TransferAdapter = {
        reviewedCapability: true,
        beginDeposit,
        executeWithdrawal: withdrawalNotUsed,
      };
      const created = createHarness(api, transfers, {
        fatal: (() => {
          fatalLogs += 1;
        }) as Logger['fatal'],
      });

      await created.harness.handleVerifiedPlayerCommand(
        'PlayerOne',
        `mc:${'a'.repeat(32)}`,
        'deposit ABCDEFGHJKMN',
      );

      assert.equal(confirmations, 0);
      assert.equal(fatalLogs, 1);
      assert.equal(created.reconciliationCount(), 1);
      assert.match(created.whispers.at(-1) ?? '', /being reviewed/i);
    }
  });

  it('does not let an old connection snapshot make a replacement session healthy', async () => {
    let releaseSnapshot: (() => void) | undefined;
    let markSnapshotStarted: (() => void) | undefined;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    const snapshotResponse = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const api = {
      sendEvent: async () => {
        markSnapshotStarted?.();
        await snapshotResponse;
      },
    } as unknown as ApiClient;
    const transfers: TransferAdapter = {
      reviewedCapability: true,
      beginDeposit: async () => ({ outcome: 'cancelled', reasonCode: 'NOT_USED' }),
      executeWithdrawal: withdrawalNotUsed,
    };
    const created = createHarness(api, transfers);
    const oldConnection = created.harness.connectionController;
    const pendingSnapshot = created.harness.snapshot();
    await snapshotStarted;

    oldConnection?.abort();
    created.harness.invalidateSnapshotState();
    created.harness.bot = {
      entity: {},
      currentWindow: null,
      inventory: {
        craftingResultSlot: -1,
        selectedItem: null,
        slots: Array.from({ length: 36 }, () => null),
      },
      whisper: () => undefined,
    } as unknown as Bot;
    created.harness.connectionController = new AbortController();
    releaseSnapshot?.();
    await pendingSnapshot;

    assert.equal(created.harness.snapshotHealthy, false);
  });

  it('rejects a withdrawal lease when inventory state changes while claim is awaiting', async () => {
    const job: WithdrawalBotJob = {
      id: '40000000-0000-4000-8000-000000000001',
      kind: 'withdrawal',
      reference_id: '50000000-0000-4000-8000-000000000001',
      leaseToken: 'ef'.repeat(32),
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      payload: {
        withdrawalId: '50000000-0000-4000-8000-000000000001',
        player: 'PlayerOne',
        playerIdentity: `mc:${'a'.repeat(32)}`,
        deliveryCodeHash: '12'.repeat(32),
        items: [
          {
            fingerprint: 'cd'.repeat(32),
            minecraftName: 'minecraft:stone',
            displayName: 'Stone',
            quantity: 1,
          },
        ],
      },
    };
    let releaseClaim: ((job: WithdrawalBotJob) => void) | undefined;
    let markClaimStarted: (() => void) | undefined;
    const claimStarted = new Promise<void>((resolve) => {
      markClaimStarted = resolve;
    });
    const claimResult = new Promise<WithdrawalBotJob>((resolve) => {
      releaseClaim = resolve;
    });
    let completion: unknown[] | undefined;
    const api = {
      claimJob: async () => {
        markClaimStarted?.();
        return claimResult;
      },
      completeJob: async (...parameters: unknown[]) => {
        completion = parameters;
      },
    } as unknown as ApiClient;
    let withdrawalCalls = 0;
    const transfers: TransferAdapter = {
      reviewedCapability: true,
      beginDeposit: async () => ({ outcome: 'cancelled', reasonCode: 'NOT_USED' }),
      executeWithdrawal: async () => {
        withdrawalCalls += 1;
      },
    };
    const created = createHarness(api, transfers);

    const polling = created.harness.pollJobs();
    await claimStarted;
    created.harness.invalidateSnapshotState();
    releaseClaim?.(job);
    await polling;

    assert.equal(withdrawalCalls, 0);
    assert.deepEqual(completion, [
      job,
      'failed',
      { retryable: true, errorCode: 'BOT_STATE_CHANGED_DURING_CLAIM' },
    ]);
    assert.equal(created.harness.snapshotHealthy, false);
  });
});

/* ── cash payouts ──
 *
 * These exist because a real payout sat queued indefinitely while the bot looked healthy in every
 * visible way. The claim gate required a healthy inventory snapshot, which a cash payout can never
 * affect and which an unreachable API is enough to invalidate. */

const payoutJob = {
  id: '50000000-0000-4000-8000-000000000005',
  kind: 'cash_payout' as const,
  reference_id: '60000000-0000-4000-8000-000000000006',
  payload: {
    withdrawalId: '60000000-0000-4000-8000-000000000006',
    payee: 'q9w',
    amountMinor: '100000',
  },
  leaseToken: 'cd'.repeat(32),
  leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
};

/**
 * Runs one poll and answers it the way the server would.
 *
 * `displayed` is what DonutSMP echoes back — abbreviated, as it really is. Passing null answers
 * with silence, which is the case where the bot must refuse to call a payout done.
 */
async function runPayout(harness: WorkerHarness, displayed: string | null): Promise<void> {
  /* A REF'D timer for the duration, which is the whole point of this function.
   *
   * The worker's confirmation timeout is unref'd so a pending payout cannot hold the process open
   * at shutdown. That means it only fires while something else keeps the event loop alive — a real
   * bot always has a socket; a test waiting on nothing else does not. Without this the `displayed
   * === null` case has no pending work at all once pollJobs parks, node exits, and the runner
   * reports "Promise resolution is still pending but the event loop has already resolved" and
   * cancels every sibling test with it.
   *
   * It passed locally anyway, because other suites in the same process happened to keep the loop
   * busy. That is luck, not a passing test, and CI ran it on a quieter loop and said so. */
  const keepAlive = setInterval(() => undefined, 20);
  try {
    const poll = harness.pollJobs();
    /* Generous, because this waits on real async work and a loaded runner is slower than a laptop.
     * Overshooting costs nothing: the loop exits as soon as pendingPayout appears. */
    for (let tick = 0; tick < 500 && !harness.pendingPayout; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (displayed !== null) {
      harness.pendingPayout?.settle({ payee: 'q9w', displayedAmount: displayed });
    }
    await poll;
  } finally {
    clearInterval(keepAlive);
  }
}

function payoutHarness(api: ApiClient): { harness: WorkerHarness; chats: string[] } {
  const chats: string[] = [];
  const bot = {
    entity: {},
    currentWindow: null,
    inventory: {
      craftingResultSlot: -1,
      selectedItem: null,
      slots: Array.from({ length: 36 }, () => null),
    },
    whisper: () => undefined,
    chat: (message: string) => chats.push(message),
  } as unknown as Bot;
  const log = {
    info: () => undefined,
    warn: () => undefined,
    fatal: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
  const transfers = {
    reviewedCapability: false,
    beginDeposit: async () => ({ outcome: 'cancelled' as const, reasonCode: 'UNUSED' }),
    executeWithdrawal: withdrawalNotUsed,
  } as unknown as TransferAdapter;
  const worker = new MinecraftWorker(loadBotConfig(environment), api, transfers, log);
  const harness = worker as unknown as WorkerHarness;
  harness.bot = bot;
  harness.connectionController = new AbortController();
  /* Milliseconds, not the production eight seconds. The unconfirmed-payout case has to actually
   * wait this out, and nothing is learned by waiting eight seconds to learn it. */
  harness.payoutConfirmMs = 25;
  return { harness, chats };
}

describe('cash payout worker', () => {
  it('pays even when the inventory snapshot is unhealthy', async () => {
    let completed: { outcome: string; options: { errorCode?: string } | undefined } | undefined;
    const api = {
      claimJob: async () => payoutJob,
      completeJob: async (_job: unknown, outcome: string, options?: { errorCode?: string }) => {
        completed = { outcome, options };
      },
    } as unknown as ApiClient;

    const { harness, chats } = payoutHarness(api);
    // The exact state that stalled a real payout: connected, paying attention, no usable snapshot.
    harness.snapshotHealthy = false;

    await runPayout(harness, '100K');

    assert.deepEqual(chats, ['/pay q9w 100000']);
    assert.equal(completed?.outcome, 'completed');
  });

  it('pays with a window open, because a chat command cannot touch an inventory', async () => {
    /* DonutSMP and servers like it pop a menu on join. currentWindow being truthy used to stop the
     * bot asking for ANY job, so a payout queued behind a GUI nobody closed. */
    const api = {
      claimJob: async () => payoutJob,
      completeJob: async () => undefined,
    } as unknown as ApiClient;

    const { harness, chats } = payoutHarness(api);
    harness.snapshotHealthy = false;
    (harness.bot as unknown as { currentWindow: unknown }).currentWindow = { id: 1 };

    await runPayout(harness, '100K');

    assert.deepEqual(chats, ['/pay q9w 100000']);
  });

  it('polls for jobs regardless of the item-transfer flag', async () => {
    /* A source assertion, because the scheduling happens on spawn and this harness does not
     * simulate one. It is worth having anyway: cash payouts share the job queue with item work,
     * and gating the poll on BOT_TRANSFERS_ENABLED left every payout queued on a deployment that
     * deliberately runs with item transfers off, with nothing anywhere reporting a problem. */
    const source = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const spawn = source.slice(
      source.indexOf("'Mineflayer bot spawned'"),
      source.indexOf("bot.on('windowOpen'"),
    );
    assert.ok(spawn.length > 0, 'could not locate the spawn handler');
    assert.match(spawn, /this\.schedule\(\(\) => this\.run\(this\.pollJobs\(\)/);
    assert.doesNotMatch(spawn, /if \(this\.config\.transfersEnabled\)/);
  });

  it('sends the amount as written rather than through a number', async () => {
    // Balances here run past 2^53, and a payout that rounds is a payout of the wrong figure.
    const big = {
      ...payoutJob,
      payload: { ...payoutJob.payload, amountMinor: '9007199254740993' },
    };
    const api = {
      claimJob: async () => big,
      completeJob: async () => undefined,
    } as unknown as ApiClient;

    const { harness, chats } = payoutHarness(api);
    harness.snapshotHealthy = false;
    await runPayout(harness, '9007199254740993');

    assert.deepEqual(chats, ['/pay q9w 9007199254740993']);
  });

  it('refuses to call a payout done when the server never confirms it', async () => {
    /* The case that prompted all of this: a bot without the funds fired /pay, nothing happened,
     * and the withdrawal was marked paid anyway while the player's balance was already gone. */
    let completed: { outcome: string; options: { errorCode?: string } | undefined } | undefined;
    const api = {
      claimJob: async () => payoutJob,
      completeJob: async (_job: unknown, outcome: string, options?: { errorCode?: string }) => {
        completed = { outcome, options };
      },
    } as unknown as ApiClient;

    const { harness } = payoutHarness(api);
    harness.snapshotHealthy = true;

    await runPayout(harness, null);

    assert.equal(completed?.outcome, 'failed');
    assert.equal(completed?.options?.errorCode, 'PAYOUT_UNCONFIRMED');
    // Never PAYOUT_NOT_SENT: the command did reach the server, so refunding could pay twice.
    assert.notEqual(completed?.options?.errorCode, 'PAYOUT_NOT_SENT');
  });

  it('refuses a confirmation that is smaller than what was asked for', async () => {
    /* A bot with part of the money pays part of it. The abbreviation "50K" stands for
     * [50000, 51000), which cannot contain the 100000 that was requested. */
    let completed: { outcome: string; options: { errorCode?: string } | undefined } | undefined;
    const api = {
      claimJob: async () => payoutJob,
      completeJob: async (_job: unknown, outcome: string, options?: { errorCode?: string }) => {
        completed = { outcome, options };
      },
    } as unknown as ApiClient;

    const { harness } = payoutHarness(api);
    harness.snapshotHealthy = true;

    await runPayout(harness, '50K');

    assert.equal(completed?.outcome, 'failed');
    assert.equal(completed?.options?.errorCode, 'PAYOUT_AMOUNT_MISMATCH');
  });

  it('accepts an abbreviation whose interval contains the exact amount', async () => {
    /* 100450 really is "100.4K" on this server, and 100.4K stands for [100400, 100500). Refusing
     * that would send every unrounded payout to manual review. */
    let completed: { outcome: string; options: { errorCode?: string } | undefined } | undefined;
    const job = { ...payoutJob, payload: { ...payoutJob.payload, amountMinor: '100450' } };
    const api = {
      claimJob: async () => job,
      completeJob: async (_job: unknown, outcome: string, options?: { errorCode?: string }) => {
        completed = { outcome, options };
      },
    } as unknown as ApiClient;

    const { harness } = payoutHarness(api);
    harness.snapshotHealthy = true;

    await runPayout(harness, '100.4K');

    assert.equal(completed?.outcome, 'completed');
  });

  it('reports PAYOUT_NOT_SENT, not a guess, when the connection dies before the command', async () => {
    let completed:
      | { outcome: string; options: { errorCode?: string; retryable?: boolean } | undefined }
      | undefined;
    let harness: WorkerHarness;
    const api = {
      claimJob: async () => {
        // The socket goes between claiming the job and writing to it.
        harness.connectionController?.abort();
        return payoutJob;
      },
      completeJob: async (
        _job: unknown,
        outcome: string,
        options?: { errorCode?: string; retryable?: boolean },
      ) => {
        completed = { outcome, options };
      },
    } as unknown as ApiClient;

    const created = payoutHarness(api);
    harness = created.harness;
    harness.snapshotHealthy = true;

    await harness.pollJobs();

    assert.deepEqual(created.chats, [], 'nothing may be sent on a dead connection');
    assert.equal(completed?.outcome, 'failed');
    // Only this code refunds on the gateway side, so it must mean "the server never saw it".
    assert.equal(completed?.options?.errorCode, 'PAYOUT_NOT_SENT');
    assert.equal(completed?.options?.retryable, false);
  });
});
