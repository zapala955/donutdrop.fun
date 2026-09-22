import { randomUUID } from 'node:crypto';
import mineflayer, { type Bot } from 'mineflayer';
import type { Logger } from 'pino';
import type { BotConfig } from './config.js';
import type {
  AdminPayoutBotJob,
  ApiClient,
  BotJob,
  CashPayoutBotJob,
  InternalTransferBotJob,
} from './api-client.js';
import { itemFingerprint } from './fingerprint.js';
import { parseDepositAttemptResult, type TransferAdapter } from './transfer-adapter.js';
import {
  describeSystemChat,
  displayedAmountBounds,
  parseOutgoingPayment,
  parsePaymentMessage,
  parsePaymentNotice,
  type OutgoingPayment,
} from './payment-chat.js';
import { parseVerifiedPlayerChat } from './verified-chat.js';

const DEPOSIT_LEASE_SAFETY_MARGIN_MS = 10_000;
const MIN_DEPOSIT_TRANSFER_WINDOW_MS = 20_000;
const MAX_DEPOSIT_TRANSFER_DURATION_MS = 120_000;
/** How long after a payout the server's reply is worth logging. */
const PAYOUT_CHAT_CAPTURE_MS = 8_000;
/** How long to wait for the server to confirm a payout before giving up on knowing. */
const PAYOUT_CONFIRM_MS = 8_000;

interface JobClaimState {
  readonly bot: Bot;
  readonly connectionController: AbortController;
  readonly inventoryRevision: number;
}

export class MinecraftWorker {
  private bot: Bot | undefined;
  private stopped = false;
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
  /** The payout waiting on the server's confirmation, if one is in flight. */
  private pendingPayout: { payee: string; settle: (receipt: OutgoingPayment) => void } | undefined;
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
      this.bot.quit('Worker shutdown');
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.invalidateSnapshotState();
    this.log.info({ host: this.config.host, port: this.config.port }, 'Connecting Mineflayer bot');
    const bot = mineflayer.createBot({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth,
      ...(this.config.version ? { version: this.config.version } : {}),
      profilesFolder: this.config.profilesFolder,
      hideErrors: true,
      checkTimeoutInterval: 30_000,
      defaultChatPatterns: false,
    });
    const connectionController = new AbortController();
    this.connectionController = connectionController;
    this.bot = bot;

    bot.once('spawn', () => {
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
    });
    bot.on('windowClose', () => this.markInventoryDirty());
    bot.on('kicked', (reason) =>
      this.log.warn({ reason: String(reason).slice(0, 500) }, 'Bot kicked'),
    );
    bot.on('error', (error) => this.log.error({ err: error }, 'Mineflayer error'));
    bot.once('end', (reason) => {
      connectionController.abort();
      this.invalidateSnapshotState();
      this.log.warn({ reason }, 'Mineflayer connection ended');
      for (const timer of this.timers) clearInterval(timer);
      this.timers.clear();
      this.snapshotTimer = undefined;
      if (this.bot === bot) this.bot = undefined;
      if (this.connectionController === connectionController) {
        this.connectionController = undefined;
      }
      if (!this.stopped) {
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
    try {
      bot.quit(reason);
    } catch (error) {
      /* Already gone. The `end` handler has fired or is about to, so the reconnect is booked
       * either way and there is nothing here worth failing over. */
      this.log.warn({ err: error }, 'quit during operator reconnect threw');
    }
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
    });
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
    let receipt: OutgoingPayment | undefined;
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

  /** Resolves with the server's confirmation for this payee, or undefined if none arrives. */
  private awaitPayoutReceipt(payee: string): Promise<OutgoingPayment | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPayout = undefined;
        resolve(undefined);
      }, this.payoutConfirmMs);
      timer.unref();
      this.pendingPayout = {
        payee,
        settle: (received) => {
          clearTimeout(timer);
          this.pendingPayout = undefined;
          resolve(received);
        },
      };
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
