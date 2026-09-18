import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BotConfig } from './config.js';
import { canonicalJson, hmacHex } from './canonical.js';

const MAX_API_RESPONSE_BYTES = 64 * 1024;
const API_CLOCK_SKEW_MS = 60_000;

const withdrawalPayloadSchema = z
  .object({
    withdrawalId: z.uuid(),
    player: z.string().regex(/^[A-Za-z0-9_]{3,16}$/),
    playerIdentity: z.string().regex(/^mc:[a-f0-9]{32}$/),
    deliveryCodeHash: z.string().regex(/^[a-f0-9]{64}$/),
    items: z
      .array(
        z
          .object({
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            minecraftName: z.string().regex(/^[a-z0-9_.:-]{1,128}$/),
            displayName: z.string().min(1).max(256),
            quantity: z.number().int().min(1).max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(54),
  })
  .strict();

const botJobSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['withdrawal', 'inventory_resync']),
    reference_id: z.uuid(),
    payload: z.unknown(),
    leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
    leaseExpiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const claimResponseSchema = z
  .object({
    job: botJobSchema.nullable(),
    duplicate: z.boolean(),
  })
  .strict();

const depositLeaseSchema = z
  .object({
    leaseId: z.uuid(),
    depositId: z.uuid(),
    leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .refine((value) => Number.isSafeInteger(Date.parse(value)), 'must be an absolute timestamp'),
  })
  .strict();

const depositAuthorizationResponseSchema = z.discriminatedUnion('authorized', [
  z
    .object({
      authorized: z.literal(true),
      lease: depositLeaseSchema,
      duplicate: z.boolean(),
    })
    .strict(),
  z
    .object({
      authorized: z.literal(false),
      lease: z.null(),
      duplicate: z.boolean(),
    })
    .strict(),
]);

const depositReceiptItemSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    quantity: z.number().int().min(1).max(100_000),
  })
  .strict();

const depositReceiptItemsSchema = z
  .array(depositReceiptItemSchema)
  .min(1)
  .max(54)
  .superRefine((items, context) => {
    const fingerprints = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (fingerprints.has(item.fingerprint)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'fingerprint'],
          message: 'must not contain duplicate fingerprints',
        });
      }
      fingerprints.add(item.fingerprint);
    }
  });

export function botRequestSignaturePayload(
  method: string,
  path: string,
  botId: string,
  timestamp: string,
  body: unknown,
): string {
  return canonicalJson({
    audience: 'donut-upgrader-api',
    version: 2,
    method: method.toUpperCase(),
    path,
    botId: botId.toLowerCase(),
    timestamp,
    body,
  });
}

