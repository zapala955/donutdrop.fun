import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import mineflayer from 'mineflayer';
import type { Logger } from 'pino';
import type { ApiClient } from '../src/api-client.js';
import { loadBotConfig } from '../src/config.js';
import type { TransferAdapter } from '../src/transfer-adapter.js';
import { authServiceRetryMs, isAuthRateLimit, isAuthServiceKick, MinecraftWorker } from '../src/worker.js';

/* 2026-11-03 to 11-05: about one login in nine failed at Mojang's login service, nearly always on a
 * routine relog, and each then waited the five minutes meant for the server refusing the account.
 * These retry soon. Everything the server itself decides keeps the wait it had. */

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

/* Word for word what DonutSMP and the login library said in wymiar's log. */
const AUTH_DOWN = 'multiplayer.disconnect.authservers_down';
const NOT_LOGGED_IN =
  'You are not logged into your Minecraft account. If you are logged into your Minecraft account, try restarting your Minecraft client.';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

type Harness = {
  connect(): void;
  openConnection(proxy: unknown): void;
};

/** A worker on a fake bot, its logins counted, and each session's events ready to emit. */
function session() {
  const bots: EventEmitter[] = [];
  mock.method(mineflayer, 'createBot', () => {
    const bot = Object.assign(new EventEmitter(), { _client: new EventEmitter() });
    bots.push(bot);
    return bot;
  });
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
  const worker = new MinecraftWorker(
    loadBotConfig(environment),
    {} as unknown as ApiClient,
    { reviewedCapability: false } as unknown as TransferAdapter,
    log,
  );
  const h = worker as unknown as Harness;
  let logins = 0;
  h.connect = () => {
    logins += 1;
  };
  h.openConnection(null);
  return { h, bots, logins: () => logins };
}

/** How long a session ending this way keeps the bot out: the tick on which it asks to log in again. */
function waitAfter(end: (bot: EventEmitter) => void, s = session()): number {
  const before = s.logins();
  end(s.bots.at(-1)!);
  let waited = 0;
  while (s.logins() === before && waited < 7 * 60 * MINUTE) {
    mock.timers.tick(SECOND);
    waited += SECOND;
  }
  return waited;
}

const kicked = (reason: string, endReason = 'socketClosed') => (bot: EventEmitter) => {
  bot.emit('kicked', reason);
  bot.emit('end', endReason);
};

describe('a login that fails at Mojang', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    mock.method(Math, 'random', () => 0);
  });
  afterEach(() => mock.restoreAll());
  afterEach(() => mock.timers.reset());

  it('tries again in fifteen seconds when the server says the auth servers are down', () => {
    assert.equal(waitAfter(kicked(AUTH_DOWN)), 15 * SECOND);
  });

  it('tries again in fifteen seconds when the server says the account is not logged in', () => {
    assert.equal(waitAfter(kicked(NOT_LOGGED_IN)), 15 * SECOND);
  });

  it("tries again in fifteen seconds when the library's own call to Mojang fails", () => {
    const failed = (bot: EventEmitter) => {
      bot.emit('error', new Error('Internal Server Error'));
      bot.emit('end', 'encryptionLoginError');
    };
    assert.equal(waitAfter(failed), 15 * SECOND);
  });

  it('backs off to five minutes when the failures keep coming', () => {
    const s = session();
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      waits.push(waitAfter(kicked(AUTH_DOWN), s));
      // The next login attempt, which fails the same way.
      s.h.openConnection(null);
    }
    assert.deepEqual(waits, [15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 5 * MINUTE]);
  });

  it('waits the five minutes when Mojang says it is being asked too often', () => {
    const limited = (bot: EventEmitter) => {
      bot.emit('error', new Error('Response is not JSON. Status code: 429'));
      bot.emit('end', 'encryptionLoginError');
    };
    assert.equal(waitAfter(limited), 5 * MINUTE);
  });

  it('forgets a 429 once that session is over', () => {
    const s = session();
    const limited = (bot: EventEmitter) => {
      bot.emit('error', new Error('Response is not JSON. Status code: 429'));
      bot.emit('end', 'encryptionLoginError');
    };
    assert.equal(waitAfter(limited, s), 5 * MINUTE);
    s.h.openConnection(null);
    const failed = (bot: EventEmitter) => {
      bot.emit('error', new Error('Internal Server Error'));
      bot.emit('end', 'encryptionLoginError');
    };
    assert.equal(waitAfter(failed, s), 15 * SECOND);
  });
});

describe('what the server decides keeps the wait it had', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    mock.method(Math, 'random', () => 0);
  });
  afterEach(() => mock.restoreAll());
  afterEach(() => mock.timers.reset());

  it('five minutes for "already online"', () => {
    assert.equal(waitAfter(kicked('You are already online\nYou are connected to proxy: 7eab12058666')), 5 * MINUTE);
  });

  it('five minutes for maintenance', () => {
    assert.equal(waitAfter(kicked('We are under maintenance, please wait a few minutes')), 5 * MINUTE);
  });

  it('five minutes for a login that stalled and closed with no reason', () => {
    assert.equal(waitAfter((bot) => bot.emit('end', 'socketClosed')), 5 * MINUTE);
  });

  it('six hours for a ban', () => {
    assert.equal(waitAfter(kicked('You are banned from this server')), 6 * 60 * MINUTE);
  });
});

describe('telling the kinds of failure apart', () => {
  it('knows the login-service kicks, and nothing else', () => {
    assert.equal(isAuthServiceKick(AUTH_DOWN), true);
    assert.equal(isAuthServiceKick(NOT_LOGGED_IN), true);
    assert.equal(isAuthServiceKick('You are already online'), false);
    assert.equal(isAuthServiceKick('You are banned from this server'), false);
    assert.equal(isAuthServiceKick('We are under maintenance, please wait a few minutes'), false);
    assert.equal(isAuthServiceKick('Server restarting'), false);
  });

  it('knows a rate limit by its status code', () => {
    assert.equal(isAuthRateLimit(new Error('Response is not JSON. Status code: 429')), true);
    assert.equal(isAuthRateLimit(new Error('Internal Server Error')), false);
    assert.equal(isAuthRateLimit(undefined), false);
  });

  it('adds at most five seconds of jitter', () => {
    assert.equal(authServiceRetryMs(0, () => 0), 15 * SECOND);
    assert.equal(authServiceRetryMs(0, () => 0.999), 15 * SECOND + 4_995);
    assert.equal(authServiceRetryMs(99, () => 0), 5 * MINUTE);
  });

  it('starts the back-off over once the bot is in game', async () => {
    const source = (await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const spawn = source.slice(source.indexOf("bot.once('spawn', () => {"));
    assert.match(spawn.slice(0, spawn.indexOf("bot.on('windowOpen'")), /this\.authServiceStreak = 0;/);
  });
});
