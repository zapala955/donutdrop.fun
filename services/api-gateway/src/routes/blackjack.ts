import { randomUUID } from 'node:crypto';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import {
  BLACKJACK_HOUSE_EDGE_BPS,
  BLACKJACK_RULES,
  DEAL_ORDER,
  compareHands,
  dealerShouldHit,
  drawCard,
  handTotal,
  isBlackjack,
  payoutFor,
  type BlackjackOutcome,
} from '../lib/blackjack.js';
import { creditWallet, recordWager, type WagerOutcome } from '../lib/cash-settlement.js';
import { canonicalJson, decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { announceWin } from '../lib/discord-flex.js';
import { AppError, conflict } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { publishLiveSoon } from '../lib/live-events.js';
import { parseWith, requireIdempotencyKey } from '../lib/validation.js';

/**
 * Blackjack, one hand across several requests: deal, then hit / stand / double until it settles.
 *
 * The hand is played against the player's committed fairness seed, exactly as the upgrader
 * rolls against it: the seed is taken (and a fresh one committed for next time) when the cards
 * are dealt, which fixes every card in the hand before the first decision. It is revealed into
 * the hand when it settles and not a moment earlier -- the reveal is the whole remaining deck.
 *
 * Money moves at three points and nowhere else: the stake at the deal, the second stake on a
 * double, and the payout at settlement. The wager is recorded once, at settlement, for everything
 * that was on the table -- which is what feeds VIP, rakeback, referrals and the wager requirement.
 */

const clientSeedSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 128, 'Must not exceed 128 UTF-8 bytes')
  .refine(
    (value) => ![...value].some((c) => (c.codePointAt(0) ?? 0) <= 31 || c.codePointAt(0) === 127),
    'Must not contain control characters',
  );

