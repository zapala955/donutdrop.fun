import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Bot } from 'mineflayer';
import type { Logger } from 'pino';
import type { ApiClient, ConnectionRoute } from '../src/api-client.js';
import { loadBotConfig } from '../src/config.js';
import type { TransferAdapter } from '../src/transfer-adapter.js';
import { MinecraftWorker } from '../src/worker.js';

/* The owner switches a bot off in the admin panel to log into its account by hand. DonutSMP lets
 * one session per account in, so the bot has to get out, and then stay out -- not knock every
 * minute and kick the owner -- until it is switched back on. */

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
  stopped: boolean;
  timers: Set<NodeJS.Timeout>;
  pendingPayout: unknown;
  polling: boolean;
  connect(): void;
  openConnection(proxy: unknown): void;
  cycleConnection(reason: string): void;
  checkManualPlay(): Promise<void>;
};

function harness(route: () => ConnectionRoute) {
  const opened: unknown[] = [];
  const cycled: string[] = [];
  const api = { connectionRoute: async () => route() } as unknown as ApiClient;
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
  const transfers = { reviewedCapability: false } as unknown as TransferAdapter;
  const worker = new MinecraftWorker(loadBotConfig(environment), api, transfers, log);
  const h = worker as unknown as Harness;
  h.openConnection = (proxy) => void opened.push(proxy);
  h.cycleConnection = (reason) => void cycled.push(reason);
  const stop = () => {
    h.stopped = true;
    for (const timer of h.timers) clearTimeout(timer);
    h.timers.clear();
  };
  return { h, opened, cycled, stop };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('a bot switched off for manual play', () => {
  it('stays out of the game, asks again later, and logs in once switched back on', async () => {
    let parked = true;
    const { h, opened, stop } = harness(() => ({ proxy: null, parked }));
    try {
      h.connect();
      await settle();
      assert.equal(opened.length, 0, 'it must not log in while switched off');
      assert.equal(h.timers.size, 1, 'it must ask again later rather than give up');

      parked = false;
      h.connect();
      await settle();
      assert.deepEqual(opened, [null]);
    } finally {
      stop();
    }
  });

  it('keeps out when the gateway cannot be reached, if the last answer was "switched off"', async () => {
    let reachable = true;
    const { h, opened, stop } = harness(() => {
      if (!reachable) throw new Error('fetch failed');
      return { proxy: null, parked: true };
    });
    try {
      h.connect();
      await settle();
      reachable = false;
      h.connect();
      await settle();
      assert.equal(opened.length, 0);
    } finally {
      stop();
    }
  });

  it('logs out while in game, but never in the middle of a payout or a job', async () => {
    const { h, cycled, stop } = harness(() => ({ proxy: null, parked: true }));
    try {
      h.bot = { entity: {} } as unknown as Bot;
      h.pendingPayout = { payee: 'Notch' };
      await h.checkManualPlay();
      assert.deepEqual(cycled, [], 'not while a /pay waits for its answer');

      h.pendingPayout = undefined;
      h.polling = true;
      await h.checkManualPlay();
      assert.deepEqual(cycled, [], 'not while a claimed job is being worked');

      h.polling = false;
      await h.checkManualPlay();
      assert.deepEqual(cycled, ['manual play']);
    } finally {
      stop();
    }
  });

  it('stays in game while nobody has switched it off', async () => {
    const { h, cycled, stop } = harness(() => ({ proxy: null, parked: false }));
    try {
      h.bot = { entity: {} } as unknown as Bot;
      await h.checkManualPlay();
      assert.deepEqual(cycled, []);
    } finally {
      stop();
    }
  });
});
