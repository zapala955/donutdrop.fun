import assert from 'node:assert/strict';
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
