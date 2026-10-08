import { randomUUID } from 'node:crypto';
import mineflayer, { type Bot, type BotOptions } from 'mineflayer';
import type { Logger } from 'pino';
import type { BotConfig } from './config.js';
import type {
  AdminPayoutBotJob,
  ApiClient,
  BotJob,
  BotProxy,
  CashPayoutBotJob,
  InternalTransferBotJob,
} from './api-client.js';
import { itemFingerprint } from './fingerprint.js';
import { describeRoute, proxiedConnect, TunnelledHttpsAgent } from './proxy.js';
import { parseDepositAttemptResult, type TransferAdapter } from './transfer-adapter.js';
import {
  describeSystemChat,
  displayedAmountBounds,
  parseOutgoingPayment,
  parsePaymentMessage,
  parsePaymentNotice,
  parsePayoutRefusal,
  parseBalanceReply,
  type BalanceReading,
  type OutgoingPayment,
  type PayoutRefusal,
} from './payment-chat.js';
import { parseVerifiedPlayerChat } from './verified-chat.js';

const DEPOSIT_LEASE_SAFETY_MARGIN_MS = 10_000;
const MIN_DEPOSIT_TRANSFER_WINDOW_MS = 20_000;
const MAX_DEPOSIT_TRANSFER_DURATION_MS = 120_000;
/** How long after a payout the server's reply is worth logging. */
const PAYOUT_CHAT_CAPTURE_MS = 8_000;
/** How long to wait for the server to confirm a payout before giving up on knowing. */
const PAYOUT_CONFIRM_MS = 8_000;
/**
 * With no money moving, how long the bot waits before reading its balance again: a random gap
 * between these two, drawn afresh each time.
 *
 * It was a fixed two minutes. On 2026-10-07 the vault account was permanently banned "for
 * botting" after two days of sitting idle and sending /bal every 120.000 seconds around the clock,
 * which is about as mechanical as an account can look. A reading only matters once money has
 * moved, and every movement already triggers its own read a few seconds later; this is the
 * occasional check in between, spread out and irregular.
 */
const BALANCE_IDLE_MIN_MS = 20 * 60_000;
const BALANCE_IDLE_MAX_MS = 40 * 60_000;
/** How long the bot listens for the answer to /bal. */
const BALANCE_REPLY_MS = 5_000;
/** After money moves, read the balance again this long after the last movement. */
const BALANCE_AFTER_MOVE_MS = 4_000;
/**
 * How long the bot stays logged in before it logs out and back in: a random stretch between these
 * two, drawn afresh on every login. A session can go deaf while its socket stays open -- the vault
 * once heard nothing from the server for hours until an operator reconnected it by hand -- and a
 * regular fresh login bounds how long that can last without waiting for a payout to go unanswered.
 */
const RELOG_MIN_MS = 10 * 60_000;
const RELOG_MAX_MS = 30 * 60_000;
/**
 * How long a relog stays logged out. The gateway counts a bot as gone after 45 seconds without a
 * heartbeat; beats go every fifteen, so up to fifteen seconds out plus the login stays inside it
 * and the deposit and login pages never flicker to "no bot online".
 */
const RELOG_OFFLINE_MIN_MS = 6_000;
const RELOG_OFFLINE_MAX_MS = 15_000;
/** While a relog waits for a payout, job or /bal already in flight, how often it looks again. */
const RELOG_RETRY_MS = 2_000;

/** With no route from the gateway yet, how long the bot waits before asking again. */
const ROUTE_RETRY_MS = 10_000;
/** How long a login gets, from opening the connection to spawning, before it is started again. */
const LOGIN_TIMEOUT_MS = 90_000;

/** A whole number of milliseconds in [min, max), drawn uniformly. */
function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

interface JobClaimState {
  readonly bot: Bot;
  readonly connectionController: AbortController;
  readonly inventoryRevision: number;
}

/**
 * How long a banned account waits before trying the server again.
 *
 * A banned account is kicked within two seconds of every attempt. It used to try again ten seconds
 * later, the process then exited with nothing left to keep it alive, Docker restarted it, and the
 * vault account hammered DonutSMP once a minute for a day after it was banned -- from the same
 * address the teller connects from. Once every six hours still notices a lifted ban.
 */
const BANNED_RETRY_MS = 6 * 60 * 60_000;

/** Whether a kick says the account is banned, rather than being an ordinary disconnect. */
export function isBanKick(text: string): boolean {
  return /\bbanned\b/i.test(text);
}

/**
 * Renders a kick reason as something a person can read.
 *
 * The server sends a chat component -- a nested object of text, translate keys and `extra` arrays
 * -- and sometimes that object as a JSON string. `String(reason)` on it produces the literal text
 * "[object Object]", which is what every kick in this log said until now: the one field that
 * explains why the bot cannot stay connected, reliably discarded before it was written down.
 */
export function describeKick(reason: unknown, depth = 0): string {
  if (depth > 8) return '';
  if (typeof reason === 'string') {
    const trimmed = reason.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return describeKick(JSON.parse(trimmed), depth + 1);
      } catch {
        // Not JSON after all; it is already the message.
      }
    }
    return trimmed.slice(0, 500);
  }
  if (Array.isArray(reason)) {
    return reason
      .map((part) => describeKick(part, depth + 1))
      .join('')
      .slice(0, 500);
  }
  if (reason && typeof reason === 'object') {
    const node = reason as Record<string, unknown>;
    let text = '';
    if (typeof node['text'] === 'string') text += node['text'];
    // A translated kick ("multiplayer.disconnect.duplicate_login") carries its key, not its text.
    if (!text && typeof node['translate'] === 'string') text += node['translate'];
    if (node['with'] !== undefined) text += describeKick(node['with'], depth + 1);
    if (node['extra'] !== undefined) text += describeKick(node['extra'], depth + 1);
    if (text.trim()) return text.trim().slice(0, 500);
    /* Nothing recognisable in it. The raw JSON is still infinitely more use than the word
     * "object", so it goes in the log rather than being thrown away. */
    try {
      return JSON.stringify(reason).slice(0, 500);
    } catch {
      return '[unserializable kick reason]';
    }
  }
  return String(reason).slice(0, 500);
}

/**
 * Closes a Minecraft connection whatever state it is in.
 *
 * mineflayer attaches `quit` during login, so a bot that is still connecting does not have one.
 * `end` exists earlier. Trying both means a shutdown cannot leave a socket open behind it.
 */
