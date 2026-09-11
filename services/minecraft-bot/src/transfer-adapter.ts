import type { Bot } from 'mineflayer';
import { z } from 'zod';
import { validateDepositReceiptItems } from './api-client.js';
import type { DepositLease, DepositReceiptItem, WithdrawalBotJob } from './api-client.js';

export interface DepositTransferRequest {
  readonly player: { readonly username: string; readonly identity: string };
  readonly depositCode: string;
  readonly lease: DepositLease;
  /**
   * The adapter must stop before this Unix epoch millisecond deadline. The worker also supplies
   * an AbortSignal that fires at the deadline or during shutdown/disconnect.
   */
  readonly operationDeadlineEpochMs: number;
}

export type DepositAttemptResult =
  | { readonly outcome: 'confirmed'; readonly items: readonly DepositReceiptItem[] }
  | { readonly outcome: 'cancelled'; readonly reasonCode: string }
  | { readonly outcome: 'ambiguous'; readonly reasonCode: string };

const transferReasonCode = z.string().regex(/^[A-Z0-9_]{1,64}$/);
const depositAttemptResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('confirmed'),
      items: z.array(z.unknown()).min(1).max(54),
    })
    .strict(),
  z.object({ outcome: z.literal('cancelled'), reasonCode: transferReasonCode }).strict(),
  z.object({ outcome: z.literal('ambiguous'), reasonCode: transferReasonCode }).strict(),
]);

export function parseDepositAttemptResult(value: unknown): DepositAttemptResult {
  const result = depositAttemptResultSchema.parse(value);
  if (result.outcome !== 'confirmed') return result;
  return { outcome: 'confirmed', items: validateDepositReceiptItems(result.items) };
}

/**
 * DonutSMP does not expose a documented atomic item-transfer command. An implementation must
 * verify the exact player, item fingerprint, quantity, confirmation state, and final inventory
 * delta. Dropping items or trusting chat text is deliberately not implemented because either
 * can lose or duplicate custody credit.
 */
export interface TransferAdapter {
  /** True only for a separately reviewed, server-specific atomic transfer implementation. */
  readonly reviewedCapability: boolean;
  beginDeposit(
    bot: Bot,
    request: DepositTransferRequest,
    signal: AbortSignal,
  ): Promise<DepositAttemptResult>;
  executeWithdrawal(bot: Bot, job: WithdrawalBotJob, signal: AbortSignal): Promise<void>;
}

export class DisabledTransferAdapter implements TransferAdapter {
  readonly reviewedCapability = false;

  async beginDeposit(
    bot: Bot,
    request: DepositTransferRequest,
    signal: AbortSignal,
  ): Promise<DepositAttemptResult> {
    if (signal.aborted || Date.now() >= request.operationDeadlineEpochMs) {
      return { outcome: 'cancelled', reasonCode: 'TRANSFER_ABORTED' };
    }
    bot.whisper(
      request.player.username,
      'Item transfers are temporarily unavailable; no items were accepted.',
    );
    return { outcome: 'cancelled', reasonCode: 'TRANSFER_ADAPTER_DISABLED' };
  }

  async executeWithdrawal(bot: Bot, job: WithdrawalBotJob, signal: AbortSignal): Promise<void> {
    void bot;
    void job;
    void signal;
    throw new Error('TRANSFER_ADAPTER_NOT_CONFIGURED');
  }
}
