import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256, sha256Hex } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { isDepositEligible, type DepositEligibilityState } from '../lib/eligibility.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

const withdrawalSchema = z.object({
  items: z
    .array(
      z
        .object({ inventoryLotId: z.uuid(), quantity: z.number().int().min(1).max(2304) })
        .strict(),
    )
    .min(1)
    .max(20),
}).strict();
const depositSchema = z.object({}).strict();
const idSchema = z.object({ id: z.uuid() }).strict();

function code(length: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export async function registerTransferRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];

  app.post('/v1/deposits', { preHandler: guards.requireCsrf }, async (request, reply) => {
    const body = parseWith(depositSchema, request.body ?? {});
    const userId = request.authUser?.id;
    if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const requestHash = sha256Hex(canonicalJson(body));
    const created = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8832))', [
        `${userId}:${idempotencyKey}`,
      ]);
      const user = await client.query<DepositEligibilityState>(
        `SELECT account.status, account.country_code, account.terms_accepted_at,
                account.age_verified_at, account.kyc_status, limits.cooldown_until,
                limits.self_excluded_until
           FROM users account
           JOIN responsible_limits limits ON limits.user_id = account.id
          WHERE account.id = $1
          FOR UPDATE OF account, limits`,
        [userId],
      );
      if (!isDepositEligible(user.rows[0], config.allowedCountries)) {
        throw new AppError(403, 'ACCOUNT_RESTRICTED', 'Account cannot create deposits');
      }
      const existing = await client.query<{
        id: string;
        bot_id: string;
        deposit_code: string;
        status: string;
        expires_at: Date;
        created_at: Date;
        username: string;
        request_hash: string;
      }>(
        `SELECT d.id, d.bot_id, d.deposit_code, d.status, d.expires_at, d.created_at,
                d.request_hash, b.username
           FROM deposit_intents d JOIN bot_accounts b ON b.id = d.bot_id
          WHERE d.user_id = $1 AND d.idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.request_hash !== requestHash) {
          conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
        }
        const deposit = {
          id: prior.id,
          bot_id: prior.bot_id,
          deposit_code: prior.deposit_code,
          status: prior.status,
          expires_at: prior.expires_at,
          created_at: prior.created_at,
          username: prior.username,
        };
        return { deposit, replay: true };
      }
      const botResult = await client.query<{ id: string; username: string }>(
        `SELECT id, username FROM bot_accounts
          WHERE id = ANY($1::uuid[]) AND status = 'online' AND reconciliation_status = 'matched'
            AND last_heartbeat_at > now() - interval '45 seconds'
            AND last_snapshot_at > now() - interval '45 seconds'
            AND transfer_capable
          ORDER BY last_heartbeat_at DESC LIMIT 1 FOR SHARE`,
        [provisionedBotIds],
      );
      const bot = botResult.rows[0];
      if (!bot) throw new AppError(503, 'BOT_UNAVAILABLE', 'No reconciled deposit bot is online');
      const depositCode = code(12);
      const result = await client.query<{
        id: string;
        bot_id: string;
        deposit_code: string;
        status: string;
        expires_at: Date;
        created_at: Date;
      }>(
        `INSERT INTO deposit_intents
           (id, user_id, bot_id, deposit_code, idempotency_key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')
         RETURNING id, bot_id, deposit_code, status, expires_at, created_at`,
        [randomUUID(), userId, bot.id, depositCode, idempotencyKey, requestHash],
      );
      const deposit = result.rows[0];
      if (!deposit) throw new Error('Deposit insert returned no row');
      return { deposit: { ...deposit, username: bot.username }, replay: false };
    });
    return reply.code(created.replay ? 200 : 201).send({
      deposit: created.deposit,
      instruction: `Send this exact message in signed public Minecraft chat: deposit ${created.deposit.deposit_code}`,
      warning: 'Only items shown in the bot trade confirmation are credited.',
    });
  });

  app.get('/v1/deposits', { preHandler: guards.authenticate }, async (request) => {
    const result = await db.query(
      `SELECT id, bot_id, status, expires_at, confirmed_at, created_at
         FROM deposit_intents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [request.authUser?.id],
    );
    return { deposits: result.rows };
  });

  app.post('/v1/withdrawals', { preHandler: guards.requireCsrf }, async (request, reply) => {
    const body = parseWith(withdrawalSchema, request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const userId = request.authUser?.id;
    if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
    const ids = body.items.map((item) => item.inventoryLotId);
    if (new Set(ids).size !== ids.length)
      throw new AppError(400, 'DUPLICATE_ITEM', 'Inventory lots must be unique');
    const requestHash = sha256Hex(canonicalJson(body));

    const deliveryCode = code(12);
    const created = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8833))', [
        `${userId}:${idempotencyKey}`,
      ]);
      const previous = await client.query<{
        id: string;
        bot_id: string;
        status: string;
        created_at: Date;
        delivery_code_ciphertext: string;
        request_hash: string;
      }>(
        `SELECT id, bot_id, status, created_at, delivery_code_ciphertext, request_hash
           FROM withdrawals WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (previous.rows[0]) {
        const prior = previous.rows[0];
        if (prior.request_hash !== requestHash) {
          conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
        }
        const withdrawal = {
          id: prior.id,
          bot_id: prior.bot_id,
          status: prior.status,
          created_at: prior.created_at,
        };
        return {
          withdrawal,
          deliveryCode: decryptSecret(
            prior.delivery_code_ciphertext,
            config.dataEncryptionKey,
            `withdrawal:${prior.id}`,
          ),
          replay: true,
        };
      }
      const lots = await client.query<{
        id: string;
        bot_id: string;
        catalog_item_id: string;
        quantity: number;
        fingerprint: string;
        minecraft_name: string;
        display_name: string;
      }>(
        `SELECT i.id, i.bot_id, i.catalog_item_id, i.quantity, c.fingerprint,
                c.minecraft_name, c.display_name
           FROM inventory_lots i JOIN catalog_items c ON c.id = i.catalog_item_id
          WHERE i.owner_user_id = $1 AND i.id = ANY($2::uuid[]) AND i.state = 'available'
          ORDER BY i.id FOR UPDATE OF i`,
        [userId, ids],
      );
      if (lots.rows.length !== ids.length)
        conflict('ITEM_UNAVAILABLE', 'One or more items are unavailable');
      const lotMap = new Map(lots.rows.map((lot) => [lot.id, lot]));
      const botIds = new Set(lots.rows.map((lot) => lot.bot_id));
      if (botIds.size !== 1) {
        throw new AppError(
          400,
          'MULTIPLE_BOTS',
          'Create separate withdrawals for items held by different bots',
        );
      }
      const botId = [...botIds][0];
      if (!botId) throw new Error('Withdrawal has no bot');
      const availableBot = await client.query<{ id: string }>(
        `SELECT id FROM bot_accounts
          WHERE id = $1 AND id = ANY($2::uuid[])
            AND status = 'online' AND reconciliation_status = 'matched'
            AND last_heartbeat_at > now() - interval '45 seconds'
            AND last_snapshot_at > now() - interval '45 seconds'
            AND transfer_capable
          FOR SHARE`,
        [botId, provisionedBotIds],
      );
      if (!availableBot.rows[0]) {
        throw new AppError(503, 'BOT_UNAVAILABLE', 'The custody bot cannot safely transfer items');
      }
      const withdrawalId = randomUUID();
      await client.query(
        `INSERT INTO withdrawals
           (id, user_id, bot_id, idempotency_key, request_hash,
            delivery_code_hash, delivery_code_ciphertext)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          withdrawalId,
          userId,
          botId,
          idempotencyKey,
          requestHash,
          sha256(deliveryCode),
          encryptSecret(deliveryCode, config.dataEncryptionKey, `withdrawal:${withdrawalId}`),
        ],
      );
      const jobItems: Array<Record<string, unknown>> = [];
      for (const requested of body.items) {
        const lot = lotMap.get(requested.inventoryLotId);
        if (!lot || requested.quantity > lot.quantity)
          conflict('QUANTITY_INVALID', 'Requested quantity exceeds inventory');
        let reservedLotId = lot.id;
        if (requested.quantity < lot.quantity) {
          await client.query(
            'UPDATE inventory_lots SET quantity = quantity - $2, updated_at = now() WHERE id = $1',
            [lot.id, requested.quantity],
          );
          reservedLotId = randomUUID();
          await client.query(
            `INSERT INTO inventory_lots
               (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
             VALUES ($1, $2, $3, $4, $5, 'withdrawal_pending', 'withdrawal_return', $6)`,
            [
              reservedLotId,
              lot.catalog_item_id,
              userId,
              lot.bot_id,
              requested.quantity,
              withdrawalId,
            ],
          );
        } else {
          await client.query(
            "UPDATE inventory_lots SET state = 'withdrawal_pending', updated_at = now() WHERE id = $1",
            [lot.id],
          );
        }
        await client.query(
          `INSERT INTO withdrawal_lines(withdrawal_id, inventory_lot_id, catalog_item_id, quantity)
           VALUES ($1, $2, $3, $4)`,
          [withdrawalId, reservedLotId, lot.catalog_item_id, requested.quantity],
        );
        jobItems.push({
          fingerprint: lot.fingerprint,
          minecraftName: lot.minecraft_name,
          displayName: lot.display_name,
          quantity: requested.quantity,
        });
      }
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO bot_jobs(id, bot_id, kind, reference_id, payload)
         VALUES ($1, $2, 'withdrawal', $3, $4)`,
        [
          jobId,
          botId,
          withdrawalId,
          JSON.stringify({
            withdrawalId,
            player: request.authUser?.minecraftUsername,
            playerIdentity: request.authUser?.minecraftIdentity,
            deliveryCodeHash: sha256(deliveryCode).toString('hex'),
            items: jobItems,
          }),
        ],
      );
      return {
        withdrawal: { id: withdrawalId, bot_id: botId, status: 'queued' },
        deliveryCode,
        replay: false,
      };
    });
    return reply
      .code(created.replay ? 200 : 201)
      .send({ withdrawal: created.withdrawal, deliveryCode: created.deliveryCode });
  });

  app.get('/v1/withdrawals', { preHandler: guards.authenticate }, async (request) => {
    const result = await db.query(
      `SELECT id, bot_id, status, attempts, error_code, completed_at, created_at, updated_at
         FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [request.authUser?.id],
    );
    return { withdrawals: result.rows };
  });

  app.delete('/v1/withdrawals/:id', { preHandler: guards.requireCsrf }, async (request, reply) => {
    const params = parseWith(idSchema, request.params);
    await db.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT w.id FROM withdrawals w JOIN bot_jobs j ON j.reference_id = w.id AND j.kind = 'withdrawal'
          WHERE w.id = $1 AND w.user_id = $2 AND w.status = 'queued' AND j.status = 'queued'
          FOR UPDATE OF w, j`,
        [params.id, request.authUser?.id],
      );
      if (!result.rows[0])
        conflict('WITHDRAWAL_NOT_CANCELLABLE', 'Withdrawal is no longer cancellable');
      await client.query(
        "UPDATE bot_jobs SET status = 'failed', last_error_code = 'USER_CANCELLED', updated_at = now() WHERE reference_id = $1",
        [params.id],
      );
      await client.query(
        "UPDATE withdrawals SET status = 'failed', error_code = 'USER_CANCELLED', updated_at = now() WHERE id = $1",
        [params.id],
      );
      await client.query(
        `UPDATE inventory_lots SET state = 'available', updated_at = now()
          WHERE id IN (SELECT inventory_lot_id FROM withdrawal_lines WHERE withdrawal_id = $1)
            AND state = 'withdrawal_pending'`,
        [params.id],
      );
    });
    return reply.code(204).send();
  });
}