function closeConnection(bot: Bot, reason: string, onError: (error: unknown) => void): void {
  const handle = bot as unknown as {
    quit?: (reason?: string) => void;
    end?: (reason?: string) => void;
  };
  try {
    if (typeof handle.quit === 'function') {
      handle.quit(reason);
      return;
    }
    if (typeof handle.end === 'function') {
      handle.end(reason);
      return;
    }
    onError(new Error('the connection exposes neither quit() nor end()'));
  } catch (error) {
    onError(error);
  }
}

export class MinecraftWorker {
  private bot: Bot | undefined;
  private stopped = false;
  /** Set when the server kicked this account as banned; the next attempt waits BANNED_RETRY_MS. */
  private banned = false;
  /** The relog timer has gone off; no new job is claimed until the bot has logged out. */
  private relogDue = false;
  /** The current logout is a relog, so the bot comes back after RELOG_OFFLINE_*, not ten seconds. */
  private relogging = false;
  /* A field rather than the bare constant so tests can wait milliseconds, not seconds. */
  private relogRetryMs = RELOG_RETRY_MS;
  /** The gateway's last answer on how to connect, used when it cannot be asked. */
  private knownRoute: { proxy: BotProxy | null } | undefined;
  /** The proxy assignment the current connection was opened with; undefined when direct. */
  private routeRevision: string | undefined;
  private timers = new Set<NodeJS.Timeout>();
  private polling = false;
  private snapshottingBot: Bot | undefined;
  private snapshotHealthy = false;
  private inventoryRevision = 0;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private transferring = false;
  private readonly shutdownController = new AbortController();
  private connectionController: AbortController | undefined;
  private readonly lastPlayerCommandAt = new Map<string, number>();
  private recentCommandTimes: number[] = [];
  private paymentReports: Promise<void> = Promise.resolve();
  /**
   * Last reason the bot declined to ask for work, so a change is logged once, not per tick.
   *
   * Starts at a sentinel rather than undefined, because undefined is also the value meaning
   * "nothing is blocking": initialising to it made the first healthy evaluation a no-op, so the
   * line confirming the bot was asking for work never printed at all.
   */
  private claimBlockReason: string | undefined = 'startup';
  /** While set, system chat is logged verbatim so a payout's server reply can be read back. */
  private payoutChatCaptureUntil = 0;
  /* The bot's balance as /bal last reported it, sent to the gateway on every heartbeat. DonutSMP's
   * stats API is gone, so this is the only place the platform learns what a bot really holds. */
  private observedBalance: (BalanceReading & { observedAt: string }) | undefined;
  private balanceReplyUntil = 0;
  private balanceTimer: NodeJS.Timeout | undefined;
  /** The payout waiting on the server's confirmation, if one is in flight. */
  private pendingPayout:
    | {
        payee: string;
        settle: (receipt: OutgoingPayment) => void;
        refuse: (reason: PayoutRefusal) => void;
      }
    | undefined;
  /* How long to wait for the server to confirm a payout, as a field rather than the bare constant.
   *
   * The timer behind it is unref'd, deliberately: a payout waiting on a confirmation must not hold
   * the process open for eight seconds when somebody asks the bot to shut down. The consequence is
   * that the timer only fires if something ELSE is keeping the event loop alive — true of a running
   * bot, which always has a socket, and not true of a test whose only pending work is this wait.
   * Tests set this to a few milliseconds and hold the loop open themselves. */
  private payoutConfirmMs = PAYOUT_CONFIRM_MS;

  constructor(
    private readonly config: BotConfig,
    private readonly api: ApiClient,
    private readonly transfers: TransferAdapter,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdownController.abort();
    this.connectionController?.abort();
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    if (this.bot) {
      await this.heartbeat(false).catch(() => undefined);
      /* `quit` is attached while the bot finishes logging in, so a worker stopped mid-connect --
       * which is exactly what happens when the server is refusing the connection and the bot is
       * looping on it -- hits `this.bot.quit is not a function` and never closes the socket. An
       * unclosed session is not harmless here: the server can still believe the account is
       * connected, and kick the next attempt as a duplicate login. */
      closeConnection(this.bot, 'Worker shutdown', (error) =>
        this.log.warn({ err: error }, 'could not close the Minecraft connection cleanly'),
      );
    }
  }