const dealSchema = z
  .object({
    stakeMinor: z.string().regex(/^[1-9]\d{0,18}$/),
    clientSeed: clientSeedSchema,
    serverSeedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const actionSchema = z
  .object({
    action: z.enum(['hit', 'stand', 'double']),
    /* How many cards the player was looking at when they chose. A second click on Hit arrives with
     * the old count and is refused, instead of drawing a card nobody asked for. */
    cardsInHand: z.number().int().min(2).max(21),
  })
  .strict();

const idSchema = z.object({ id: z.uuid() }).strict();
const historySchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

interface HandRow {
  id: string;
  user_id: string;
  request_hash: string;
  stake_minor: string;
  doubled: boolean;
  status: 'active' | 'settled';
  player_cards: number[];
  dealer_cards: number[];
  next_card: number;
  outcome: BlackjackOutcome | null;
  payout_minor: string | null;
  fairness_seed_id: string;
  server_seed_hash: string;
  server_seed_reveal: string | null;
  client_seed: string;
  nonce: number;
  created_at: Date;
  settled_at: Date | null;
}

interface FairnessRow {
  id: string;
  server_seed_ciphertext: string;
  server_seed_hash: string;
  nonce: number;
}

/**
 * What the player may see. While the hand is in play the dealer's hole card is `null` -- it is in
 * the database, and it never leaves it until the hand is over.
 */
function handView(row: HandRow) {
  const settled = row.status === 'settled';
  const dealerShown = settled ? row.dealer_cards : row.dealer_cards.slice(0, 1);
  return {
    id: row.id,
    status: row.status,
    stakeMinor: row.stake_minor,
    doubled: row.doubled,
    player: { cards: row.player_cards, ...handTotal(row.player_cards) },
    dealer: {
      cards: settled ? row.dealer_cards : [row.dealer_cards[0], null],
      ...handTotal(dealerShown),
    },
    canDouble: !settled && !row.doubled && row.player_cards.length === 2,
    outcome: row.outcome,
    payoutMinor: row.payout_minor,
    fairness: {
      serverSeedHash: row.server_seed_hash,
      clientSeed: row.client_seed,
      nonce: row.nonce,
      serverSeed: settled ? row.server_seed_reveal : null,
    },
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export async function registerBlackjackRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/blackjack/config', async () => ({
    enabled: config.blackjackEnabled,
    minStakeMinor: config.blackjackMinStakeMinor.toString(),
    maxStakeMinor: config.blackjackMaxStakeMinor.toString(),
    houseEdgeBps: BLACKJACK_HOUSE_EDGE_BPS,
    rules: BLACKJACK_RULES,
    algorithm: 'HMAC-SHA256-v1:card',
  }));

  app.get(
    '/v1/blackjack/hands/active',
    { preHandler: guards.authenticate },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const result = await db.query<HandRow>(
        "SELECT * FROM blackjack_hands WHERE user_id = $1 AND status = 'active'",
        [userId],
      );
      const row = result.rows[0];
      return { hand: row ? handView(row) : null };
    },
  );

  app.get('/v1/blackjack/hands', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const query = parseWith(historySchema, request.query ?? {});
    const result = await db.query<HandRow>(
      `SELECT * FROM blackjack_hands WHERE user_id = $1 AND status = 'settled'
        ORDER BY created_at DESC LIMIT $2`,
      [userId, query.limit],
    );
    return { hands: result.rows.map(handView) };
  });

  app.post(
    '/v1/blackjack/hands',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);
      const body = parseWith(dealSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
      const requestHash = sha256Hex(canonicalJson(body));
      const stake = BigInt(body.stakeMinor);

      const result = await db.transaction(async (client) => {
        const existing = await client.query<HandRow>(
          'SELECT * FROM blackjack_hands WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash) {
            conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
          }
          return { row: existing.rows[0], settledNow: null };
        }

        /* Closing the table stops new hands. It never strands one in play: every action below
         * works whatever this says, because the stake is already on the table. */
        if (!config.blackjackEnabled) {
          throw new AppError(503, 'BLACKJACK_CLOSED', 'The blackjack table is closed right now');
        }
        if (stake < config.blackjackMinStakeMinor || stake > config.blackjackMaxStakeMinor) {
          throw new AppError(
            400,
            'STAKE_OUT_OF_RANGE',
            `A hand stakes between ${config.blackjackMinStakeMinor.toString()} and ${config.blackjackMaxStakeMinor.toString()}`,
          );
        }

        await assertGameEligible(client, userId);
        const active = await client.query(
          "SELECT 1 FROM blackjack_hands WHERE user_id = $1 AND status = 'active'",
          [userId],
        );
        if (active.rowCount) conflict('HAND_IN_PLAY', 'Finish the hand you are playing first');

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
            'Fetch the current server-seed commitment before dealing',
          );
        }
        if (fairness.server_seed_hash !== body.serverSeedHash) {
          conflict('FAIRNESS_COMMITMENT_CHANGED', 'The supplied server-seed commitment is no longer active');
        }
        const serverSeed = decryptSecret(
          fairness.server_seed_ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${fairness.id}`,
        );
        if (hashServerSeed(serverSeed) !== fairness.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }

        const handId = randomUUID();
        await debit(client, userId, stake, 'blackjack_stake', handId);

        const draw = (position: number) =>
          drawCard(serverSeed, body.clientSeed, fairness.nonce, position);
        const player = DEAL_ORDER.player.map(draw);
        const dealer = DEAL_ORDER.dealer.map(draw);

        /* The seed is spent now, not at settlement: it has fixed this hand's cards, and the next
         * game the player starts must not be able to draw from the same sequence. It is revealed
         * only when the hand settles. */
        await client.query('UPDATE fairness_seeds SET used_at = now() WHERE id = $1', [fairness.id]);
        await insertFairnessSeed(client, config, userId);

        const inserted = await client.query<HandRow>(
          `INSERT INTO blackjack_hands
             (id, user_id, idempotency_key, request_hash, stake_minor, player_cards, dealer_cards,
              next_card, fairness_seed_id, server_seed_hash, client_seed, nonce)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING *`,
          [
            handId,
            userId,
            idempotencyKey,
            requestHash,
            stake.toString(),
            player,
            dealer,
            DEAL_ORDER.next,
            fairness.id,
            fairness.server_seed_hash,
            body.clientSeed,
            fairness.nonce,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('Blackjack hand insert returned no row');

        /* Naturals settle on the deal. The dealer can only hold one with an ace or a ten showing,
         * which is when a real dealer peeks, so checking the hand as a whole is the same rule. */
        const playerNatural = isBlackjack(player);
        const dealerNatural = isBlackjack(dealer);
        if (dealerNatural || playerNatural) {
          const outcome: BlackjackOutcome = dealerNatural
            ? playerNatural
              ? 'push'
              : 'dealer_blackjack'
            : 'blackjack';
          const settledNow = await settle(client, config, row, outcome, serverSeed);
          return { row: settledNow.row, settledNow };
        }
        publishLiveSoon('balance', [userId]);
        return { row, settledNow: null };
      });

      announce(config, request.authUser?.minecraftUsername, result.settledNow, app.log);
      const balance = await balanceOf(db, userId);
      return reply.code(201).send({ hand: handView(result.row), balanceMinor: balance });
    },
  );

  app.post(
    '/v1/blackjack/hands/:id/actions',
    {
      preHandler: guards.requireCsrf,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const params = parseWith(idSchema, request.params);
      const body = parseWith(actionSchema, request.body);

      const result = await db.transaction(async (client) => {
        const locked = await client.query<HandRow>(
          'SELECT * FROM blackjack_hands WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [params.id, userId],
        );
        const row = locked.rows[0];
        if (!row) throw new AppError(404, 'HAND_NOT_FOUND', 'No such hand');
        if (row.status !== 'active') conflict('HAND_SETTLED', 'That hand is already over');
        if (row.player_cards.length !== body.cardsInHand) {
          conflict('STALE_ACTION', 'The hand moved on before that arrived');
        }

        const seed = await client.query<{ server_seed_ciphertext: string }>(
          'SELECT server_seed_ciphertext FROM fairness_seeds WHERE id = $1',
          [row.fairness_seed_id],
        );
        const ciphertext = seed.rows[0]?.server_seed_ciphertext;
        if (!ciphertext) throw new Error('Blackjack hand lost its fairness seed');
        const serverSeed = decryptSecret(
          ciphertext,
          config.dataEncryptionKey,
          `fairness:${userId}:${row.fairness_seed_id}`,
        );
        if (hashServerSeed(serverSeed) !== row.server_seed_hash) {
          throw new Error('Stored fairness seed does not match its commitment');
        }

        let next = row.next_card;
        const draw = () => drawCard(serverSeed, row.client_seed, row.nonce, next++);
        const player = [...row.player_cards];
        const dealer = [...row.dealer_cards];
        let doubled = row.doubled;

        if (body.action === 'double') {
          if (doubled || player.length !== 2) {
            conflict('DOUBLE_NOT_ALLOWED', 'You can only double on your first two cards');
          }
          await debit(client, userId, BigInt(row.stake_minor), 'blackjack_double', row.id);
          doubled = true;
        }
        if (body.action === 'hit' || body.action === 'double') player.push(draw());

        const playerTotal = handTotal(player).total;
        /* Over 21 loses at once and the dealer never plays. Standing, doubling and reaching 21
         * all hand the table to the dealer; hitting below 21 waits for the next decision. */
        let outcome: BlackjackOutcome | null = null;
        if (playerTotal > 21) {
          outcome = 'bust';
        } else if (body.action !== 'hit' || playerTotal === 21) {
          while (dealerShouldHit(dealer)) dealer.push(draw());
          outcome = compareHands(player, dealer);
        }

        const updated = await client.query<HandRow>(
          `UPDATE blackjack_hands
              SET player_cards = $2, dealer_cards = $3, next_card = $4, doubled = $5
            WHERE id = $1
            RETURNING *`,
          [row.id, player, dealer, next, doubled],
        );
        const current = updated.rows[0];
        if (!current) throw new Error('Blackjack hand update returned no row');
        if (!outcome) {
          if (doubled !== row.doubled) publishLiveSoon('balance', [userId]);
          return { row: current, settledNow: null };
        }
        const settledNow = await settle(client, config, current, outcome, serverSeed);
        return { row: settledNow.row, settledNow };
      });

      announce(config, request.authUser?.minecraftUsername, result.settledNow, app.log);
      const balance = await balanceOf(db, userId);
      return { hand: handView(result.row), balanceMinor: balance };
    },
  );
}

interface Settlement {
  row: HandRow;
  payout: bigint;
  wager: WagerOutcome;
}

/** Pays out, reveals the seed, and records the wager -- everything a finished hand owes. */
async function settle(
  client: DbClient,
  config: AppConfig,
  row: HandRow,
  outcome: BlackjackOutcome,
  serverSeed: string,
): Promise<Settlement> {
  const stake = BigInt(row.stake_minor);
  const payout = payoutFor(outcome, stake, row.doubled);
  if (payout > 0n) await creditWallet(client, row.user_id, payout, 'blackjack_payout', row.id);
  const settled = await client.query<HandRow>(
    `UPDATE blackjack_hands
        SET status = 'settled', outcome = $2, payout_minor = $3, server_seed_reveal = $4,
            settled_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING *`,
    [row.id, outcome, payout.toString(), serverSeed],
  );
  const saved = settled.rows[0];
  if (!saved) throw new Error('Blackjack hand was settled twice');
  const onTable = row.doubled ? stake * 2n : stake;
  const wager = await recordWager(client, config, row.user_id, onTable, 'blackjack', row.id, [
    'wagered_minor',
  ]);
  return { row: saved, payout, wager };
}

/** Takes a stake off the wallet, refusing an overdraft, and writes the ledger line for it. */
async function debit(
  client: DbClient,
  userId: string,
  amount: bigint,
  kind: 'blackjack_stake' | 'blackjack_double',
  handId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const debited = await client.query<{ balance_minor: string }>(
    `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
      WHERE user_id = $1 AND balance_minor >= $2
      RETURNING balance_minor`,
    [userId, amount.toString()],
  );
  const balanceAfter = debited.rows[0]?.balance_minor;
  if (balanceAfter === undefined) {
    throw new AppError(409, 'INSUFFICIENT_BALANCE', 'Balance is too low for that stake');
  }
  await client.query(
    `INSERT INTO wallet_transactions (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, (-amount).toString(), balanceAfter, kind, handId],
  );
}

