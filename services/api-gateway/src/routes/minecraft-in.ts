import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  deriveDepositLeaseToken,
  deriveLeaseToken,
  requireMatchingBotId,
  sendAuthenticatedBotResponse,
  verifyBotSignature,
} from '../lib/bot-auth.js';
import { canonicalJson, safeEqualBuffer, sha256, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { isDepositEligible, type DepositEligibilityState } from '../lib/eligibility.js';
import { MINECRAFT_USERNAME_PATTERN, platformIdentityFor } from '../lib/minecraft-username.js';
import { refundWithdrawal } from './cash-withdrawals.js';
import { parseWith } from '../lib/validation.js';
import { creditWallet } from '../lib/wallet.js';

const normalizedUuid = z.uuid().transform((value) => value.toLowerCase());
const DATABASE_BIGINT_MAX = 9_223_372_036_854_775_807n;
const eventBase = z.object({ eventId: normalizedUuid, botId: normalizedUuid }).strict();
const heartbeatEvent = eventBase.extend({
  type: z.literal('heartbeat'),
  username: z.string().regex(MINECRAFT_USERNAME_PATTERN),
  serverHost: z.string().min(1).max(255),
  online: z.boolean(),
  snapshotHealthy: z.boolean(),
  transferCapable: z.boolean(),
});
const linkEvent = eventBase.extend({
  type: z.literal('link_confirmation'),
  code: z.string().regex(/^[A-Z2-9]{10}$/),
  username: z.string().regex(MINECRAFT_USERNAME_PATTERN),
  identity: z.string().regex(/^mc:[a-f0-9]{32}$/),
  serverObserved: z.literal(true),
});
const transferItem = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    quantity: z.number().int().min(1).max(100_000),
  })
  .strict();
const depositEvent = eventBase.extend({
  type: z.literal('deposit_confirmed'),
  depositCode: z.string().regex(/^[A-Z2-9]{12}$/),
  username: z.string().regex(MINECRAFT_USERNAME_PATTERN),
  identity: z.string().regex(/^mc:[a-f0-9]{32}$/),
  leaseId: normalizedUuid,
  leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
  items: z.array(transferItem).min(1).max(54),
});
const snapshotEvent = eventBase
  .extend({
    type: z.literal('inventory_snapshot'),
    occupiedSlots: z.number().int().min(0).max(500),
    capacitySlots: z.number().int().min(1).max(500),
    totals: z
      .array(
        transferItem.extend({
          minecraftName: z.string().regex(/^[a-z0-9_.:-]{1,128}$/),
          displayName: z.string().min(1).max(256),
          metadata: z.number().int(),
        }),
      )
      .max(500),
  })
  .superRefine((event, context) => {
    if (event.occupiedSlots > event.capacitySlots) {
      context.addIssue({
        code: 'custom',
        path: ['occupiedSlots'],
        message: 'cannot exceed capacitySlots',
      });
    }
    if (event.totals.length > event.occupiedSlots) {
      context.addIssue({
        code: 'custom',
        path: ['totals'],
        message: 'cannot contain more distinct items than occupied slots',
      });
    }
  });