export function botResponseSignaturePayload(
  method: string,
  path: string,
  botId: string,
  requestTimestamp: string,
  responseTimestamp: string,
  statusCode: number,
  requestBody: unknown,
  responseBody: unknown,
): string {
  return canonicalJson({
    audience: 'donut-upgrader-bot',
    version: 1,
    method: method.toUpperCase(),
    path,
    botId: botId.toLowerCase(),
    requestTimestamp,
    responseTimestamp,
    statusCode,
    requestBody,
    responseBody,
  });
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_API_RESPONSE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error('API response exceeded the size limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

export class ApiClient {
  constructor(private readonly config: BotConfig) {}

  async sendEvent(event: Record<string, unknown>): Promise<void> {
    await this.post('/events', event);
  }

  /**
   * Reports an observed in-game payment so the gateway can match it to a pending login.
   */
  async reportPayment(payer: string, amount: number): Promise<void> {
    await this.sendEvent({
      eventId: randomUUID(),
      botId: this.config.botId,
      type: 'payment_observed',
      payer,
      amount,
    });
  }

  /** Reports a general cash receipt; the signed POST retries the same event object on failure. */
  async reportPaymentNotice(payer: string, displayedAmount: string): Promise<void> {
    await this.sendEvent({
      eventId: randomUUID(),
      botId: this.config.botId,
      type: 'cash_payment_observed',
      payer,
      displayedAmount,
    });
  }

  async authorizeDeposit(
    depositCode: string,
    username: string,
    identity: string,
  ): Promise<DepositLease | null> {
    const authorizationEventId = randomUUID();
    const response = await this.post('/deposits/authorize', {
      eventId: authorizationEventId,
      botId: this.config.botId,
      depositCode,
      username,
      identity,
    });
    const authorization = depositAuthorizationResponseSchema.parse(response);
    if (!authorization.authorized) return null;
    if (authorization.lease.leaseId !== authorizationEventId) {
      throw new Error('Deposit authorization lease is bound to another request');
    }
    return Object.freeze({ ...authorization.lease });
  }

  async confirmDeposit(
    depositCode: string,
    username: string,
    identity: string,
    lease: DepositLease,
    items: readonly DepositReceiptItem[],
  ): Promise<void> {
    const validatedLease = depositLeaseSchema.parse(lease);
    const validatedItems = validateDepositReceiptItems(items);
    await this.sendEvent({
      eventId: randomUUID(),
      botId: this.config.botId,
      type: 'deposit_confirmed',
      depositCode,
      username,
      identity,
      leaseId: validatedLease.leaseId,
      leaseToken: validatedLease.leaseToken,
      items: validatedItems,
    });
  }

  async claimJob(): Promise<BotJob | null> {
    const response = await this.post('/jobs/claim', {
      eventId: randomUUID(),
      botId: this.config.botId,
    });
    const result = claimResponseSchema.parse(response);
    if (!result.job) return null;
    if (result.job.kind === 'withdrawal') {
      const payload = withdrawalPayloadSchema.parse(result.job.payload);
      if (payload.withdrawalId !== result.job.reference_id) {
        throw new Error('Withdrawal job identifiers do not match');
      }
      return { ...result.job, payload };
    }
    return { ...result.job, kind: 'inventory_resync', payload: result.job.payload };
  }

  async completeJob(
    job: BotJob,
    outcome: 'completed' | 'failed',
    options: { retryable?: boolean; errorCode?: string } = {},
  ): Promise<void> {
    await this.sendEvent({
      eventId: randomUUID(),
      botId: this.config.botId,
      type: 'job_result',
      jobId: job.id,
      leaseToken: job.leaseToken,
      outcome,
      retryable: options.retryable ?? false,
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const encoded = canonicalJson(body);
    const fullPath = `${new URL(this.config.apiInternalUrl).pathname.replace(/\/$/, '')}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestTimestamp = Date.now().toString();
      const signature = hmacHex(
        this.config.webhookSecret,
        botRequestSignaturePayload('POST', fullPath, this.config.botId, requestTimestamp, body),
      );
      try {
        const response = await fetch(`${this.config.apiInternalUrl}${path}`, {
          method: 'POST',
          // Never forward signed bot requests through an HTTP redirect. Even though a replayed
          // event remains journal-bound, exposing its authentication headers widens the trust
          // boundary and can leak transfer metadata.
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-bot-id': this.config.botId,
            'x-bot-timestamp': requestTimestamp,
            'x-bot-signature': signature,
          },
          body: encoded,
          signal: AbortSignal.timeout(8000),
        });
        const responseText = await readBoundedResponse(response);
        let parsed: unknown = null;
        if (responseText) {
          try {
            parsed = JSON.parse(responseText);
          } catch {
            throw new Error(`API ${response.status}: response body was not JSON`);
          }
        }
        // Authenticate before acting on the status code. The API signs failures as well as
        // successes, so a forged or truncated error can no longer steer the retry, quarantine,
        // and job-failure paths that the bot drives from these responses.
        this.verifyResponse(response, fullPath, requestTimestamp, body, parsed);
        if (!response.ok) {
          throw new Error(`API ${response.status}: ${responseText.slice(0, 300)}`);
        }
        return parsed;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private verifyResponse(
    response: Response,
    path: string,
    requestTimestamp: string,
    requestBody: unknown,
    responseBody: unknown,
  ): void {
    const responseTimestamp = response.headers.get('x-api-timestamp') ?? '';
    const suppliedSignature = response.headers.get('x-api-signature') ?? '';
    if (!/^\d{13}$/.test(responseTimestamp)) {
      throw new Error('API response authentication timestamp is missing or malformed');
    }
    const responseTime = Number(responseTimestamp);
    if (
      !Number.isSafeInteger(responseTime) ||
      Math.abs(Date.now() - responseTime) > API_CLOCK_SKEW_MS
    ) {
      throw new Error('API response authentication timestamp is stale');
    }
    const expected = hmacHex(
      this.config.webhookSecret,
      botResponseSignaturePayload(
        'POST',
        path,
        this.config.botId,
        requestTimestamp,
        responseTimestamp,
        response.status,
        requestBody,
        responseBody,
      ),
    );
    if (!safeEqualHex(suppliedSignature, expected)) {
      throw new Error('API response authentication signature is invalid');
    }
  }
}

export interface WithdrawalJobPayload {
  withdrawalId: string;
  player: string;
  playerIdentity: string;
  deliveryCodeHash: string;
  items: Array<{
    fingerprint: string;
    minecraftName: string;
    displayName: string;
    quantity: number;
  }>;
}

export interface DepositLease {
  readonly leaseId: string;
  readonly depositId: string;
  readonly leaseToken: string;
  readonly expiresAt: string;
}

export interface DepositReceiptItem {
  readonly fingerprint: string;
  readonly quantity: number;
}

export function validateDepositReceiptItems(items: unknown): DepositReceiptItem[] {
  return depositReceiptItemsSchema.parse(items);
}

interface BotJobBase {
  id: string;
  reference_id: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface WithdrawalBotJob extends BotJobBase {
  kind: 'withdrawal';
  payload: WithdrawalJobPayload;
}

export interface InventoryResyncBotJob extends BotJobBase {
  kind: 'inventory_resync';
  payload: unknown;
}

export type BotJob = WithdrawalBotJob | InventoryResyncBotJob;
