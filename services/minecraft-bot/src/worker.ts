import { randomUUID } from 'node:crypto';
import mineflayer, { type Bot } from 'mineflayer';
import type { Logger } from 'pino';
import type { BotConfig } from './config.js';
import type { ApiClient, BotJob } from './api-client.js';
import { itemFingerprint } from './fingerprint.js';
import { parseDepositAttemptResult, type TransferAdapter } from './transfer-adapter.js';
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
      // A snapshot from an earlier network session can never authorize custody operations on a
      // respawned session, even if no inventory event was observed during the disconnect.
      this.invalidateSnapshotState();
      this.log.info({ username: bot.username, version: bot.version }, 'Mineflayer bot spawned');
      this.run(this.heartbeat(true), 'heartbeat');
      this.run(this.snapshot(), 'inventory snapshot');
      this.schedule(() => this.run(this.heartbeat(true), 'heartbeat'), 15_000);
      this.schedule(() => this.run(this.snapshot(), 'inventory snapshot'), 30_000);
      if (this.config.transfersEnabled) {
        this.schedule(() => this.run(this.pollJobs(), 'job poll'), this.config.pollIntervalMs);
      }
    });
    bot.inventory.on('updateSlot', () => this.markInventoryDirty());
    bot.on('windowOpen', () => this.markInventoryDirty());
    bot._client.on('playerChat', (packet: unknown) => {
      const chat = parseVerifiedPlayerChat(packet);
      if (!chat) return;
      const player = Object.values(bot.players).find(
        (candidate) => candidate.uuid.toLowerCase().replaceAll('-', '') === chat.normalizedUuid,
      );
      if (!player || !/^[A-Za-z0-9_]{3,16}$/.test(player.username)) {
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

  private captureJobClaimState(): JobClaimState | null {
    const bot = this.bot;
    const connectionController = this.connectionController;
    if (
      !bot?.entity ||
      !connectionController ||
      connectionController.signal.aborted ||
      this.transferring ||
      !this.snapshotHealthy ||
      bot.currentWindow ||
      bot.inventory.selectedItem
    ) {
      return null;
    }
    return { bot, connectionController, inventoryRevision: this.inventoryRevision };
  }

  private isCurrentConnection(bot: Bot, connectionController: AbortController): boolean {
    return (
      this.bot === bot &&
      this.connectionController === connectionController &&
      !connectionController.signal.aborted
    );
  }

  private isJobClaimStateSafe(state: JobClaimState): boolean {
    return (
      this.isCurrentConnection(state.bot, state.connectionController) &&
      Boolean(state.bot.entity) &&
      !this.transferring &&
      this.snapshotHealthy &&
      this.inventoryRevision === state.inventoryRevision &&
      !state.bot.currentWindow &&
      !state.bot.inventory.selectedItem
    );
  }

  private async executeJob(job: BotJob, claimState: JobClaimState): Promise<void> {
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
