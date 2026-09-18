import { randomUUID } from 'node:crypto';
import mineflayer, { type Bot } from 'mineflayer';
import type { Logger } from 'pino';
import type { BotConfig } from './config.js';
import type { ApiClient, BotJob, CashPayoutBotJob } from './api-client.js';
import { itemFingerprint } from './fingerprint.js';
import { parseDepositAttemptResult, type TransferAdapter } from './transfer-adapter.js';
import { parsePaymentMessage, parsePaymentNotice } from './payment-chat.js';
import { parseVerifiedPlayerChat } from './verified-chat.js';

const DEPOSIT_LEASE_SAFETY_MARGIN_MS = 10_000;
const MIN_DEPOSIT_TRANSFER_WINDOW_MS = 20_000;
const MAX_DEPOSIT_TRANSFER_DURATION_MS = 120_000;

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
  /** Last reason the bot declined to ask for work, so a change is logged once, not per tick. */
  private claimBlockReason: string | undefined;

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
      const notice = parsePaymentNotice(data);
      if (!notice) return;
      if (notice.payer.toLowerCase() === bot.username.toLowerCase()) return;
      const payment = parsePaymentMessage(data);
      this.queuePaymentReport(notice.payer, notice.displayedAmount, payment?.amount);
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

  private async reportPayment(payer: string, amount: number): Promise<void> {
    this.log.info({ payer, amount }, 'Observed in-game payment');
    await this.api.reportPayment(payer, amount);
  }

  private async reportPaymentNotice(payer: string, displayedAmount: string): Promise<void> {
    this.log.info({ payer, displayedAmount }, 'Observed in-game cash payment receipt');
    await this.api.reportPaymentNotice(payer, displayedAmount);
  }

  /** Preserve the order in which DonutSMP delivered payment receipts. */
  private queuePaymentReport(payer: string, displayedAmount: string, exactAmount?: number): void {
    this.paymentReports = this.paymentReports
      .catch(() => undefined)
      .then(async () => {
        await this.reportPaymentNotice(payer, displayedAmount);
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
  private async sendCashPayout(job: CashPayoutBotJob, claimState: JobClaimState): Promise<void> {
    const { payee, amountMinor } = job.payload;
    try {
      if (!this.isConnectionLive(claimState)) throw new Error('PAYOUT_NOT_SENT');
      // Re-checked immediately before the write: a disconnect between the guard above and this
      // line would otherwise send the command into a dead socket and call it delivered.
      const bot = this.bot;
      if (!bot || bot !== claimState.bot) throw new Error('PAYOUT_NOT_SENT');
      bot.chat(`/pay ${payee} ${amountMinor}`);
      this.log.info({ jobId: job.id, payee, amountMinor }, 'cash payout sent');
    } catch (error) {
      const code =
        error instanceof Error && error.message === 'PAYOUT_NOT_SENT'
          ? 'PAYOUT_NOT_SENT'
          : 'PAYOUT_FAILED';
      await this.api.completeJob(job, 'failed', { retryable: false, errorCode: code });
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

  private async executeJob(job: BotJob, claimState: JobClaimState): Promise<void> {
    /* A cash payout is one chat command and touches no inventory, so it does not take the
     * transfer flag, does not invalidate the snapshot, and does not run the reconciliation
     * afterwards. It is handled before the inventory-strict check below, because holding a
     * payment to the state of an inventory it never opens is what kept one queued indefinitely. */
    if (job.kind === 'cash_payout') {
      await this.sendCashPayout(job, claimState);
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
function packetName(meta: unknown): string {
  if (meta === null || typeof meta !== 'object') return '';
  const name = (meta as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}