  /**
   * Logs in, by the route the gateway has assigned: through this bot's proxy, or directly.
   *
   * The route is asked for before every login, so a proxy set in the console applies from the
   * next one. If the gateway cannot be reached, the last answer it gave is used; with no answer at
   * all the bot does not connect, because guessing "direct" could put a bot that is meant to be
   * behind a proxy on the VPS's own address.
   */
  private connect(): void {
    if (this.stopped) return;
    this.invalidateSnapshotState();
    void this.resolveRoute().then(
      (proxy) => this.openConnection(proxy),
      (error: unknown) => {
        if (this.stopped) return;
        this.log.error(
          { err: error, retryInSeconds: ROUTE_RETRY_MS / 1000 },
          'Could not ask the gateway how to reach the server; not connecting until it answers',
        );
        // Held open, so the process waits here rather than exiting; tracked, so a shutdown clears it.
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.connect();
        }, ROUTE_RETRY_MS);
        this.timers.add(timer);
      },
    );
  }

  private async resolveRoute(): Promise<BotProxy | null> {
    try {
      const proxy = await this.api.connectionRoute();
      this.knownRoute = { proxy };
      return proxy;
    } catch (error) {
      if (!this.knownRoute) throw error;
      this.log.warn(
        { err: error, via: describeRoute(this.knownRoute.proxy) },
        'Could not ask the gateway for the route; using the last one it gave',
      );
      return this.knownRoute.proxy;
    }
  }

  private openConnection(proxy: BotProxy | null): void {
    if (this.stopped) return;
    this.log.info(
      { host: this.config.host, port: this.config.port, via: describeRoute(proxy) },
      'Connecting Mineflayer bot',
    );
    const options: BotOptions = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth,
      ...(this.config.version ? { version: this.config.version } : {}),
      profilesFolder: this.config.profilesFolder,
      hideErrors: true,
      checkTimeoutInterval: 30_000,
      defaultChatPatterns: false,
    };
    if (proxy) {
      options.connect = proxiedConnect(proxy, options);
      options.agent = new TunnelledHttpsAgent(proxy);
    }
    const bot = mineflayer.createBot(options);
    this.routeRevision = proxy?.revision;
    const connectionController = new AbortController();
    this.connectionController = connectionController;
    this.bot = bot;

    /* A login that never finishes is started again. A proxy adds ways to stall before the server is
     * even reached, and a stalled attempt otherwise sits there with no `end` to bring it back.
     * Unref'd: when nothing else is left the process exits and Docker restarts it, as before. */
    const loginWatchdog = setTimeout(() => {
      this.timers.delete(loginWatchdog);
      if (this.bot !== bot || bot.entity) return;
      this.log.warn(
        { via: describeRoute(proxy), afterSeconds: LOGIN_TIMEOUT_MS / 1000 },
        'Login did not finish; starting again',
      );
      closeConnection(bot, 'login timeout', () => undefined);
      bot.emit('end', 'loginTimeout');
    }, LOGIN_TIMEOUT_MS);
    loginWatchdog.unref();
    this.timers.add(loginWatchdog);

    bot.once('spawn', () => {
      clearTimeout(loginWatchdog);
      this.timers.delete(loginWatchdog);
      // A login the watchdog already gave up on, arriving late: the bot has moved on without it.
      if (this.bot !== bot) {
        closeConnection(bot, 'superseded login', () => undefined);
        return;
      }
      if (bot.username.toLowerCase() !== this.config.expectedUsername.toLowerCase()) {
        this.log.fatal(
          { actualUsername: bot.username, expectedUsername: this.config.expectedUsername },
          'Connected Minecraft account does not match bot provisioning',
        );
        bot.quit('Bot identity mismatch');
        return;
      }
      // Mineflayer installs the inventory plugin during connection setup. Accessing
      // `bot.inventory` immediately after createBot can race that initialization.
      bot.inventory.on('updateSlot', () => this.markInventoryDirty());
      // A snapshot from an earlier network session can never authorize custody operations on a
      // respawned session, even if no inventory event was observed during the disconnect.
      this.invalidateSnapshotState();
      this.log.info({ username: bot.username, version: bot.version }, 'Mineflayer bot spawned');
      this.run(this.heartbeat(true), 'heartbeat');
      this.run(this.snapshot(), 'inventory snapshot');
      this.schedule(() => this.run(this.heartbeat(true), 'heartbeat'), 15_000);
      // The balance: once shortly after joining (the server is still sending its join messages
      // straight away), again after every movement of money, and otherwise only now and then.
      this.balanceSoon(8_000);
      this.scheduleIdleBalance();
      this.scheduleRelog();
      this.schedule(() => this.run(this.snapshot(), 'inventory snapshot'), 30_000);
      /* Polled whatever the transfer flag says. BOT_TRANSFERS_ENABLED governs what the bot may do
       * with an ITEM, not whether it may ask for work: cash payouts share this queue and move a
       * number with the server's own /pay. Gating the poll on it meant a deployment with item
       * transfers off — which is every deployment, deliberately — left every payout queued with
       * nobody ever asking for it, and nothing anywhere reporting a problem.
       *
       * Item work stays refused where it was always refused: the adapter throws, the job fails
       * non-retryably, and the withdrawal goes to manual review rather than sitting unseen. */
      this.schedule(() => this.run(this.pollJobs(), 'job poll'), this.config.pollIntervalMs);
    });
    bot.on('windowOpen', () => this.markInventoryDirty());
    bot._client.on('playerChat', (packet: unknown) => {
      const chat = parseVerifiedPlayerChat(packet);
      if (!chat) return;
      const player = Object.values(bot.players).find(
        (candidate) => candidate.uuid.toLowerCase().replaceAll('-', '') === chat.normalizedUuid,
      );
      if (!player || !/^(?:[A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$/.test(player.username)) {
        this.log.warn(
          { senderUuid: chat.normalizedUuid },
          'Ignored verified chat whose sender was absent from the player list',
        );
        return;
      }
      this.run(
        this.handleVerifiedPlayerCommand(player.username, chat.identity, chat.message),
        'verified player command',
      );
    });
    // Cash deposits and login by payment. The structured system-chat message is the source for
    // ordinary deposits; the separate payment-login flow performs its own exact verification.
    bot._client.on('packet', (data: unknown, meta: unknown) => {
      if (packetName(meta) !== 'system_chat') return;
      /* Everything the server says in the seconds after a payout, whether or not this bot can
       * parse it. A payout is not confirmed today — see sendCashPayout — and these lines are how
       * the confirming parser gets written from real wording rather than from a guess. */
      if (Date.now() < this.payoutChatCaptureUntil) {
        const described = describeSystemChat(data);
        if (described) this.log.info({ chat: described }, 'system chat after payout');
      }
      /* The answer to this bot's own /bal. Every line in the window is logged as it arrived, so
       * the server's exact wording is on record whether or not the reader understood it. */
      if (Date.now() < this.balanceReplyUntil) {
        const described = describeSystemChat(data);
        if (described) this.log.info({ chat: described }, 'system chat after /bal');
        const reading = parseBalanceReply(data);
        if (reading) {
          this.balanceReplyUntil = 0;
          this.observedBalance = { ...reading, observedAt: new Date().toISOString() };
          this.log.info(
            { displayed: reading.displayed, low: reading.low.toString(), step: reading.step.toString() },
            'balance read',
          );
          // Straight to the gateway rather than waiting up to fifteen seconds for the next beat.
          this.run(this.heartbeat(true), 'heartbeat');
          return;
        }
      }
      /* The server refusing the payout this bot is waiting on: the money did not move. Read only
       * while a /pay is in flight, which is the only time the message can be about ours. */
      const awaitingAnswer = this.pendingPayout;
      if (awaitingAnswer) {
        const refusal = parsePayoutRefusal(data);
        if (refusal) {
          awaitingAnswer.refuse(refusal);
          return;
        }
      }
      /* The server confirming that this bot paid somebody. Matched before the incoming receipt
       * because the two have the same shape and only the leading text distinguishes them. */
      const outgoing = parseOutgoingPayment(data);
      if (outgoing) {
        const waiting = this.pendingPayout;
        if (waiting && outgoing.payee.toLowerCase() === waiting.payee.toLowerCase()) {
          waiting.settle(outgoing);
        }
        return;
      }
      const notice = parsePaymentNotice(data);
      if (!notice) return;
      if (notice.payer.toLowerCase() === bot.username.toLowerCase()) return;
      const payment = parsePaymentMessage(data);
      /* Resolved HERE, not inside the queued report.
       *
       * The queue preserves receipt order and may drain a moment later, by which time a payer who
       * paid and logged straight off is no longer in the player list. The UUID has to be read at
       * the instant the receipt arrives or it is not reliably there at all. */
      this.queuePaymentReport(
        notice.payer,
        notice.displayedAmount,
        payment?.amount,
        this.javaUuidFor(bot, notice.payer),
      );
      // Money arrived: what the bot holds has changed.
      this.balanceSoon(BALANCE_AFTER_MOVE_MS);
    });
    bot.on('windowClose', () => this.markInventoryDirty());
    bot.on('kicked', (reason) => {
      const text = describeKick(reason);
      this.log.warn({ reason: text }, 'Bot kicked');
      if (isBanKick(text)) this.banned = true;
    });
    bot.on('error', (error) => this.log.error({ err: error }, 'Mineflayer error'));
    bot.once('end', (reason) => {
      connectionController.abort();
      this.invalidateSnapshotState();
      this.log.warn({ reason }, 'Mineflayer connection ended');
      for (const timer of this.timers) clearInterval(timer);
      this.timers.clear();
      this.snapshotTimer = undefined;
      /* Cleared with the rest, so the handle has to go too or no read would ever be scheduled
       * again. The reading itself is dropped: it describes a session that has ended, and the next
       * one reads afresh shortly after it joins. */
      this.balanceTimer = undefined;
      this.balanceReplyUntil = 0;
      this.observedBalance = undefined;
      if (this.bot === bot) this.bot = undefined;
      if (this.connectionController === connectionController) {
        this.connectionController = undefined;
      }
      /* Whatever ended the session, a relog that was waiting is moot: the next login is a fresh
       * session and arms its own. */
      const relogging = this.relogging;
      this.relogDue = false;
      this.relogging = false;
      if (!this.stopped && this.banned) {
        /* Held open on purpose (no unref): an idle process that exits is restarted by Docker
         * straight away, which is exactly the reconnect loop this is here to stop. */
        this.log.error(
          { retryInMinutes: BANNED_RETRY_MS / 60_000 },
          'This account is banned from the server; not reconnecting until the retry',
        );
        this.banned = false;
        setTimeout(() => this.connect(), BANNED_RETRY_MS);
      } else if (!this.stopped && relogging) {
        /* Held open (no unref) like the ban wait, so the process does not exit and leave the gap
         * to Docker's restart; tracked in `timers`, so a shutdown inside the gap clears it rather
         * than waiting for it. */
        const gap = randomBetween(RELOG_OFFLINE_MIN_MS, RELOG_OFFLINE_MAX_MS);
        this.log.info({ backInSeconds: Math.round(gap / 1000) }, 'Logged out for a relog');
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.connect();
        }, gap);
        this.timers.add(timer);
      } else if (!this.stopped) {
        const timer = setTimeout(() => this.connect(), 10_000);
        timer.unref();
      }
    });
  }

  /* Ends the current connection on purpose.
   *
   * It does not reconnect: the `end` handler on every connection already schedules that ten
   * seconds later, and duplicating it here would open two sockets for one bot. So this quits and
   * lets the path that already exists bring it back — one reconnect route, not two. */
  private cycleConnection(reason: string): void {
    const bot = this.bot;
    if (!bot) return;
    this.invalidateSnapshotState();
    /* Already gone is fine: the `end` handler has fired or is about to, so the reconnect is
     * booked either way and there is nothing here worth failing over. */
    closeConnection(bot, reason, (error) =>
      this.log.warn({ err: error }, 'quit during operator reconnect threw'),
    );
  }

  private schedule(callback: () => void, milliseconds: number): void {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    this.timers.add(timer);
  }

  private run(task: Promise<void>, operation: string): void {
    void task.catch((error: unknown) => this.log.error({ err: error }, `${operation} failed`));
  }

  private markInventoryDirty(): void {
    this.invalidateSnapshotState();
    if (this.transferring) return;
    if (this.snapshotTimer || this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.snapshotTimer = undefined;
      this.run(this.snapshot(), 'inventory snapshot');
    }, 250);
    timer.unref();
    this.snapshotTimer = timer;
    this.timers.add(timer);
  }

  private invalidateSnapshotState(): void {
    this.inventoryRevision += 1;
    this.snapshotHealthy = false;
  }

  /**
   * The payer's Java account UUID, from the player list, or undefined.
   *
   * Undefined in three cases, all of which the gateway handles by falling back to the name:
   * the payer is a Bedrock player (dotted name, and their Floodgate UUID is deliberately not an
   * identity on this site), the payer is not in the list, or the list entry carries something that
   * is not a UUID. Nothing is inferred — an unresolved payer is reported as unresolved.
   */
  private javaUuidFor(bot: Bot, payer: string): string | undefined {
    // Bedrock identities are name-based here by design; see lib/minecraft-username.ts.
    if (payer.startsWith('.')) return undefined;
    const wanted = payer.toLowerCase();
    const player = Object.values(bot.players).find(
      (candidate) => candidate?.username?.toLowerCase() === wanted,
    );
    const uuid = player?.uuid;
    if (typeof uuid !== 'string') return undefined;
    /* Returned WITHOUT dashes, because that is the encoding the account identity uses:
     * `mc:<32 hex>`, as Mojang's own API returns it. mineflayer reports the dashed canonical form,
     * so a UUID passed through unchanged would be compared against a value it can never equal, and
     * every Java deposit would silently stop finding its owner. */
    const normalized = uuid.toLowerCase().replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/.test(normalized)) return undefined;
    /* A Floodgate UUID belongs to a Bedrock player whose name did not start with a dot, which
     * should not happen — but if it does, attributing it as a Java account would be wrong. They
     * are allocated from a zeroed prefix, so they are recognisable without a Floodgate lookup. */
    if (normalized.startsWith('000000000000000')) return undefined;
    return normalized;
  }

  private async reportPayment(payer: string, amount: number): Promise<void> {
    this.log.info({ payer, amount }, 'Observed in-game payment');
    await this.api.reportPayment(payer, amount);
  }

  private async reportPaymentNotice(
    payer: string,
    displayedAmount: string,
    payerUuid?: string,
  ): Promise<void> {
    this.log.info(
      { payer, displayedAmount, payerUuid: payerUuid ?? null },
      'Observed in-game cash payment receipt',
    );
    await this.api.reportPaymentNotice(payer, displayedAmount, payerUuid);
  }

  /** Preserve the order in which DonutSMP delivered payment receipts. */
  private queuePaymentReport(
    payer: string,
    displayedAmount: string,
    exactAmount?: number,
    payerUuid?: string,
  ): void {
    this.paymentReports = this.paymentReports
      .catch(() => undefined)
      .then(async () => {
        await this.reportPaymentNotice(payer, displayedAmount, payerUuid);
        if (exactAmount !== undefined) await this.reportPayment(payer, exactAmount);
      })
      .catch((error: unknown) => {
        this.log.error({ err: error }, 'payment observation failed');
      });
  }

  private async handleVerifiedPlayerCommand(
    username: string,
    identity: string,
    rawMessage: string,
  ): Promise<void> {
    const message = rawMessage.trim();
    const link = /^link ([A-Z2-9]{10})$/.exec(message);
    const deposit = /^deposit ([A-Z2-9]{12})$/.exec(message);
    if (!link?.[1] && !deposit?.[1]) return;
    if (!this.allowPlayerCommand(identity)) return;
    if (link?.[1]) {
      try {
        await this.api.sendEvent({
          eventId: randomUUID(),
          botId: this.config.botId,
          type: 'link_confirmation',
          code: link[1],
          username,
          identity,
          serverObserved: true,
        });
        this.bot?.whisper(username, 'Account linked. Return to the website to finish signing in.');
      } catch (error) {
        this.log.warn({ err: error, username }, 'Link confirmation rejected');
        this.bot?.whisper(username, 'That link code is invalid or expired.');
      }
      return;
    }
    if (deposit?.[1] && this.bot) {
      const bot = this.bot;
      const connectionController = this.connectionController;
      if (!this.config.transfersEnabled || !this.transfers.reviewedCapability) {
        bot.whisper(
          username,
          'Item transfers are temporarily unavailable; no items were accepted.',
        );
        return;
      }
      if (this.transferring) {
        bot.whisper(username, 'The custody bot is busy; try again shortly.');
        return;
      }
      if (this.config.transfersEnabled && !this.snapshotHealthy) {
        bot.whisper(username, 'Item transfers are unavailable until inventory is reconciled.');
        return;
      }
      // This process-local mutex must be held before authorization performs its first await. The
      // database lease is the cross-process authority; this mutex prevents one worker instance
      // from starting overlapping physical interactions with the same Mineflayer connection.
      this.transferring = true;
      this.snapshotHealthy = false;
      let adapterInvoked = false;
      let leaseId: string | undefined;
      try {
        const lease = await this.api.authorizeDeposit(deposit[1], username, identity);
        if (!lease) {
          bot.whisper(
            username,
            'That deposit code is invalid, expired, already used, or belongs to another account.',
          );
          return;
        }
        leaseId = lease.leaseId;
        if (
          this.bot !== bot ||
          !bot.entity ||
          this.connectionController !== connectionController ||
          connectionController?.signal.aborted
        ) {
          throw new Error('BOT_CONNECTION_CHANGED');
        }
        const now = Date.now();
        const leaseDeadline = Date.parse(lease.expiresAt);
        const operationDeadline = Math.min(
          leaseDeadline - DEPOSIT_LEASE_SAFETY_MARGIN_MS,
          now + MAX_DEPOSIT_TRANSFER_DURATION_MS,
        );
        const executionWindowMs = operationDeadline - now;
        if (
          !Number.isSafeInteger(leaseDeadline) ||
          !Number.isSafeInteger(operationDeadline) ||
          executionWindowMs < MIN_DEPOSIT_TRANSFER_WINDOW_MS
        ) {
          this.log.warn(
            { leaseId: lease.leaseId, depositId: lease.depositId },
            'Deposit authorization lease is too close to expiry',
          );
          bot.whisper(username, 'That deposit authorization expired; create a new deposit code.');
          return;
        }
        const signals = [this.shutdownController.signal, AbortSignal.timeout(executionWindowMs)];
        if (connectionController) signals.push(connectionController.signal);
        const signal = AbortSignal.any(signals);
        adapterInvoked = true;
        const result = parseDepositAttemptResult(
          await this.transfers.beginDeposit(
            bot,
            {
              player: { username, identity },
              depositCode: deposit[1],
              lease,
              operationDeadlineEpochMs: operationDeadline,
            },
            signal,
          ),
        );
        if (signal.aborted || Date.now() >= operationDeadline) {
          this.log.fatal(
            { leaseId: lease.leaseId, depositId: lease.depositId },
            'Deposit transfer crossed its safe deadline; manual review required',
          );
          bot.whisper(username, 'The deposit outcome is being reviewed; do not retry this code.');
          return;
        }
        if (result.outcome === 'cancelled') {
          this.log.info(
            {
              leaseId: lease.leaseId,
              depositId: lease.depositId,
              reasonCode: result.reasonCode,
            },
            'Deposit transfer cancelled before custody changed',
          );
          bot.whisper(username, 'The deposit was cancelled; create a new deposit code to retry.');
          return;
        }
        if (result.outcome === 'ambiguous') {
          this.log.fatal(
            {
              leaseId: lease.leaseId,
              depositId: lease.depositId,
              reasonCode: result.reasonCode,
            },
            'Deposit transfer outcome is ambiguous; manual review required',
          );
          bot.whisper(username, 'The deposit outcome is being reviewed; do not retry this code.');
          return;
        }
        await this.api.confirmDeposit(deposit[1], username, identity, lease, result.items);
        bot.whisper(username, 'Deposit confirmed. Your items are now available on the website.');
      } catch (error) {
        if (adapterInvoked) {
          this.log.fatal(
            { err: error, leaseId },
            'Deposit failed after the transfer adapter started; manual review required',
          );
          bot.whisper(username, 'The deposit outcome is being reviewed; do not retry this code.');
        } else {
          this.log.warn({ err: error, leaseId }, 'Deposit authorization could not be completed');
          bot.whisper(username, 'The deposit could not start; create a new deposit code to retry.');
        }
      } finally {
        await this.finishTransferReconciliation();
      }
    }
  }

  private allowPlayerCommand(identity: string): boolean {
    const now = Date.now();
    this.recentCommandTimes = this.recentCommandTimes.filter(
      (timestamp) => now - timestamp < 60_000,
    );
    if (this.recentCommandTimes.length >= 40) return false;
    const previous = this.lastPlayerCommandAt.get(identity);
    if (previous !== undefined && now - previous < 5_000) return false;
    this.recentCommandTimes.push(now);
    this.lastPlayerCommandAt.set(identity, now);
    if (this.lastPlayerCommandAt.size > 4096) {
      for (const [candidate, timestamp] of this.lastPlayerCommandAt) {
        if (now - timestamp >= 60_000) this.lastPlayerCommandAt.delete(candidate);
      }
    }
    return true;
  }

  private async heartbeat(online: boolean): Promise<void> {
    const balance = this.observedBalance;
    await this.api.sendEvent({
      eventId: randomUUID(),
      botId: this.config.botId,
      type: 'heartbeat',
      username: this.bot?.username ?? this.config.expectedUsername,
      serverHost: this.config.host,
      online,
      snapshotHealthy: online && this.snapshotHealthy,
      transferCapable:
        online &&
        this.snapshotHealthy &&
        this.config.transfersEnabled &&
        this.transfers.reviewedCapability,
      ...(online && balance
        ? {
            balance: {
              displayed: balance.displayed,
              lowMinor: balance.low.toString(),
              stepMinor: balance.step.toString(),
              observedAt: balance.observedAt,
            },
          }
        : {}),
      // Which proxy assignment this session is using, so the console can show it is in effect.
      ...(online && this.routeRevision ? { proxyRevision: this.routeRevision } : {}),
    });
  }

  /** The occasional read while nothing moves, at an irregular gap; re-arms itself each time. */
  private scheduleIdleBalance(): void {
    if (this.stopped) return;
    const gap = BALANCE_IDLE_MIN_MS + Math.floor(Math.random() * (BALANCE_IDLE_MAX_MS - BALANCE_IDLE_MIN_MS));
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.requestBalance();
      this.scheduleIdleBalance();
    }, gap);
    timer.unref();
    this.timers.add(timer);
  }

  /** Arms the relog for a random 10-30 minutes after this login. */
  private scheduleRelog(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.relogDue = true;
      this.relogWhenIdle();
    }, randomBetween(RELOG_MIN_MS, RELOG_MAX_MS));
    timer.unref();
    this.timers.add(timer);
  }

  /**
   * Logs out for the relog once nothing is in flight.
   *
   * A /pay waiting on its confirmation, a job being worked or a /bal waiting on its answer would
   * each lose that answer to the logout, and a payout whose confirmation is lost goes to a human.
   * While a relog is due no new job is claimed (see captureJobClaimState), so this only ever waits
   * for what was already running.
   */
  private relogWhenIdle(): void {
    if (this.stopped || !this.relogDue || this.relogging || !this.bot) return;
    if (
      this.polling ||
      this.pendingPayout ||
      this.transferring ||
      Date.now() < this.balanceReplyUntil
    ) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.relogWhenIdle();
      }, this.relogRetryMs);
      timer.unref();
      this.timers.add(timer);
      return;
    }
    this.relogging = true;
    this.log.info('relogging');
    this.cycleConnection('relog');
  }

  /** Reads the balance after a short delay; several calls inside the delay make one /bal. */
  private balanceSoon(delayMs: number): void {
    if (this.balanceTimer || this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.balanceTimer = undefined;
      this.requestBalance();
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
    this.balanceTimer = timer;
  }

  /**
   * Asks the server what this bot holds, with /bal.
   *
   * Not while a /pay is waiting for its answer: the two replies would share the window, and a
   * payout's confirmation is the one that must not be confused with anything. It is retried a
   * few seconds later instead.
   */
  private requestBalance(): void {
    const bot = this.bot;
    const connectionController = this.connectionController;
    if (!bot?.entity || !connectionController || connectionController.signal.aborted) return;
    if (this.pendingPayout || this.transferring) {
      this.balanceSoon(BALANCE_AFTER_MOVE_MS);
      return;
    }
    this.balanceReplyUntil = Date.now() + BALANCE_REPLY_MS;
    bot.chat('/bal');
  }

  private async snapshot(): Promise<void> {
    const bot = this.bot;
    const connectionController = this.connectionController;
    if (
      !bot?.entity ||
      !connectionController ||
      connectionController.signal.aborted ||
      this.snapshottingBot === bot ||
      this.transferring
    )
      return;
    if (bot.currentWindow || bot.inventory.selectedItem) {
      this.snapshotHealthy = false;
      return;
    }
    this.snapshottingBot = bot;
    const capturedRevision = this.inventoryRevision;
    try {
      const totals = new Map<
        string,
        {
          fingerprint: string;
          quantity: number;
          minecraftName: string;
          displayName: string;
          metadata: number;
        }
      >();
      const craftingResultSlot = bot.inventory.craftingResultSlot;
      const inventoryItems = bot.inventory.slots.flatMap((item, slot) =>
        item !== null && slot !== craftingResultSlot ? [item] : [],
      );
      for (const item of inventoryItems) {
        if (!Number.isInteger(item.count) || item.count <= 0) {
          throw new Error('Minecraft inventory contained an invalid item count');
        }
        const fingerprint = itemFingerprint(item);
        const current = totals.get(fingerprint);
        totals.set(fingerprint, {
          fingerprint,
          quantity: (current?.quantity ?? 0) + item.count,
          minecraftName: item.name,
          displayName: item.displayName,
          metadata: item.metadata,
        });
      }
      if (!this.isCurrentConnection(bot, connectionController)) return;
      await this.api.sendEvent({
        eventId: randomUUID(),
        botId: this.config.botId,
        type: 'inventory_snapshot',
        occupiedSlots: inventoryItems.length,
        capacitySlots:
          bot.inventory.slots.length -
          (craftingResultSlot >= 0 && craftingResultSlot < bot.inventory.slots.length ? 1 : 0),
        totals: [...totals.values()].sort((left, right) =>
          left.fingerprint.localeCompare(right.fingerprint),
        ),
      });
      if (this.isCurrentConnection(bot, connectionController)) {
        this.snapshotHealthy =
          capturedRevision === this.inventoryRevision &&
          !this.transferring &&
          !bot.currentWindow &&
          !bot.inventory.selectedItem;
      }
    } catch (error) {
      if (this.isCurrentConnection(bot, connectionController)) this.snapshotHealthy = false;
      throw error;
    } finally {
      if (this.snapshottingBot === bot) this.snapshottingBot = undefined;
    }
  }

  private async pollJobs(): Promise<void> {
    if (this.polling) return;
    const claimState = this.captureJobClaimState();
    if (!claimState) return;
    this.polling = true;
    try {
      const job = await this.api.claimJob();
      if (!job) return;
      await this.executeJob(job, claimState);
    } catch (error) {
      this.log.error({ err: error }, 'Bot job poll failed');
    } finally {
      this.polling = false;
    }
  }

  /**
   * Whether the bot is in a fit state to claim a job at all.
   *
   * Deliberately does NOT require a healthy inventory snapshot. A cash payout is one chat command
   * and never opens the bot's inventory, but this gate runs before the job is claimed and so
   * before its kind is known — so requiring snapshot health here meant that a bot which had lost
   * its snapshot (an unreachable API is enough) would sit on a queued payout forever while looking
   * perfectly healthy in every other respect. The inventory conditions moved to executeJob, where
   * they are applied to the one kind of job that actually touches the inventory.
   */
  private captureJobClaimState(): JobClaimState | null {
    const bot = this.bot;
    const connectionController = this.connectionController;

    /* Only liveness. An open window and a held item are states of the INVENTORY, and a cash payout
     * is a chat command that cannot touch one — but this gate runs before the job is claimed and
     * so before its kind is known, so anything checked here blocks every kind. A server that pops
     * a menu on join would otherwise stop payouts forever. Item work still gets the full check in
     * isJobClaimStateSafe, which is the only place it can be applied to the right job. */
    const blocked = !bot?.entity
      ? 'bot_not_spawned'
      : !connectionController
        ? 'no_connection'
        : connectionController.signal.aborted
          ? 'connection_closing'
          : this.transferring
            ? 'transfer_in_progress'
            : this.relogDue
              ? 'relog_pending'
              : undefined;

    /* Logged on change. A gate that refuses silently is why a queued payout looked identical to a
     * bot with nothing to do, through several rounds of looking in the wrong place. */
    if (blocked !== this.claimBlockReason) {
      this.claimBlockReason = blocked;
      if (blocked) this.log.warn({ reason: blocked }, 'not claiming bot jobs');
      else this.log.info('claiming bot jobs');
    }
    if (blocked || !bot || !connectionController) return null;

    return { bot, connectionController, inventoryRevision: this.inventoryRevision };
  }

  private isCurrentConnection(bot: Bot, connectionController: AbortController): boolean {
    return (
      this.bot === bot &&
      this.connectionController === connectionController &&
      !connectionController.signal.aborted
    );
  }

  /** The connection this job was claimed on is still the live one. */
  private isConnectionLive(state: JobClaimState): boolean {
    return (
      this.isCurrentConnection(state.bot, state.connectionController) &&
      Boolean(state.bot.entity) &&
      !this.transferring
    );
  }

  /**
   * Everything above, plus the inventory being exactly as it was when the job was claimed.
   *
   * Only item work needs this. Holding a cash payout to it means a stale snapshot blocks a
   * payment that cannot touch an item.
   */
  private isJobClaimStateSafe(state: JobClaimState): boolean {
    return (
      this.isConnectionLive(state) &&
      this.snapshotHealthy &&
      this.inventoryRevision === state.inventoryRevision &&
      !state.bot.currentWindow &&
      !state.bot.inventory.selectedItem
    );
  }

  /**
   * Pays a player with the server's own `/pay`.
   *
   * The gateway debited the wallet before queueing this, so the only outcomes that matter here are
   * "the command went to the server" and "it did not". PAYOUT_NOT_SENT is raised only in the
   * second case, and it is the single error the gateway will refund on — every other failure is
   * reported as non-retryable and parked for a human, because a retry after an unknown outcome is
   * how a player gets paid twice.
   */
  /* Four kinds, one act: /pay somebody an exact amount and wait for the server to say it landed.
   * Two of them pay a player and two pay the platform's other bot; nothing here needs to know
   * which, because the payee is already decided by the time a job reaches this bot. */
  private async sendCashPayout(
    job: CashPayoutBotJob | AdminPayoutBotJob | InternalTransferBotJob,
    claimState: JobClaimState,
  ): Promise<void> {
    const { payee, amountMinor } = job.payload;
    let receipt: OutgoingPayment | PayoutRefusal | undefined;
    /* Whatever happens next, the balance is worth reading again once it has: a payout that went
     * out, or one refused for funds, both say something about what the bot holds. */
    this.balanceSoon(BALANCE_AFTER_MOVE_MS + PAYOUT_CONFIRM_MS);
    try {
      if (!this.isConnectionLive(claimState)) throw new Error('PAYOUT_NOT_SENT');
      // Re-checked immediately before the write: a disconnect between the guard above and this
      // line would otherwise send the command into a dead socket and call it delivered.
      const bot = this.bot;
      if (!bot || bot !== claimState.bot) throw new Error('PAYOUT_NOT_SENT');

      /* Armed before the command, because the server can answer within the same tick. */
      const confirmation = this.awaitPayoutReceipt(payee);
      this.payoutChatCaptureUntil = Date.now() + PAYOUT_CHAT_CAPTURE_MS;
      bot.chat(`/pay ${payee} ${amountMinor}`);
      this.log.info({ jobId: job.id, payee, amountMinor }, 'cash payout sent');
      receipt = await confirmation;
    } catch (error) {
      const code =
        error instanceof Error && error.message === 'PAYOUT_NOT_SENT'
          ? 'PAYOUT_NOT_SENT'
          : 'PAYOUT_FAILED';
      await this.api.completeJob(job, 'failed', { retryable: false, errorCode: code });
      return;
    }

    /* The server said no: this bot does not hold the money. That is an answer, not silence -- the
     * payment definitely did not happen -- so it gets its own code, which the gateway can act on
     * (retry once the bot is topped up, tell the operator which bot is short). And no reconnect:
     * the connection just answered within a tenth of a second. */
    if (receipt === 'insufficient_funds') {
      this.log.error(
        { jobId: job.id, payee, amountMinor },
        'cash payout refused: this bot does not have the funds in game',
      );
      await this.api.completeJob(job, 'failed', {
        retryable: false,
        errorCode: 'PAYOUT_INSUFFICIENT_FUNDS',
      });
      return;
    }

    /* Nothing came back, or what came back does not cover what was asked for.
     *
     * Neither is reported as PAYOUT_NOT_SENT, because that is the one code the gateway refunds on
     * and the command did reach the server. An unknown or short outcome goes to a human instead:
     * refunding might pay twice, and marking it paid is what let a bot without the funds settle a
     * withdrawal it never made. */
    if (!receipt) {
      this.log.error({ jobId: job.id, payee, amountMinor }, 'cash payout was never confirmed');
      await this.api.completeJob(job, 'failed', {
        retryable: false,
        errorCode: 'PAYOUT_UNCONFIRMED',
      });
      /* Silence after a /pay is almost always this connection, not the payment: the vault went
       * hours at a time hearing nothing from the server -- no receipts for money it was sent, no
       * answer to its own /pay -- while its socket stayed open and every heartbeat looked fine,
       * until an operator reconnected it by hand. A fresh login is what put it back, so do it
       * here, once the result is reported and nothing is in flight. The gateway retries a vault
       * release after a delay long enough for this to finish. */
      this.log.warn({ jobId: job.id }, 'reconnecting after an unconfirmed payout');
      this.cycleConnection('payout unconfirmed');
      return;
    }
    if (!coversRequestedAmount(receipt.displayedAmount, amountMinor)) {
      this.log.error(
        { jobId: job.id, payee, amountMinor, displayed: receipt.displayedAmount },
        'cash payout confirmed for a different amount',
      );
      await this.api.completeJob(job, 'failed', {
        retryable: false,
        errorCode: 'PAYOUT_AMOUNT_MISMATCH',
      });
      return;
    }

    try {
      await this.api.completeJob(job, 'completed');
    } catch (error) {
      /* The money has left. Never report this as a failure and never retry it: the gateway moves
       * a lease that expires without an answer to manual review, which is the correct landing
       * place for a payout whose acknowledgement was lost. */
      this.log.fatal(
        { err: error, jobId: job.id },
        'Cash payout sent but could not be acknowledged; manual review required',
      );
    }
  }

  /** Resolves with the server's confirmation for this payee, its refusal, or undefined if neither arrives. */
  private awaitPayoutReceipt(payee: string): Promise<OutgoingPayment | PayoutRefusal | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPayout = undefined;
        resolve(undefined);
      }, this.payoutConfirmMs);
      timer.unref();
      const answer = (result: OutgoingPayment | PayoutRefusal) => {
        clearTimeout(timer);
        this.pendingPayout = undefined;
        resolve(result);
      };
      this.pendingPayout = { payee, settle: answer, refuse: answer };
    });
  }

  private async executeJob(job: BotJob, claimState: JobClaimState): Promise<void> {
    /* A cash payout is one chat command and touches no inventory, so it does not take the
     * transfer flag, does not invalidate the snapshot, and does not run the reconciliation
     * afterwards. It is handled before the inventory-strict check below, because holding a
     * payment to the state of an inventory it never opens is what kept one queued indefinitely. */
    if (
      job.kind === 'cash_payout' ||
      job.kind === 'admin_payout' ||
      /* The two bot-to-bot legs. Identical machinery: one /pay command and a confirmation from
       * the server's own receipt, with another of our accounts as the payee rather than a
       * player. The bot is not told which of the two roles it is playing and does not need to
       * be -- the gateway decides who pays whom, and this only carries it out. */
      job.kind === 'vault_sweep' ||
      job.kind === 'vault_release'
    ) {
      await this.sendCashPayout(job, claimState);
      return;
    }

    /* A reconnect is acknowledged BEFORE the connection is cycled, not after.
     *
     * Completing it afterwards would mean reporting on a socket that is deliberately being torn
     * down, and the report would race the teardown it is reporting. Acknowledging first costs the
     * ability to say the reconnect succeeded — which the heartbeat that follows says better
     * anyway, and more honestly, since it is observed rather than claimed. */
    if (job.kind === 'reconnect') {
      await this.api.completeJob(job, 'completed');
      this.log.warn({ jobId: job.id }, 'reconnect ordered by an operator');
      this.cycleConnection('operator reconnect');
      return;
    }

    let transferStarted = false;
    try {
      if (!this.isJobClaimStateSafe(claimState)) {
        throw new Error('BOT_STATE_CHANGED_DURING_CLAIM');
      }
      if (job.kind !== 'withdrawal') throw new Error('UNSUPPORTED_JOB_KIND');
      const leaseDeadline = Date.parse(job.leaseExpiresAt);
      const safeExecutionWindowMs = leaseDeadline - Date.now() - 10_000;
      if (!Number.isFinite(leaseDeadline) || safeExecutionWindowMs <= 0) {
        throw new Error('JOB_LEASE_TOO_CLOSE_TO_EXPIRY');
      }
      const signal = AbortSignal.any([
        this.shutdownController.signal,
        claimState.connectionController.signal,
        AbortSignal.timeout(safeExecutionWindowMs),
      ]);
      this.transferring = true;
      this.snapshotHealthy = false;
      transferStarted = true;
      await this.transfers.executeWithdrawal(claimState.bot, job, signal);
      if (signal.aborted || Date.now() >= leaseDeadline - 10_000) {
        throw new Error('JOB_LEASE_EXPIRED_DURING_TRANSFER');
      }
    } catch (error) {
      const code =
        error instanceof Error
          ? error.message
              .toUpperCase()
              .replace(/[^A-Z0-9_]/g, '_')
              .slice(0, 64)
          : 'BOT_JOB_FAILED';
      try {
        await this.api.completeJob(job, 'failed', {
          retryable:
            code === 'BOT_OFFLINE' ||
            code === 'BOT_BUSY' ||
            code === 'BOT_STATE_CHANGED_DURING_CLAIM',
          errorCode: code,
        });
      } finally {
        if (transferStarted) await this.finishTransferReconciliation();
      }
      return;
    }
    // A failed acknowledgement after physical delivery is ambiguous. Never report it as a
    // transfer failure or auto-retry; the API will move an expired lease to manual review.
    try {
      await this.api.completeJob(job, 'completed');
    } catch (error) {
      this.log.fatal(
        { err: error, jobId: job.id },
        'Delivered job could not be acknowledged; manual review required',
      );
    } finally {
      if (transferStarted) await this.finishTransferReconciliation();
    }
  }

  private async finishTransferReconciliation(): Promise<void> {
    this.transferring = false;
    this.invalidateSnapshotState();
    await this.snapshot();
  }
}

/** Packet metadata is untyped at this boundary, so the name is read defensively. */
/**
 * Whether an abbreviated confirmation can be the amount that was asked for.
 *
 * "383K" stands for anything in [383000, 384000), so the requested figure has to fall inside that
 * interval. A bot that could only afford part of the payout reports a smaller number, whose
 * interval will not contain what was requested — which is exactly the case this exists to catch.
 */
function coversRequestedAmount(displayed: string, requestedMinor: string): boolean {
  const bounds = displayedAmountBounds(displayed);
  if (!bounds) return false;
  let requested: bigint;
  try {
    requested = BigInt(requestedMinor);
  } catch {
    return false;
  }
  return requested >= bounds.low && requested < bounds.low + bounds.step;
}

function packetName(meta: unknown): string {
  if (meta === null || typeof meta !== 'object') return '';
  const name = (meta as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}