async function insertFairnessSeed(client: DbClient, config: AppConfig, userId: string) {
  const id = randomUUID();
  const seed = generateServerSeed();
  await client.query(
    `INSERT INTO fairness_seeds(id, user_id, server_seed_ciphertext, server_seed_hash, nonce)
     VALUES ($1, $2, $3, $4, 0)`,
    [
      id,
      userId,
      encryptSecret(seed, config.dataEncryptionKey, `fairness:${userId}:${id}`),
      hashServerSeed(seed),
    ],
  );
}

async function balanceOf(db: Database, userId: string): Promise<string> {
  const result = await db.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM user_wallets WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.balance_minor ?? '0';
}

/* After the commit, never inside it, and never awaited: a slow webhook is not a slow payout. */
function announce(
  config: AppConfig,
  username: string | undefined,
  settled: Settlement | null,
  logger: { error: (context: unknown, message: string) => void },
): void {
  if (!settled) return;
  // A settled hand is a new row in the live feed.
  publishLiveSoon('activity');
  if (!username) return;
  const { row, payout } = settled;
  if (row.outcome === 'win' || row.outcome === 'blackjack') {
    const stake = BigInt(row.stake_minor) * (row.doubled ? 2n : 1n);
    void announceWin(
      config,
      {
        username,
        amountMinor: payout,
        mode: 'Blackjack',
        ...(stake > 0n ? { multiplier: Number(payout) / Number(stake) } : {}),
        path: '/blackjack',
      },
      logger,
    );
  }
  // The jackpot draws on every wager, a lost hand included.
  const jackpotWin = settled.wager.jackpot.win;
  if (jackpotWin) {
    void announceWin(
      config,
      { username, amountMinor: jackpotWin.amountMinor, mode: 'Vault Jackpot', path: '/blackjack' },
      logger,
    );
  }
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
