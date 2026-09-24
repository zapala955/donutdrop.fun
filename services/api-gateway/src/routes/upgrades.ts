import { randomUUID } from 'node:crypto';
import {
  calculateWinChancePpm,
  createFairRoll,
  generateServerSeed,
  hashServerSeed,
} from '@donut/provably-fair';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { creditWallet, recordQuestProgress, recordWager } from '../lib/cash-settlement.js';
import { announceWin } from '../lib/discord-flex.js';
import type { WagerOutcome } from '../lib/cash-settlement.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

const fixedItemValuePattern = /^[1-9]\d{0,18}$/;
const fixedItemValueSchema = z
  .string()
  .regex(fixedItemValuePattern)
  .refine(
    (value) => fixedItemValuePattern.test(value) && BigInt(value) <= POSTGRES_BIGINT_MAX,
    'Value exceeds database range',
  );
const clientSeedSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 128, 'Must not exceed 128 UTF-8 bytes')
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      }),
    'Must not contain control characters',
  );
const inventorySelectionSchema = z
  .object({
    inventoryLotId: z.uuid(),
    quantity: z.number().int().min(1).max(2304),
    expectedUnitValueMinor: fixedItemValueSchema,
  })
  .strict();
/* A cash stake reuses the fixed-value string shape: a positive integer of minor units inside the
 * database's bigint range. It is not an item, so it carries no expected price to re-check — the
 * amount the client sent IS the amount the wallet is debited, and the wallet's own balance check
 * is the only authority that matters. */
const balanceSelectionSchema = z
  .object({
    balanceMinor: fixedItemValueSchema,
  })
  .strict();
const upgradeSchema = z
  .object({
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetCatalogItemId: z.uuid(),
    targetQuantity: z.number().int().min(1).max(2304).default(1),
    expectedTargetUnitValueMinor: fixedItemValueSchema,
    stakes: z.array(inventorySelectionSchema).min(1).max(20).optional(),
    balanceStake: balanceSelectionSchema.optional(),
  })
  .strict()
  /* Exactly one source of value per round. Both would mean two different debits racing for one
   * chance figure; neither would mean a free roll. The shape is rejected before anything is
   * locked so neither case can reach the transaction. */
  .refine((body) => (body.stakes === undefined) !== (body.balanceStake === undefined), {
    message: 'Provide either stakes or balanceStake, not both',
    path: ['stakes'],
  });
const historyQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    before: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const verifySchema = z
  .object({
    serverSeed: z.string().regex(/^[a-f0-9]{64}$/),
    clientSeed: clientSeedSchema,
    nonce: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

interface StakeRow {
  id: string;
  catalog_item_id: string;
  bot_id: string;
  quantity: number;
  unit_value_minor: string;
}

/**
 * upgrader_rounds rows are handed to the client whole, so only the column this route reads is
 * named. The rest stay `unknown` rather than `any`, which keeps an unchecked value from
 * silently flowing into application logic.
 */
interface UpgraderRoundRow {
  request_hash: string;
  [column: string]: unknown;
}

interface TargetStockRow {
  id: string;
  bot_id: string;
  quantity: number;
}

export async function registerUpgradeRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];

  /* Public, like /v1/roulette. Nothing here depends on who is asking -- it is the house's published
   * terms -- and the lobby's Upgrader card quotes the top multiplier and the stake ceiling from it
   * to visitors who have not signed in yet. Behind a session, that card showed two em dashes to
   * exactly the people it was meant to persuade. */
  app.get('/v1/upgrades/config', async () => ({
    algorithm: 'HMAC-SHA256-v1',
    houseEdgeBps: config.houseEdgeBps,
    minMultiplierBps: config.minMultiplierBps,
    maxMultiplierBps: config.maxMultiplierBps,
    maxWinChancePpm: config.maxWinChancePpm,
    maxStakeMinor: config.upgradeMaxStakeMinor.toString(),
    currency: null,
    itemValuesAreFixed: true,
    // The upgrader takes either a custody lot or cash off the wallet. The client needs to know
    // the cash route exists before it offers it, rather than discovering it from a rejection.
    balanceStakesEnabled: true,
  }));

  app.get('/v1/fairness/current', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const seed = await ensureFairnessSeed(db, config, userId);
    return {
      serverSeedHash: seed.server_seed_hash,
      nonce: seed.nonce,
      algorithm: 'HMAC-SHA256-v1',
    };
  });

  /* Public by design — anyone must be able to replay a roll without an account, or the
   * verification is not independent. It is still bounded: the handler does HMAC work per call,
   * which makes an unlimited endpoint a free CPU amplifier, and an unthrottled oracle is a gift
   * to anyone probing the construction. */
  app.post(
    '/v1/fairness/verify',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseWith(verifySchema, request.body);
      const roll = createFairRoll(body.serverSeed, body.clientSeed, body.nonce);
      return { serverSeedHash: hashServerSeed(body.serverSeed), ...roll };
    },
  );

  app.post(
    '/v1/upgrades',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = parseWith(upgradeSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const userId = requireUserId(request.authUser?.id);
      const itemStakes = body.stakes;
      const stakeIds = itemStakes?.map((stake) => stake.inventoryLotId) ?? [];
      if (new Set(stakeIds).size !== stakeIds.length) {
        throw new AppError(400, 'DUPLICATE_STAKE', 'Each inventory lot may only appear once');
      }
      const requestHash = sha256Hex(canonicalJson(body));

      const settled = await db.transaction<{
        round: UpgraderRoundRow | undefined;
        /* Null on an idempotent replay: that round's wager was recorded the first time, and a
         * replay must not re-announce a win the feed already carries. */
        wager: WagerOutcome | null;
        stakeValue: bigint;
      }>(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 8831))', [
          `${userId}:${idempotencyKey}`,
        ]);
        const existing = await client.query<UpgraderRoundRow>(
          'SELECT * FROM upgrader_rounds WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return { round: existing.rows[0], wager: null, stakeValue: 0n };
        }

        await assertGameEligible(client, userId);

        const fairnessResult = await client.query<FairnessRow>(
          `SELECT id, server_seed_ciphertext, server_seed_hash, nonce
             FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
          [userId],
        );
        const fairness = fairnessResult.rows[0];
        if (!fairness) {
          throw new AppError(
            409,
            'FAIRNESS_COMMITMENT_REQUIRED',
            'Fetch the current server-seed commitment before upgrading',
          );
        }
        if (fairness.server_seed_hash !== body.serverSeedHash) {
          conflict(
            'FAIRNESS_COMMITMENT_CHANGED',
            'The supplied server-seed commitment is no longer active',
          );
        }

        /* Where the wagered value comes from. Both branches produce one figure — stakeValue —
         * and everything downstream (multiplier bounds, daily limit, chance, the recorded round)
         * reads only that, so the two stake shapes cannot diverge in how they are priced.
         *
         * The wallet is locked here, in the slot the lot lock occupies for an item round, so a
         * user only ever holds one of the two. Both paths already hold this user's fairness seed
         * row, which serializes a cash upgrade against a concurrent case open, so taking the
         * wallet before the target stock cannot deadlock against that route's opposite order. */
        const stakeById = new Map<string, StakeRow>();
        let stakeValue = 0n;
        let balanceAfterMinor: string | null = null;

        if (body.balanceStake) {
          stakeValue = BigInt(body.balanceStake.balanceMinor);
          if (stakeValue > config.upgradeMaxStakeMinor) {
            throw new AppError(
              400,
              'STAKE_TOO_LARGE',
              `The most a single upgrade may stake is ${config.upgradeMaxStakeMinor.toString()}`,
            );
          }
          await client.query(
            `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId],
          );
          const wallet = await client.query<{ balance_minor: string }>(
            'SELECT balance_minor FROM user_wallets WHERE user_id = $1 FOR UPDATE',
            [userId],
          );
          if (BigInt(wallet.rows[0]?.balance_minor ?? '0') < stakeValue) {
            throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for this stake');
          }
        } else {
          if (!itemStakes) throw new Error('Upgrade passed validation with no stake');
          const stakesResult = await client.query<StakeRow>(
            `SELECT i.id, i.catalog_item_id, i.bot_id, i.quantity, c.unit_value_minor
               FROM inventory_lots i
               JOIN catalog_items c ON c.id = i.catalog_item_id
               JOIN bot_accounts b ON b.id = i.bot_id
              WHERE i.owner_user_id = $1 AND i.id = ANY($2::uuid[]) AND i.state = 'available'
                AND c.enabled AND b.status = 'online' AND b.reconciliation_status = 'matched'
                AND b.id = ANY($3::uuid[])
                AND b.last_heartbeat_at > now() - interval '45 seconds'
                AND b.last_snapshot_at > now() - interval '45 seconds'
                AND b.transfer_capable
              ORDER BY i.id FOR UPDATE OF i, c FOR SHARE OF b`,
            [userId, stakeIds, provisionedBotIds],
          );
          if (stakesResult.rows.length !== stakeIds.length) {
            conflict(
              'STAKE_UNAVAILABLE',
              'One or more stake items are unavailable or unreconciled',
            );
          }
          for (const row of stakesResult.rows) stakeById.set(row.id, row);
          for (const selected of itemStakes) {
            const row = stakeById.get(selected.inventoryLotId);
            if (!row || selected.quantity > row.quantity)
              conflict('STAKE_QUANTITY_INVALID', 'Stake quantity exceeds inventory');
            assertExpectedPrice(row.unit_value_minor, selected.expectedUnitValueMinor, 'stake');
            stakeValue = checkedItemValue(
              stakeValue,
              BigInt(row.unit_value_minor),
              selected.quantity,
            );
          }
        }
        const catalog = await client.query<{ id: string; unit_value_minor: string }>(
          'SELECT id, unit_value_minor FROM catalog_items WHERE id = $1 AND enabled FOR SHARE',
          [body.targetCatalogItemId],
        );
        const target = catalog.rows[0];
        if (!target) throw new AppError(404, 'TARGET_NOT_FOUND', 'Target item is unavailable');
        assertExpectedPrice(target.unit_value_minor, body.expectedTargetUnitValueMinor, 'target');
        const targetValue = checkedItemValue(
          0n,
          BigInt(target.unit_value_minor),
          body.targetQuantity,
        );
        if (targetValue * 10_000n < stakeValue * BigInt(config.minMultiplierBps)) {
          throw new AppError(400, 'MULTIPLIER_TOO_LOW', 'Target value is too close to stake value');
        }
        if (targetValue * 10_000n > stakeValue * BigInt(config.maxMultiplierBps)) {
          throw new AppError(
            400,
            'MULTIPLIER_TOO_HIGH',
            'Target value exceeds the maximum multiplier',
          );
        }

        const stock = await client.query<TargetStockRow>(
          `SELECT i.id, i.bot_id, i.quantity
             FROM inventory_lots i JOIN bot_accounts b ON b.id = i.bot_id
             WHERE i.owner_user_id IS NULL AND i.catalog_item_id = $1 AND i.state = 'available'
               AND b.status = 'online' AND b.reconciliation_status = 'matched'
               AND b.id = ANY($2::uuid[])
               AND b.last_heartbeat_at > now() - interval '45 seconds'
               AND b.last_snapshot_at > now() - interval '45 seconds'
               AND b.transfer_capable
             ORDER BY i.bot_id, i.created_at, i.id FOR UPDATE OF i FOR SHARE OF b`,
          [body.targetCatalogItemId, provisionedBotIds],
        );
        /* Cash-only play awards no lot at all: the prize is credited to the wallet and nothing
         * leaves custody. There is therefore no stock to check and no bot for an award to hang
         * off, so the whole gate is skipped.
         *
         * It previously was not, and the live-bot fallback below rejected rounds with
         * TARGET_OUT_OF_STOCK whenever the bot's heartbeat aged past 45 seconds — which, with no
         * bot process actually running, is most of the time. The prize had nothing to do with a
         * bot; the check was inherited from the item era and nobody had removed it. */
        if (config.cashOnlyPlay) {
          // nothing to reserve
        } else if (!config.houseStockUnlimited) {
          if (
            stock.rows.reduce((sum, row) => sum + BigInt(row.quantity), 0n) <
            BigInt(body.targetQuantity)
          ) {
            conflict('TARGET_OUT_OF_STOCK', 'Target item is out of stock');
          }
        } else if (!stock.rows.length) {
          const liveBot = await client.query<{ id: string }>(
            `SELECT b.id FROM bot_accounts b
              WHERE b.status = 'online' AND b.reconciliation_status = 'matched'
                AND b.id = ANY($1::uuid[])
                AND b.last_heartbeat_at > now() - interval '45 seconds'
                AND b.last_snapshot_at > now() - interval '45 seconds'
                AND b.transfer_capable
              ORDER BY b.id LIMIT 1`,
            [provisionedBotIds],
          );
          const fallbackBot = liveBot.rows[0];
          if (!fallbackBot) conflict('TARGET_OUT_OF_STOCK', 'No custody bot is available');
          else stock.rows.push({ id: '', bot_id: fallbackBot.id, quantity: body.targetQuantity });
        }

        const chancePpm = calculateWinChancePpm(
          stakeValue,
          targetValue,
          config.houseEdgeBps,
          config.maxWinChancePpm,
        );
        if (chancePpm < 1)
          throw new AppError(400, 'CHANCE_TOO_LOW', 'Calculated win chance is below the minimum');
        const serverSeed = decryptSecret(
          fairness.server_seed_ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${fairness.id}`,
        );
        if (hashServerSeed(serverSeed) !== fairness.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }
        const fairRoll = createFairRoll(serverSeed, body.clientSeed, fairness.nonce);
        const outcome = fairRoll.rollPpm < chancePpm ? 'win' : 'lose';
        const roundId = randomUUID();
        /* In cash-only play the item is the prize's identity, not the prize. No lot is awarded,
         * so there is no award id to reserve and nothing to draw out of house stock. */
        const firstAwardId = outcome === 'win' && !config.cashOnlyPlay ? randomUUID() : null;
        let cashPayoutMinor: bigint | null = null;
        let payoutBalanceAfterMinor: string | null = null;
        if (outcome === 'win' && config.cashOnlyPlay) {
          /* Settled at the target's FULL value. targetValue is exactly the figure the win chance
           * was priced from a few lines above, so paying anything less here would quietly widen
           * the edge beyond the one the player was shown. */
          cashPayoutMinor = targetValue;
          payoutBalanceAfterMinor = await creditWallet(
            client,
            userId,
            cashPayoutMinor,
            'upgrade_win',
            roundId,
          );
        }

        /* The debit lands last, once every reason to reject the round is behind us. The wallet
         * row has been held FOR UPDATE since the stake was priced, so the balance checked above
         * is still the balance being spent here. */
        if (body.balanceStake) {
          const debited = await client.query<{ balance_minor: string }>(
            `UPDATE user_wallets
                SET balance_minor = balance_minor - $2, updated_at = now()
              WHERE user_id = $1
              RETURNING balance_minor`,
            [userId, stakeValue.toString()],
          );
          const balanceAfter = debited.rows[0]?.balance_minor;
          if (balanceAfter === undefined) throw new Error('Wallet debit returned no balance');
          balanceAfterMinor = balanceAfter;
        }

        await client.query(
          `INSERT INTO upgrader_rounds
             (id, user_id, idempotency_key, request_hash, target_catalog_item_id, target_inventory_lot_id, target_quantity,
              stake_value_minor, target_value_minor, house_edge_bps, chance_ppm, roll_ppm, outcome,
              server_seed_hash, server_seed_reveal, client_seed, nonce, rng_digest,
              stake_kind, stake_balance_minor, balance_after_minor,
              payout_minor, payout_balance_after_minor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [
            roundId,
            userId,
            idempotencyKey,
            requestHash,
            body.targetCatalogItemId,
            firstAwardId,
            body.targetQuantity,
            stakeValue.toString(),
            targetValue.toString(),
            config.houseEdgeBps,
            chancePpm,
            fairRoll.rollPpm,
            outcome,
            fairness.server_seed_hash,
            serverSeed,
            body.clientSeed,
            fairness.nonce,
            fairRoll.digest,
            body.balanceStake ? 'balance' : 'item',
            body.balanceStake ? stakeValue.toString() : '0',
            balanceAfterMinor,
            cashPayoutMinor?.toString() ?? null,
            payoutBalanceAfterMinor,
          ],
        );

        /* A cash round consumes no lot, so there is nothing to move into house custody and no
         * upgrader_stakes row to write. Its record of what was taken is the wallet transaction
         * below; the loop is for item rounds only. */
        for (const selected of itemStakes ?? []) {
          const source = stakeById.get(selected.inventoryLotId);
          if (!source) throw new Error('Locked stake disappeared');
          await client.query(
            `INSERT INTO upgrader_stakes
               (round_id, source_inventory_lot_id, catalog_item_id, quantity, unit_value_minor)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              roundId,
              source.id,
              source.catalog_item_id,
              selected.quantity,
              source.unit_value_minor,
            ],
          );
          if (selected.quantity === source.quantity) {
            await client.query(
              "UPDATE inventory_lots SET state = 'consumed', updated_at = now() WHERE id = $1",
              [source.id],
            );
          } else {
            await client.query(
              'UPDATE inventory_lots SET quantity = quantity - $2, updated_at = now() WHERE id = $1',
              [source.id, selected.quantity],
            );
          }
          await client.query(
            `INSERT INTO inventory_lots
               (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
             VALUES ($1, $2, NULL, $3, $4, 'available', 'upgrade_stake', $5)`,
            [randomUUID(), source.catalog_item_id, source.bot_id, selected.quantity, roundId],
          );
          await client.query(
            `INSERT INTO custody_movements
               (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
             VALUES ($1, $2, $3, $4, NULL, $5, 'upgrade_stake', $6)`,
            [
              randomUUID(),
              source.catalog_item_id,
              source.bot_id,
              userId,
              selected.quantity,
              roundId,
            ],
          );
        }

        if (outcome === 'win' && !config.cashOnlyPlay) {
          let remaining = body.targetQuantity;
          let first = true;
          for (const source of stock.rows) {
            if (remaining === 0) break;
            const quantity = Math.min(source.quantity, remaining);
            /* Unlimited stock mints the award instead of drawing it down, so the house lot — if
             * there even is one — is left exactly as it was. */
            if (!config.houseStockUnlimited) {
              if (quantity === source.quantity) {
                await client.query(
                  "UPDATE inventory_lots SET state = 'consumed', updated_at = now() WHERE id = $1",
                  [source.id],
                );
              } else {
                await client.query(
                  'UPDATE inventory_lots SET quantity = quantity - $2, updated_at = now() WHERE id = $1',
                  [source.id, quantity],
                );
              }
            }
            const awardId = first && firstAwardId ? firstAwardId : randomUUID();
            first = false;
            await client.query(
              `INSERT INTO inventory_lots
                 (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
               VALUES ($1, $2, $3, $4, $5, 'available', 'upgrade_win', $6)`,
              [awardId, body.targetCatalogItemId, userId, source.bot_id, quantity, roundId],
            );
            await client.query(
              `INSERT INTO upgrader_awards
                 (round_id, source_inventory_lot_id, awarded_inventory_lot_id, catalog_item_id, quantity, unit_value_minor)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                roundId,
                source.id || awardId,
                awardId,
                body.targetCatalogItemId,
                quantity,
                target.unit_value_minor,
              ],
            );
            await client.query(
              `INSERT INTO custody_movements
                 (id, catalog_item_id, bot_id, from_user_id, to_user_id, quantity, reason, reference_id)
               VALUES ($1, $2, $3, NULL, $4, $5, 'upgrade_win', $6)`,
              [randomUUID(), body.targetCatalogItemId, source.bot_id, userId, quantity, roundId],
            );
            remaining -= quantity;
          }
        }

        if (body.balanceStake) {
          await client.query(
            `INSERT INTO wallet_transactions
               (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
             VALUES ($1, $2, $3, $4, 'upgrade_stake', $5)`,
            [randomUUID(), userId, (-stakeValue).toString(), balanceAfterMinor, roundId],
          );
        }

        const wager = await recordWager(client, config, userId, stakeValue, 'upgrader', roundId, [
          'upgrader_rolls',
          'wagered_minor',
        ]);
        if (outcome === 'win') {
          await recordQuestProgress(client, userId, 'upgrader_wins', 1n);
        }

        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [
          fairness.id,
        ]);
        await insertFairnessSeed(client, config, userId);
        const saved = await client.query<UpgraderRoundRow>(
          'SELECT * FROM upgrader_rounds WHERE id = $1',
          [roundId],
        );
        return { round: saved.rows[0], wager, stakeValue };
      });
      const round = settled.round;

      /* AFTER the commit, never inside it. A webhook is a network call to a third party, and a
       * third party being slow is not a reason a player's payout is slow — nor is it a reason a
       * settled round rolls back. `announceWin` throws nothing and is deliberately not awaited. */
      const username = request.authUser?.minecraftUsername ?? 'Player';
      if (settled.wager && round?.['outcome'] === 'win') {
        /* The row is typed with an index signature of `unknown`, so the column is narrowed rather
         * than stringified: String() on an unexpected object would silently produce
         * "[object Object]" and BigInt would then throw inside a settled round's response. */
        const rawPayout = round['target_value_minor'];
        const payout =
          typeof rawPayout === 'string' || typeof rawPayout === 'number' ? BigInt(rawPayout) : 0n;
        const stake = settled.stakeValue;
        void announceWin(
          config,
          {
            username,
            amountMinor: payout,
            mode: 'Upgrader',
            ...(stake > 0n ? { multiplier: Number(payout) / Number(stake) } : {}),
            path: '/upgrader',
          },
          app.log,
        );
      }
      /* A jackpot draw that hit is announced on its own terms: it carries no multiplier, because it
       * is not a multiple of anything the player staked. */
      const jackpotWin = settled.wager?.jackpot.win ?? null;
      if (jackpotWin) {
        void announceWin(
          config,
          {
            username,
            amountMinor: jackpotWin.amountMinor,
            mode: 'Vault Jackpot',
            path: '/upgrader',
          },
          app.log,
        );
      }
      return reply.code(201).send({ round });
    },
  );

  app.get('/v1/upgrades/history', { preHandler: guards.authenticate }, async (request) => {
    const query = parseWith(historyQuery, request.query);
    const result = await db.query(
      `SELECT r.*, c.minecraft_name, c.display_name, c.image_url
         FROM upgrader_rounds r JOIN catalog_items c ON c.id = r.target_catalog_item_id
        WHERE r.user_id = $1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
        ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
      [request.authUser?.id, query.before ?? null, query.limit],
    );
    return { rounds: result.rows };
  });

  app.get('/v1/upgrades/recent-wins', async () => {
    const result = await db.query(
      `SELECT r.id, r.target_quantity, r.target_value_minor, r.chance_ppm, r.created_at,
              c.display_name, c.image_url,
              'Player-' || upper(substr(md5(r.id::text || ':' || u.id::text), 1, 8)) AS player
         FROM upgrader_rounds r
         JOIN catalog_items c ON c.id = r.target_catalog_item_id
         JOIN users u ON u.id = r.user_id
        WHERE r.outcome = 'win' ORDER BY r.created_at DESC LIMIT 30`,
    );
    return { wins: result.rows };
  });
}

export function checkedItemValue(total: bigint, unitValue: bigint, quantity: number): bigint {
  if (
    total < 0n ||
    total > POSTGRES_BIGINT_MAX ||
    unitValue <= 0n ||
    unitValue > POSTGRES_BIGINT_MAX ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  ) {
    throw new AppError(
      400,
      'VALUE_OUT_OF_RANGE',
      'The selected item value exceeds the supported database range',
    );
  }
  const value = unitValue * BigInt(quantity);
  if (value > POSTGRES_BIGINT_MAX - total) {
    throw new AppError(
      400,
      'VALUE_OUT_OF_RANGE',
      'The selected item value exceeds the supported database range',
    );
  }
  return total + value;
}

export function assertExpectedPrice(actual: string, expected: string, subject: string): void {
  if (actual !== expected) {
    conflict('PRICE_CHANGED', `The ${subject} item price changed; refresh the quote and try again`);
  }
}

async function ensureFairnessSeed(
  db: Database,
  config: AppConfig,
  userId: string,
): Promise<FairnessRow> {
  return db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 741))', [userId]);
    const current = await client.query<FairnessRow>(
      `SELECT id, server_seed_ciphertext, server_seed_hash, nonce
         FROM fairness_seeds WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`,
      [userId],
    );
    return current.rows[0] ?? insertFairnessSeed(client, config, userId);
  });
}

async function insertFairnessSeed(
  client: DbClient,
  config: AppConfig,
  userId: string,
): Promise<FairnessRow> {
  const id = randomUUID();
  const seed = generateServerSeed();
  const hash = hashServerSeed(seed);
  const ciphertext = encryptSecret(seed, config.dataEncryptionKey, `fairness:${userId}:${id}`);
  const inserted = await client.query<FairnessRow>(
    `INSERT INTO fairness_seeds(id, user_id, server_seed_ciphertext, server_seed_hash, nonce)
     VALUES ($1, $2, $3, $4, 0)
     RETURNING id, server_seed_ciphertext, server_seed_hash, nonce`,
    [id, userId, ciphertext, hash],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('Fairness seed insert returned no row');
  return row;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