const jobResultEvent = eventBase.extend({
  type: z.literal('job_result'),
  jobId: z.uuid(),
  leaseToken: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['completed', 'failed']),
  retryable: z.boolean().default(false),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]{1,64}$/)
    .optional(),
});
const paymentEvent = eventBase.extend({
  type: z.literal('payment_observed'),
  payer: z.string().regex(MINECRAFT_USERNAME_PATTERN),
  // Only amounts DonutSMP renders exactly are accepted. At a thousand and above the payment
  // message abbreviates, so a larger figure could not have been read from it truthfully.
  amount: z.number().int().min(1).max(999),
});
const cashPaymentEvent = eventBase.extend({
  type: z.literal('cash_payment_observed'),
  payer: z.string().regex(MINECRAFT_USERNAME_PATTERN),
  /* The payer's Java account UUID, as the bot's player list reported it at the moment the receipt
   * arrived. Optional, and must stay optional: the bot cannot always supply one — the payer may
   * have left the list already, and a Bedrock payer has no Mojang UUID at all — and during a
   * rollout the gateway and the bot are briefly different versions. An absent UUID falls back to
   * the name, which is what this flow has always done. */
  payerUuid: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  displayedAmount: z
    .string()
    .regex(/^[1-9]\d*(?:\.\d+)?[KMBT]?$/)
    .max(32),
});
const botEventSchema = z.discriminatedUnion('type', [
  heartbeatEvent,
  linkEvent,
  depositEvent,
  snapshotEvent,
  jobResultEvent,
  paymentEvent,
  cashPaymentEvent,
]);
const claimSchema = z.object({ eventId: normalizedUuid, botId: normalizedUuid }).strict();
const depositAuthorizationSchema = eventBase.extend({
  depositCode: z.string().regex(/^[A-Z2-9]{12}$/),
  username: z.string().regex(MINECRAFT_USERNAME_PATTERN),
  identity: z.string().regex(/^mc:[a-f0-9]{32}$/),
});
const storedDepositAuthorizationSchema = z.discriminatedUnion('authorized', [
  z.object({ authorized: z.literal(false), lease: z.null() }).strict(),
  z
    .object({
      authorized: z.literal(true),
      lease: z
        .object({
          leaseId: normalizedUuid,
          depositId: normalizedUuid,
          expiresAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    })
    .strict(),
]);
const storedClaimResponseSchema = z
  .object({
    job: z
      .object({
        id: z.uuid(),
        kind: z.enum([
          'withdrawal',
          'inventory_resync',
          'cash_payout',
          'admin_payout',
          'reconnect',
        ]),
        reference_id: z.uuid(),
        payload: z.unknown(),
        leaseExpiresAt: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
  })
  .strict();

interface DepositAuthorizationState extends DepositEligibilityState {
  id: string;
  bot_id: string;
  normalized_username: string;
  minecraft_identity: string;
  deposit_status: string;
  expires_at: Date;
  bot_status: string;
  reconciliation_status: string;
  transfer_capable: boolean;
  last_heartbeat_at: Date | null;
  last_snapshot_at: Date | null;
}

function materializeDepositAuthorization(
  stored: z.infer<typeof storedDepositAuthorizationSchema>,
  secret: Buffer,
  botId: string,
  authorizationEventId: string,
  duplicate: boolean,
) {
  if (!stored.authorized) return { authorized: false as const, lease: null, duplicate };
  if (stored.lease.leaseId !== authorizationEventId.toLowerCase()) {
    throw new AppError(
      409,
      'BOT_DEPOSIT_AUTH_REPLAY_UNAVAILABLE',
      'Stored deposit authorization does not match its event',
    );
  }
  return {
    authorized: true as const,
    lease: {
      ...stored.lease,
      leaseToken: deriveDepositLeaseToken(
        secret,
        botId,
        authorizationEventId,
        stored.lease.depositId,
      ),
    },
    duplicate,
  };
}

export async function registerMinecraftInternalRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  app.post(
    '/internal/v1/minecraft/events',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const authenticated = verifyBotSignature(request, config);
      const event = parseWith(botEventSchema, request.body);
      requireMatchingBotId(authenticated.botId, event.botId);
      if (
        event.type === 'heartbeat' &&
        (event.serverHost.toLowerCase().replace(/\.$/, '') !== authenticated.expectedServerHost ||
          event.username.toLowerCase() !== authenticated.expectedUsername.toLowerCase())
      ) {
        throw new AppError(
          403,
          'BOT_PROVISIONING_MISMATCH',
          'The bot server or Minecraft account does not match its provisioning',
        );
      }
      const response = await db.transaction(async (client) => {
        // A heartbeat bootstraps the FK target, but its state change still happens only after
        // the replay journal accepts this exact event body.
        if (event.type === 'heartbeat') {
          await client.query(
            `INSERT INTO bot_accounts(id, username, status, server_host)
             VALUES ($1, $2, 'offline', $3) ON CONFLICT (id) DO NOTHING`,
            [event.botId, authenticated.expectedUsername, authenticated.expectedServerHost],
          );
        }
        const eventHash = sha256Hex(canonicalJson(event));
        const inserted = await client.query(
          `INSERT INTO inbound_bot_events(event_id, bot_id, event_type, body_hash)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING event_id`,
          [event.eventId, event.botId, event.type, eventHash],
        );
        if (!inserted.rowCount) {
          const prior = await client.query<{ body_hash: string; event_type: string }>(
            'SELECT body_hash, event_type FROM inbound_bot_events WHERE event_id = $1',
            [event.eventId],
          );
          if (prior.rows[0]?.event_type !== event.type || prior.rows[0]?.body_hash !== eventHash) {
            conflict('BOT_EVENT_ID_REUSED', 'Bot event ID was reused with a different body');
          }
          return { accepted: true, duplicate: true };
        }

        switch (event.type) {
          case 'heartbeat':
            await processHeartbeat(
              client,
              event,
              authenticated.expectedUsername,
              authenticated.expectedServerHost,
              config.minecraftTransfersEnabled,
            );
            break;
          case 'link_confirmation':
            await processLinkConfirmation(
              client,
              event,
              authenticated.expectedUsername,
              authenticated.expectedServerHost,
            );
            break;
          case 'deposit_confirmed':
            await processDeposit(client, event, config);
            break;
          case 'inventory_snapshot':
            await processSnapshot(client, event, config);
            break;
          case 'job_result':
            await processJobResult(client, event);
            break;
          case 'payment_observed':
            await processPaymentObserved(client, event);
            break;
          case 'cash_payment_observed':
            await processCashPaymentObserved(client, event);
            break;
        }
        return { accepted: true, duplicate: false };
      });
      // Response authentication binds the exact request object the bot signed. Parsed data may
      // contain harmless normalizations (for example, lower-cased UUIDs) and must not replace it.
      return sendAuthenticatedBotResponse(reply, authenticated, request.body, response);
    },
  );

  app.post(
    '/internal/v1/minecraft/deposits/authorize',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const authenticated = verifyBotSignature(request, config);
      const body = parseWith(depositAuthorizationSchema, request.body);
      requireMatchingBotId(authenticated.botId, body.botId);
      const bodyHash = sha256Hex(canonicalJson(body));
      const response = await db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.eventId]);
        const prior = await client.query<{
          body_hash: string;
          event_type: string;
          response_body: unknown;
        }>(
          `SELECT body_hash, event_type, response_body FROM inbound_bot_events
            WHERE event_id = $1`,
          [body.eventId],
        );
        if (prior.rowCount) {
          const previous = prior.rows[0]!;
          if (previous.event_type !== 'deposit_authorization' || previous.body_hash !== bodyHash) {
            conflict('BOT_EVENT_ID_REUSED', 'Bot event ID was reused with a different request');
          }
          const stored = storedDepositAuthorizationSchema.safeParse(previous.response_body);
          if (!stored.success) {
            throw new AppError(
              409,
              'BOT_DEPOSIT_AUTH_REPLAY_UNAVAILABLE',
              'Stored deposit authorization is invalid',
            );
          }
          return materializeDepositAuthorization(
            stored.data,
            authenticated.secret,
            body.botId,
            body.eventId,
            true,
          );
        }

        const intentResult = await client.query<DepositAuthorizationState>(
          `SELECT d.id, d.bot_id, d.status AS deposit_status, d.expires_at,
                  u.normalized_username, u.minecraft_identity, u.status,
                  u.country_code, u.terms_accepted_at, u.age_verified_at, u.kyc_status,
                  r.cooldown_until, r.self_excluded_until,
                  b.status AS bot_status, b.reconciliation_status, b.transfer_capable,
                  b.last_heartbeat_at, b.last_snapshot_at
             FROM deposit_intents d
             JOIN users u ON u.id = d.user_id
             JOIN responsible_limits r ON r.user_id = u.id
             JOIN bot_accounts b ON b.id = d.bot_id
            WHERE d.deposit_code = $1
            FOR UPDATE OF d, u, r, b`,
          [body.depositCode],
        );
        const intent = intentResult.rows[0];
        const now = Date.now();
        const botIsSafe =
          intent?.bot_status === 'online' &&
          intent.reconciliation_status === 'matched' &&
          intent.transfer_capable &&
          intent.last_heartbeat_at !== null &&
          now - intent.last_heartbeat_at.getTime() < 45_000 &&
          intent.last_snapshot_at !== null &&
          now - intent.last_snapshot_at.getTime() < 45_000;
        const eligible =
          config.minecraftTransfersEnabled &&
          intent !== undefined &&
          intent.deposit_status === 'pending' &&
          intent.bot_id === body.botId &&
          intent.normalized_username === body.username.toLowerCase() &&
          intent.minecraft_identity === body.identity &&
          intent.expires_at.getTime() > now + 30_000 &&
          isDepositEligible(intent, config.allowedCountries, now, config.gameCurrencyOnly) &&
          botIsSafe;

        let storedResponse: z.infer<typeof storedDepositAuthorizationSchema> = {
          authorized: false,
          lease: null,
        };
        if (eligible) {
          const leaseToken = deriveDepositLeaseToken(
            authenticated.secret,
            body.botId,
            body.eventId,
            intent.id,
          );
          const leaseResult = await client.query<{ deposit_id: string; expires_at: Date }>(
            `INSERT INTO deposit_authorization_leases
               (authorization_event_id, deposit_id, bot_id, token_hash, issued_at, expires_at)
             SELECT $1, $2, $3, $4, statement_timestamp(),
                    LEAST($5::timestamptz, statement_timestamp() + interval '150 seconds')
              WHERE $5::timestamptz > statement_timestamp() + interval '30 seconds'
             ON CONFLICT (deposit_id) DO NOTHING
             RETURNING deposit_id, expires_at`,
            [body.eventId, intent.id, body.botId, sha256(leaseToken), intent.expires_at],
          );
          const lease = leaseResult.rows[0];
          if (lease) {
            storedResponse = {
              authorized: true,
              lease: {
                leaseId: body.eventId,
                depositId: lease.deposit_id,
                expiresAt: lease.expires_at.toISOString(),
              },
            };
          }
        }
        await storeBotResponseEvent(
          client,
          body.eventId,
          body.botId,
          'deposit_authorization',
          bodyHash,
          storedResponse,
        );
        return materializeDepositAuthorization(
          storedResponse,
          authenticated.secret,
          body.botId,
          body.eventId,
          false,
        );
      });
      return sendAuthenticatedBotResponse(reply, authenticated, request.body, response);
    },
  );

  app.post('/internal/v1/minecraft/jobs/claim', async (request, reply) => {
    const authenticated = verifyBotSignature(request, config);
    const body = parseWith(claimSchema, request.body);
    requireMatchingBotId(authenticated.botId, body.botId);
    const bodyHash = sha256Hex(canonicalJson(body));
    const response = await db.transaction(async (client) => {
      // Serialize identical event IDs and persist even empty responses. Otherwise a captured
      // empty poll could be replayed later in the signature window to steal a new job lease.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [body.eventId]);
      const prior = await client.query<{
        body_hash: string;
        event_type: string;
        response_body: unknown;
      }>(
        `SELECT body_hash, event_type, response_body FROM inbound_bot_events
          WHERE event_id = $1`,
        [body.eventId],
      );
      if (prior.rowCount) {
        const previous = prior.rows[0]!;
        if (previous.event_type !== 'job_claim' || previous.body_hash !== bodyHash) {
          conflict('BOT_EVENT_ID_REUSED', 'Bot event ID was reused with a different body');
        }
        const stored = storedClaimResponseSchema.safeParse(previous.response_body);
        if (!stored.success) {
          throw new AppError(409, 'BOT_CLAIM_REPLAY_UNAVAILABLE', 'Stored job claim is invalid');
        }
        return stored.data.job
          ? {
              job: {
                ...stored.data.job,
                leaseToken: deriveLeaseToken(
                  authenticated.secret,
                  body.eventId,
                  stored.data.job.id,
                ),
              },
              duplicate: true,
            }
          : { job: null, duplicate: true };
      }

      const expired = await client.query<{ reference_id: string }>(
        `UPDATE bot_jobs SET status = 'dead_letter', last_error_code = 'LEASE_EXPIRED', updated_at = now()
          WHERE bot_id = $1 AND status = 'leased' AND lease_expires_at < now()
          RETURNING reference_id`,
        [body.botId],
      );
      if (expired.rows.length) {
        await client.query(
          `UPDATE withdrawals SET status = 'manual_review', error_code = 'LEASE_EXPIRED', updated_at = now()
            WHERE id = ANY($1::uuid[]) AND status = 'processing'`,
          [expired.rows.map((row) => row.reference_id)],
        );
      }

      /* Two different questions, asked separately.
       *
       * `live` is whether this bot is connected and answering, which is all a cash payout needs:
       * it moves a number with the server's own /pay and never opens an inventory. `item_capable`
       * adds everything custody requires — a matched reconciliation, a fresh snapshot, and the
       * transfer flag.
       *
       * Demanding item capability before handing out ANY job meant that a deployment with item
       * transfers deliberately off — which is every deployment — got `{ job: null }` on every
       * poll, forever, with no error at either end. A queued payout was indistinguishable from an
       * empty queue. */
      const botState = await client.query<{ live: boolean; item_capable: boolean }>(
        `SELECT (status = 'online' AND last_heartbeat_at > now() - interval '45 seconds') AS live,
                (status = 'online' AND reconciliation_status = 'matched' AND transfer_capable
                 AND last_heartbeat_at > now() - interval '45 seconds'
                 AND last_snapshot_at > now() - interval '90 seconds') AS item_capable
           FROM bot_accounts WHERE id = $1 FOR UPDATE`,
        [body.botId],
      );
      const capability = botState.rows[0];
      if (!capability?.live) {
        const storedResponse = { job: null };
        await storeBotResponseEvent(
          client,
          body.eventId,
          body.botId,
          'job_claim',
          bodyHash,
          storedResponse,
        );
        return { ...storedResponse, duplicate: false };
      }

      const selected = await client.query<{
        id: string;
        kind: string;
        reference_id: string;
        payload: unknown;
      }>(
        /* A bot that cannot move items is still offered the work that does not involve any.
         * Item jobs stay invisible to it rather than being claimed and failed, which would burn
         * the attempt budget and dead-letter a withdrawal the bot was never able to service. */
        `SELECT id, kind, reference_id, payload FROM bot_jobs
          WHERE bot_id = $1 AND attempts < 5 AND available_at <= now() AND status = 'queued'
            AND (kind IN ('cash_payout', 'admin_payout', 'reconnect') OR $2::boolean)
          ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [body.botId, capability.item_capable],
      );
      const job = selected.rows[0];
      if (!job) {
        const storedResponse = { job: null };
        await storeBotResponseEvent(
          client,
          body.eventId,
          body.botId,
          'job_claim',
          bodyHash,
          storedResponse,
        );
        return { ...storedResponse, duplicate: false };
      }
      const leaseToken = deriveLeaseToken(authenticated.secret, body.eventId, job.id);
      const leased = await client.query<{ lease_expires_at: Date }>(
        `UPDATE bot_jobs SET status = 'leased', attempts = attempts + 1,
                lease_token_hash = $2, lease_expires_at = now() + interval '2 minutes', updated_at = now()
          WHERE id = $1 RETURNING lease_expires_at`,
        [job.id, sha256(leaseToken)],
      );
      const leaseExpiresAt = leased.rows[0]?.lease_expires_at;
      if (!leaseExpiresAt) throw new Error('Job lease update returned no expiry');
      if (job.kind === 'withdrawal') {
        await client.query(
          "UPDATE withdrawals SET status = 'processing', attempts = attempts + 1, updated_at = now() WHERE id = $1",
          [job.reference_id],
        );
      }
      if (job.kind === 'cash_payout') {
        await client.query(
          `UPDATE cash_withdrawals SET status = 'processing', updated_at = now()
            WHERE id = $1 AND status = 'queued'`,
          [job.reference_id],
        );
      }
      if (job.kind === 'admin_payout') {
        await client.query(
          `UPDATE admin_payouts SET status = 'processing', updated_at = now()
            WHERE id = $1 AND status = 'queued'`,
          [job.reference_id],
        );
      }
      const storedResponse = {
        job: { ...job, leaseExpiresAt: leaseExpiresAt.toISOString() },
      };
      await storeBotResponseEvent(
        client,
        body.eventId,
        body.botId,
        'job_claim',
        bodyHash,
        storedResponse,
      );
      return { job: { ...storedResponse.job, leaseToken }, duplicate: false };
    });
    return sendAuthenticatedBotResponse(reply, authenticated, request.body, response);
  });
}

async function storeBotResponseEvent(
  client: DbClient,
  eventId: string,
  botId: string,
  eventType: 'job_claim' | 'deposit_authorization',
  bodyHash: string,
  response: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO inbound_bot_events(event_id, bot_id, event_type, body_hash, response_body)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventId, botId, eventType, bodyHash, JSON.stringify(response)],
  );
}

async function processHeartbeat(
  client: DbClient,
  event: z.infer<typeof heartbeatEvent>,
  expectedUsername: string,
  expectedServerHost: string,
  transfersEnabled: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO bot_accounts
       (id, username, status, server_host, last_heartbeat_at, transfer_capable)
     VALUES ($1, $2, $3, $4, now(), false)
     ON CONFLICT (id) DO UPDATE SET
       username = CASE WHEN bot_accounts.status = 'quarantined'
                       THEN bot_accounts.username ELSE EXCLUDED.username END,
       server_host = CASE WHEN bot_accounts.status = 'quarantined'
                          THEN bot_accounts.server_host ELSE EXCLUDED.server_host END,
       status = CASE WHEN bot_accounts.status = 'quarantined' THEN 'quarantined'
                     WHEN NOT $5 THEN 'offline'
                     WHEN NOT $6 OR bot_accounts.last_snapshot_at IS NULL
                       OR bot_accounts.last_snapshot_at <= now() - interval '90 seconds'
                       OR bot_accounts.reconciliation_status <> 'matched' THEN 'degraded'
                     ELSE 'online' END,
       transfer_capable = bot_accounts.status <> 'quarantined' AND $5 AND $6 AND $7
         AND bot_accounts.last_snapshot_at > now() - interval '90 seconds'
         AND bot_accounts.reconciliation_status = 'matched',
       last_heartbeat_at = now(), updated_at = now()`,
    [
      event.botId,
      expectedUsername,
      event.online ? 'degraded' : 'offline',
      expectedServerHost,
      event.online,
      event.snapshotHealthy,
      transfersEnabled && event.transferCapable,
    ],
  );
}

async function processLinkConfirmation(
  client: DbClient,
  event: z.infer<typeof linkEvent>,
  expectedUsername: string,
  expectedServerHost: string,
): Promise<void> {
  const bot = await client.query(
    `SELECT 1 FROM bot_accounts
      WHERE id = $1 AND status = 'online'
        AND lower(username) = lower($2) AND lower(server_host) = lower($3)
        AND last_heartbeat_at > now() - interval '45 seconds'
      FOR SHARE`,
    [event.botId, expectedUsername, expectedServerHost],
  );
  if (!bot.rowCount) {
    throw new AppError(403, 'BOT_NOT_AUTHORIZED', 'This bot cannot confirm account links');
  }
  const result = await client.query<{ id: string; normalized_username: string }>(
    `SELECT id, normalized_username FROM auth_link_challenges
      WHERE code_hash = $1 AND bot_id = $2
        AND completed_at IS NULL AND confirmed_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [sha256(event.code), event.botId],
  );
  const challenge = result.rows[0];
  if (!challenge)
    throw new AppError(404, 'LINK_CHALLENGE_NOT_FOUND', 'Link code is invalid or expired');
  if (challenge.normalized_username !== event.username.toLowerCase()) {
    conflict('LINK_USERNAME_MISMATCH', 'The in-game username does not match the requested account');
  }
  await client.query(
    `UPDATE auth_link_challenges SET confirmed_identity = $2, confirmed_username = $3, confirmed_at = now()
      WHERE id = $1`,
    [challenge.id, platformIdentityFor(event.username, event.identity), event.username],
  );
}

async function processDeposit(
  client: DbClient,
  event: z.infer<typeof depositEvent>,
  config: AppConfig,
): Promise<void> {
  const intentResult = await client.query<
    {
      id: string;
      user_id: string;
      bot_id: string;
      normalized_username: string;
      minecraft_identity: string;
      deposit_status: string;
      expires_at: Date;
      bot_status: string;
      reconciliation_status: string;
      transfer_capable: boolean;
      last_heartbeat_at: Date | null;
      last_snapshot_at: Date | null;
      lease_id: string | null;
      lease_bot_id: string | null;
      lease_token_hash: Buffer | null;
      lease_expires_at: Date | null;
    } & DepositEligibilityState
  >(
    `SELECT d.id, d.user_id, d.bot_id, d.status AS deposit_status, d.expires_at,
            u.normalized_username, u.minecraft_identity, u.status,
            u.country_code, u.terms_accepted_at,
            u.age_verified_at, u.kyc_status, r.cooldown_until, r.self_excluded_until,
            b.status AS bot_status, b.reconciliation_status,
            b.transfer_capable, b.last_heartbeat_at, b.last_snapshot_at,
            lease.authorization_event_id AS lease_id, lease.bot_id AS lease_bot_id,
            lease.token_hash AS lease_token_hash, lease.expires_at AS lease_expires_at
       FROM deposit_intents d
       JOIN users u ON u.id = d.user_id
       JOIN responsible_limits r ON r.user_id = u.id
       JOIN bot_accounts b ON b.id = d.bot_id
       LEFT JOIN deposit_authorization_leases lease ON lease.deposit_id = d.id
      WHERE d.deposit_code = $1 FOR UPDATE OF d, u, r, b`,
    [event.depositCode],
  );
  const intent = intentResult.rows[0];
  if (!intent) {
    // A signed bot has reported a physical hand-off that cannot be attributed to an intent.
    // Journal the event and stop automated custody until an operator reconciles the inventory.
    await quarantineBotAndJobs(client, event.botId, 'DEPOSIT_REVIEW_REQUIRED');
    return;
  }
  const leaseMatches =
    intent.lease_id === event.leaseId &&
    intent.lease_bot_id === event.botId &&
    intent.lease_token_hash !== null &&
    safeEqualBuffer(intent.lease_token_hash, sha256(event.leaseToken));
  if (
    intent.bot_id !== event.botId ||
    intent.normalized_username !== event.username.toLowerCase() ||
    intent.minecraft_identity !== event.identity ||
    !leaseMatches
  ) {
    await quarantineDeposit(client, intent.id, event.botId);
    return;
  }
  if (intent.deposit_status !== 'pending') {
    // The physical hand-off has already happened by the time this event arrives. Record the
    // event and fail safe instead of throwing (which would roll back the replay journal and
    // trigger endless retries). Confirmed intents stay immutable to prevent double credit.
    await quarantineDeposit(client, intent.id, event.botId);
    return;
  }
  const now = Date.now();
  const botIsSafe =
    config.minecraftTransfersEnabled &&
    intent.bot_status === 'online' &&
    intent.reconciliation_status === 'matched' &&
    intent.transfer_capable &&
    intent.last_heartbeat_at !== null &&
    now - intent.last_heartbeat_at.getTime() < 45_000 &&
    intent.last_snapshot_at !== null &&
    now - intent.last_snapshot_at.getTime() < 45_000;
  if (
    intent.expires_at.getTime() <= now ||
    intent.lease_expires_at === null ||
    intent.lease_expires_at.getTime() <= now ||
    !isDepositEligible(intent, config.allowedCountries, now, config.gameCurrencyOnly) ||
    !botIsSafe
  ) {
    await quarantineDeposit(client, intent.id, event.botId);
    return;
  }
  const aggregated = new Map<string, number>();
  for (const item of event.items)
    aggregated.set(item.fingerprint, (aggregated.get(item.fingerprint) ?? 0) + item.quantity);
  const fingerprints = [...aggregated.keys()];
  const catalogResult = await client.query<{ id: string; fingerprint: string }>(
    'SELECT id, fingerprint FROM catalog_items WHERE fingerprint = ANY($1::char(64)[]) AND enabled',
    [fingerprints],
  );
  if (catalogResult.rows.length !== fingerprints.length) {
    await quarantineDeposit(client, intent.id, event.botId);
    return;
  }
  for (const catalog of catalogResult.rows) {
    const quantity = aggregated.get(catalog.fingerprint);
    if (!quantity) continue;
    const lotId = randomUUID();
    await client.query(
      `INSERT INTO inventory_lots
         (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
       VALUES ($1, $2, $3, $4, $5, 'available', 'deposit', $6)`,
      [lotId, catalog.id, intent.user_id, event.botId, quantity, intent.id],
    );
    await client.query(
      `INSERT INTO custody_movements
         (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
       VALUES ($1, $2, $3, NULL, $4, $5, 'deposit', $6)`,
      [randomUUID(), catalog.id, event.botId, intent.user_id, quantity, intent.id],
    );
  }
  await client.query(
    "UPDATE deposit_intents SET status = 'confirmed', confirmed_at = now() WHERE id = $1",
    [intent.id],
  );
  await client.query(
    `UPDATE bot_accounts SET status = 'degraded', reconciliation_status = 'mismatch',
            transfer_capable = false, updated_at = now() WHERE id = $1`,
    [event.botId],
  );
}

/**
 * Records that a payment matching a pending login was seen in chat.
 * Confirmation is completed by the browser's status request, which resolves the current UUID for
 * the username carried by the strictly parsed DonutSMP system receipt.
 */
async function processPaymentObserved(
  client: DbClient,
  event: z.infer<typeof paymentEvent>,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM auth_link_challenges
      WHERE method = 'payment' AND bot_id = $1
        AND normalized_username = lower($2) AND pay_amount = $3
        AND completed_at IS NULL AND confirmed_at IS NULL AND expires_at > now()
      FOR UPDATE`,
    [event.botId, event.payer, event.amount],
  );
  const challenge = result.rows[0];
  // People pay the bot for reasons that have nothing to do with logging in. An unmatched payment
  // is ordinary, not an error, and must not fail the event or trigger a bot retry.
  if (!challenge) return;
  await client.query('UPDATE auth_link_challenges SET observed_payment_at = now() WHERE id = $1', [
    challenge.id,
  ]);
}

interface LinkedCashUserRow {
  id: string;
}

/** Expands the amount DonutSMP chose to show in its server-authored payment receipt. */
function displayedPaymentAmount(displayed: string): bigint | undefined {
  const match = /^([1-9]\d*)(?:\.(\d+))?([KMBT])?$/.exec(displayed);
  if (!match) return undefined;
  const scales: Record<string, bigint> = {
    '': 1n,
    K: 1_000n,
    M: 1_000_000n,
    B: 1_000_000_000n,
    T: 1_000_000_000_000n,
  };
  const fraction = match[2] ?? '';
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${match[1]}${fraction}`) * scales[match[3] ?? '']!;
  if (numerator % denominator !== 0n) return undefined;
  const amount = numerator / denominator;
  return amount > 0n && amount <= DATABASE_BIGINT_MAX ? amount : undefined;
}

/**
 * Attributes one structurally verified, server-authored receipt to a linked player. DonutSMP
 * abbreviates large amounts, so this deliberately credits the value shown in chat; information
 * omitted by that display cannot be recovered in chat-only mode.
 */
async function processCashPaymentObserved(
  client: DbClient,
  event: z.infer<typeof cashPaymentEvent>,
): Promise<void> {
  const amount = displayedPaymentAmount(event.displayedAmount);

  let status: 'credited' | 'login_payment' | 'unlinked' | 'manual_review' = 'manual_review';
  let userId: string | undefined;
  let walletBalanceAfter: string | undefined;
  /* Which key found the account. "Credited by name" is a materially weaker claim than "credited by
   * UUID", and the receipt records which one happened rather than leaving it to be inferred. */
  let attributedBy: 'uuid' | 'username' | undefined;

  if (amount !== undefined) {
    const login = await client.query<{ id: string }>(
      `SELECT id FROM auth_link_challenges
        WHERE method = 'payment' AND bot_id = $1
          AND normalized_username = lower($2) AND pay_amount = $3
          AND completed_at IS NULL AND confirmed_at IS NULL AND expires_at > now()
        ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [event.botId, event.payer, amount.toString()],
    );
    if (login.rowCount) {
      status = 'login_payment';
    } else {
      /* UUID first, name only as a fallback.
       *
       * Minecraft names are reassignable and an account row keeps its old name until its owner
       * logs in again, so `normalized_username` is not a reliable key for money arriving from the
       * server. A player who renamed had their own deposits land as `unlinked`; in the same window
       * a recycled name's payment could be credited to the previous holder. `minecraft_identity`
       * is what the account is actually keyed on, and it survives a rename.
       *
       * Bedrock deliberately never takes this path. A Floodgate player's identity here is
       * `bedrock:<name>` because the payment receipt cannot see their Floodgate UUID; matching the
       * one from the player list would give a single Bedrock player two identities and two
       * accounts. See lib/minecraft-username.ts. They keep the name guarantee they always had. */
      const account = event.payerUuid
        ? await client.query<LinkedCashUserRow>(
            'SELECT id FROM users WHERE minecraft_identity = $1 LIMIT 1 FOR UPDATE',
            [`mc:${event.payerUuid}`],
          )
        : await client.query<LinkedCashUserRow>(
            'SELECT id FROM users WHERE normalized_username = lower($1) LIMIT 1 FOR UPDATE',
            [event.payer],
          );
      attributedBy = event.payerUuid ? 'uuid' : 'username';
      userId = account.rows[0]?.id;
      if (userId) {
        walletBalanceAfter = await creditWallet(
          client,
          userId,
          amount,
          'cash_deposit',
          event.eventId,
        );
        status = 'credited';
      } else {
        status = 'unlinked';
      }
    }
  }

  await client.query(
    `INSERT INTO cash_payment_receipts
       (event_id, bot_id, payer_username, payer_uuid, displayed_amount, amount_minor, user_id,
        status, attributed_by, wallet_balance_after_minor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      event.eventId,
      event.botId,
      event.payer,
      event.payerUuid ?? null,
      event.displayedAmount,
      amount?.toString() ?? null,
      userId ?? null,
      status,
      attributedBy ?? null,
      walletBalanceAfter ?? null,
    ],
  );
}

async function processSnapshot(
  client: DbClient,
  event: z.infer<typeof snapshotEvent>,
  config: AppConfig,
): Promise<void> {
  const supplied = new Map<string, bigint>();
  for (const item of event.totals)
    supplied.set(item.fingerprint, (supplied.get(item.fingerprint) ?? 0n) + BigInt(item.quantity));
  const expectedResult = await client.query<{ fingerprint: string; quantity: string }>(
    `SELECT c.fingerprint, sum(i.quantity)::bigint AS quantity
       FROM inventory_lots i JOIN catalog_items c ON c.id = i.catalog_item_id
      WHERE i.bot_id = $1 AND i.state IN ('available', 'withdrawal_pending', 'quarantined')
      GROUP BY c.fingerprint`,
    [event.botId],
  );
  const expected = new Map(
    expectedResult.rows.map((row) => [row.fingerprint, BigInt(row.quantity)]),
  );
  // Every physical item must be represented in custody, including fingerprints that are
  // absent from the catalog. A completely full inventory is also taken out of service so
  // new deposits cannot be accepted without room for safe transfer handling.
  //
  // None of that applies to website-only items: the bot then holds nothing on a player's
  // behalf, so its own Minecraft inventory is not evidence of anything and must not
  // quarantine the account that logins and gameplay depend on. Snapshots are still
  // recorded either way, so enabling custody later starts from observed truth.
  const keys = new Set([...expected.keys(), ...supplied.keys()]);
  const countsMatch =
    !config.physicalCustodyEnabled ||
    [...keys].every((key) => (expected.get(key) ?? 0n) === (supplied.get(key) ?? 0n));
  const capacitySafe = !config.physicalCustodyEnabled || event.occupiedSlots < event.capacitySlots;
  const matched = countsMatch && capacitySafe;
  const totalsObject = Object.fromEntries(
    [...supplied.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fingerprint, quantity]) => [fingerprint, Number(quantity)]),
  );
  for (const item of event.totals) {
    await client.query(
      `INSERT INTO observed_bot_items
         (bot_id, fingerprint, minecraft_name, display_name, metadata, last_quantity, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (bot_id, fingerprint) DO UPDATE SET minecraft_name = EXCLUDED.minecraft_name,
         display_name = EXCLUDED.display_name, metadata = EXCLUDED.metadata,
         last_quantity = EXCLUDED.last_quantity, last_seen_at = now()`,
      [
        event.botId,
        item.fingerprint,
        item.minecraftName,
        item.displayName,
        item.metadata,
        item.quantity,
      ],
    );
  }
  await client.query(
    `INSERT INTO bot_inventory_snapshots(id, bot_id, event_id, totals, matched)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), event.botId, event.eventId, JSON.stringify(totalsObject), matched],
  );
  if (!countsMatch) await quarantineBotAndJobs(client, event.botId, 'INVENTORY_MISMATCH');
  await client.query(
    `UPDATE bot_accounts SET last_snapshot_at = now(), reconciliation_status = $2::varchar,
            status = CASE WHEN status = 'quarantined' THEN 'quarantined'
                          WHEN $2 = 'matched'
                            AND last_heartbeat_at > now() - interval '45 seconds'
                          THEN 'online' ELSE 'degraded' END,
            transfer_capable = CASE
              WHEN status = 'quarantined' THEN false
              WHEN $2 = 'matched' THEN transfer_capable
              ELSE false END,
            updated_at = now()
      WHERE id = $1`,
    [event.botId, matched ? 'matched' : 'mismatch'],
  );
}

async function quarantineDeposit(
  client: DbClient,
  depositId: string,
  botId: string,
): Promise<void> {
  await client.query(
    `UPDATE deposit_intents SET status = 'manual_review'
      WHERE id = $1 AND status <> 'confirmed'`,
    [depositId],
  );
  await quarantineBotAndJobs(client, botId, 'DEPOSIT_REVIEW_REQUIRED');
}

async function quarantineBotAndJobs(
  client: DbClient,
  botId: string,
  errorCode: string,
): Promise<void> {
  await client.query(
    `UPDATE bot_accounts SET status = 'quarantined', reconciliation_status = 'mismatch',
            transfer_capable = false, updated_at = now() WHERE id = $1`,
    [botId],
  );
  const jobs = await client.query<{ reference_id: string }>(
    `UPDATE bot_jobs SET status = 'dead_letter', last_error_code = $2,
            lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE bot_id = $1 AND status IN ('queued', 'leased')
      RETURNING reference_id`,
    [botId, errorCode],
  );
  if (jobs.rows.length) {
    await client.query(
      `UPDATE withdrawals SET status = 'manual_review', error_code = $2, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status IN ('queued', 'processing')`,
      [jobs.rows.map((row) => row.reference_id), errorCode],
    );
  }
}

async function processJobResult(
  client: DbClient,
  event: z.infer<typeof jobResultEvent>,
): Promise<void> {
  const result = await client.query<{
    id: string;
    kind: string;
    reference_id: string;
    attempts: number;
    status: string;
    lease_token_hash: Buffer | null;
    lease_expires_at: Date | null;
  }>(
    `SELECT id, kind, reference_id, attempts, status, lease_token_hash, lease_expires_at
       FROM bot_jobs WHERE id = $1 AND bot_id = $2 FOR UPDATE`,
    [event.jobId, event.botId],
  );
  const job = result.rows[0];
  const suppliedTokenHash = sha256(event.leaseToken);
  const validLease =
    job?.status === 'leased' &&
    job.lease_token_hash !== null &&
    safeEqualBuffer(job.lease_token_hash, suppliedTokenHash) &&
    job.lease_expires_at !== null &&
    job.lease_expires_at.getTime() >= Date.now();
  if (!job || !validLease) {
    // A result can follow a physical transfer. Keep the replay journal committed and fail
    // closed instead of throwing it away and inviting endless retries or automatic reuse.
    await quarantineBotAndJobs(client, event.botId, 'INVALID_JOB_LEASE');
    if (job?.kind === 'cash_payout' && job.status !== 'completed') {
      await client.query(
        `UPDATE cash_withdrawals SET status = 'manual_review', error_code = 'INVALID_JOB_LEASE',
                updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'processing')`,
        [job.reference_id],
      );
      await client.query(
        `UPDATE bot_jobs SET status = 'dead_letter', last_error_code = 'INVALID_JOB_LEASE',
                lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'completed'`,
        [job.id],
      );
    }
    if (job?.kind === 'withdrawal' && job.status !== 'completed') {
      await client.query(
        `UPDATE withdrawals SET status = 'manual_review', error_code = 'INVALID_JOB_LEASE',
                updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'processing')`,
        [job.reference_id],
      );
      await client.query(
        `UPDATE bot_jobs SET status = 'dead_letter', last_error_code = 'INVALID_JOB_LEASE',
                lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND status <> 'completed'`,
        [job.id],
      );
    }
    return;
  }
  if (event.outcome === 'completed') {
    /* A cash payout moves a number through the server's own /pay and never opens the bot's
     * inventory, so it is held to liveness alone. Requiring transfer_capable and a matched
     * inventory reconciliation here would dead-letter every payout on a platform where physical
     * item transfer is deliberately switched off. */
    const cashOnly =
      job.kind === 'cash_payout' || job.kind === 'admin_payout' || job.kind === 'reconnect';
    const safeBot =
      cashOnly
        ? await client.query(
            `SELECT 1 FROM bot_accounts
              WHERE id = $1 AND status = 'online'
                AND last_heartbeat_at > now() - interval '45 seconds'
              FOR SHARE`,
            [event.botId],
          )
        : await client.query(
            `SELECT 1 FROM bot_accounts
              WHERE id = $1 AND status = 'online' AND reconciliation_status = 'matched'
                AND transfer_capable
                AND last_heartbeat_at > now() - interval '45 seconds'
                AND last_snapshot_at > now() - interval '90 seconds'
              FOR SHARE`,
            [event.botId],
          );
    if (!safeBot.rowCount) {
      await client.query(
        `UPDATE bot_jobs SET status = 'dead_letter', last_error_code = 'BOT_STATE_UNSAFE',
                lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = $1`,
        [job.id],
      );
      if (job.kind === 'withdrawal') {
        await client.query(
          `UPDATE withdrawals SET status = 'manual_review', error_code = 'BOT_STATE_UNSAFE',
                  updated_at = now() WHERE id = $1`,
          [job.reference_id],
        );
      }
      if (job.kind === 'cash_payout') {
        await client.query(
          `UPDATE cash_withdrawals SET status = 'manual_review', error_code = 'BOT_STATE_UNSAFE',
                  updated_at = now() WHERE id = $1 AND status IN ('queued', 'processing')`,
          [job.reference_id],
        );
      }
      if (job.kind === 'admin_payout') {
        await client.query(
          `UPDATE admin_payouts SET status = 'manual_review', error_code = 'BOT_STATE_UNSAFE',
                  updated_at = now() WHERE id = $1 AND status IN ('queued', 'processing')`,
          [job.reference_id],
        );
      }
      return;
    }
    await client.query(
      "UPDATE bot_jobs SET status = 'completed', lease_token_hash = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1",
      [job.id],
    );
    if (job.kind === 'withdrawal') await completeWithdrawal(client, job.reference_id);
    if (job.kind === 'cash_payout') {
      await client.query(
        `UPDATE cash_withdrawals SET status = 'paid', paid_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'processing')`,
        [job.reference_id],
      );
    }
    if (job.kind === 'admin_payout') {
      await client.query(
        `UPDATE admin_payouts SET status = 'paid', paid_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'processing')`,
        [job.reference_id],
      );
    }
    /* A reconnect settles by completing and nothing else. It references no row, moves no money,
     * and the proof it worked is the heartbeat that follows. */
    return;
  }
  const terminal = !event.retryable || job.attempts >= 5;
  await client.query(
    `UPDATE bot_jobs SET status = $2, available_at = now() + (LEAST(attempts * attempts, 60) * interval '1 second'),
            lease_token_hash = NULL, lease_expires_at = NULL, last_error_code = $3, updated_at = now()
      WHERE id = $1`,
    [job.id, terminal ? 'dead_letter' : 'queued', event.errorCode ?? 'BOT_JOB_FAILED'],
  );
  if (job.kind === 'cash_payout') {
    /* Refunding is only safe on the one error the bot raises when the command never reached the
     * server. Every other failure might sit on the far side of a payout that did land, and paying
     * a second time is worse than making one person wait for a human to look. */
    if (terminal && event.errorCode === 'PAYOUT_NOT_SENT') {
      await refundWithdrawal(client, job.reference_id, 'PAYOUT_NOT_SENT');
    } else {
      await client.query(
        `UPDATE cash_withdrawals SET status = $2, error_code = $3, updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'processing')`,
        [
          job.reference_id,
          terminal ? 'manual_review' : 'queued',
          event.errorCode ?? 'BOT_JOB_FAILED',
        ],
      );
    }
  }
  if (job.kind === 'admin_payout') {
    /* No refund arm, and deliberately no fallback to crediting the site wallet. An admin payout
     * debited nobody, so there is nothing to give back; the honest outcome of a failed one is a
     * failed row an operator can see and decide about. */
    await client.query(
      `UPDATE admin_payouts SET status = $2, error_code = $3, updated_at = now()
        WHERE id = $1 AND status IN ('queued', 'processing')`,
      [
        job.reference_id,
        terminal ? 'failed' : 'queued',
        event.errorCode ?? 'BOT_JOB_FAILED',
      ],
    );
  }
  if (job.kind === 'withdrawal') {
    await client.query(
      'UPDATE withdrawals SET status = $2, error_code = $3, updated_at = now() WHERE id = $1',
      [
        job.reference_id,
        terminal ? 'manual_review' : 'queued',
        event.errorCode ?? 'BOT_JOB_FAILED',
      ],
    );
  }
}

async function completeWithdrawal(client: DbClient, withdrawalId: string): Promise<void> {
  const withdrawal = await client.query<{ user_id: string }>(
    "SELECT user_id FROM withdrawals WHERE id = $1 AND status = 'processing' FOR UPDATE",
    [withdrawalId],
  );
  const row = withdrawal.rows[0];
  if (!row) conflict('WITHDRAWAL_STATE_INVALID', 'Withdrawal is not processing');
  const lines = await client.query<{
    inventory_lot_id: string;
    catalog_item_id: string;
    bot_id: string;
    quantity: number;
  }>(
    `SELECT wl.inventory_lot_id, wl.catalog_item_id, i.bot_id, wl.quantity
       FROM withdrawal_lines wl JOIN inventory_lots i ON i.id = wl.inventory_lot_id
      WHERE wl.withdrawal_id = $1 FOR UPDATE OF i`,
    [withdrawalId],
  );
  if (!lines.rowCount) throw new Error('Processing withdrawal has no reserved inventory lines');
  for (const line of lines.rows) {
    const consumed = await client.query(
      "UPDATE inventory_lots SET state = 'withdrawn', updated_at = now() WHERE id = $1 AND state = 'withdrawal_pending'",
      [line.inventory_lot_id],
    );
    if (consumed.rowCount !== 1) {
      throw new Error('Reserved withdrawal inventory is not in the expected state');
    }
    await client.query(
      `INSERT INTO custody_movements
         (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
       VALUES ($1, $2, $3, $4, NULL, $5, 'withdrawal', $6)`,
      [randomUUID(), line.catalog_item_id, line.bot_id, row.user_id, line.quantity, withdrawalId],
    );
  }
  await client.query(
    "UPDATE withdrawals SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1",
    [withdrawalId],
  );
  await client.query(
    `UPDATE bot_accounts SET status = 'degraded', reconciliation_status = 'mismatch',
            transfer_capable = false, updated_at = now()
      WHERE id = (SELECT bot_id FROM withdrawals WHERE id = $1)`,
    [withdrawalId],
  );
}
