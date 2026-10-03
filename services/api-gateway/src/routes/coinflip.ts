import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { battleCodeFrom, deterministicUuid } from '../lib/battle-engine.js';
import { creditWallet, recordWager } from '../lib/cash-settlement.js';
import { flipCoin, otherSide, type CoinSide } from '../lib/coinflip.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { duelMarginPerPlayer, splitPot } from '../lib/duel-engine.js';
import { AppError } from '../lib/errors.js';
import { assertGameEligible } from '../lib/game-eligibility.js';
import { publishLiveSoon } from '../lib/live-events.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith } from '../lib/validation.js';

/**
 * Coinflip — two players, one coin, one pot.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MONEY, IN ORDER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. The host opens a game on a side. Their stake is DEBITED immediately and the game holds it,
 *      for the same reason a duel lobby does: a game that promises a stake it has not taken can
 *      be joined against an empty wallet.
 *   2. An opponent takes the other side. In ONE transaction their stake is debited, the coin is
 *      flipped, the winner is credited the pot less the rake, and the reveal is written. There is
 *      no state in between for a disconnect, a crash or a race to land in.
 *   3. A game nobody takes is refunded whole — by the host's cancel or by the sweeper after the
 *      TTL — and the house is paid nothing.
 *
 * Both stakes become wagers (quests, VIP, rakeback, referrals, the faction war) only when the coin
 * is flipped. Counting an open game would let a player farm wagered volume by opening and
 * cancelling games against nobody.
 */

/** An open game holds its host's money, so a host may only hold so many at once. */
const MAX_OPEN_GAMES_PER_USER = 3;

/** How many finished flips the strip under the board shows. */
const RECENT_FLIPS = 12;

const codeParams = z.object({ code: z.string().regex(/^[A-Z0-9]{6,12}$/) });
const clientSeedSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const createSchema = z.object({
  stakeMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  side: z.enum(['heads', 'tails']),
  clientSeed: clientSeedSchema.optional(),
});

const joinSchema = z.object({
  clientSeed: clientSeedSchema.optional(),
});

interface GameRow {
  id: string;
  code: string;
  host_user_id: string;
  host_side: CoinSide;
  opponent_user_id: string | null;
  stake_minor: string;
  rake_bps: number;
  status: 'open' | 'settled' | 'cancelled';
  server_seed_hash: string;
  server_seed_ciphertext: string;
  server_seed_reveal: string | null;
  host_client_seed: string;
  opponent_client_seed: string | null;
  result: CoinSide | null;
  winner_user_id: string | null;
  pot_minor: string | null;
  rake_minor: string | null;
  payout_minor: string | null;
  created_at: Date;
  settled_at: Date | null;
  expires_at: Date;
  host_name: string | null;
  opponent_name: string | null;
}

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* the board is readable logged out */
    }
  };
}

export async function registerCoinflipRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  function assertEnabled(): void {
    if (!config.coinflipEnabled) {
      throw new AppError(404, 'COINFLIP_DISABLED', 'Coinflip is not switched on');
    }
  }

  /* ─────────────────────────── shared readers ─────────────────────────── */

  /* Both players are named to anyone who opens the board, so both are masked in the query — the
   * same treatment as the duel and battle lobbies. See lib/masked-name.ts. */
  const SELECT_GAME = `
    SELECT g.*,
           ${maskedName('h.minecraft_username')} AS host_name,
           ${maskedName('o.minecraft_username')} AS opponent_name
      FROM coinflip_games g
      JOIN users h ON h.id = g.host_user_id
      LEFT JOIN users o ON o.id = g.opponent_user_id`;

  async function readGame(client: DbClient, code: string): Promise<GameRow | null> {
    const result = await client.query<GameRow>(`${SELECT_GAME} WHERE g.code = $1`, [code]);
    return result.rows[0] ?? null;
  }

  /**
   * The public shape of a game.
   *
   * The server seed appears only once the coin has landed; until then only its hash does, which
   * is the commitment. The pot split is quoted on an open game so a player sees the fee before
   * they stake, not after they win.
   */
  function publicGame(row: GameRow, viewerId: string | null) {
    const money = splitPot(BigInt(row.stake_minor), row.rake_bps);
    const isViewer = (userId: string | null) => viewerId !== null && userId === viewerId;
    return {
      code: row.code,
      status: row.status,
      stakeMinor: row.stake_minor,
      rakeBps: row.rake_bps,
      potMinor: money.potMinor.toString(),
      rakeMinor: money.rakeMinor.toString(),
      payoutMinor: money.payoutMinor.toString(),
      host: { name: row.host_name, side: row.host_side, isYou: isViewer(row.host_user_id) },
      opponent: row.opponent_user_id
        ? {
            name: row.opponent_name,
            side: otherSide(row.host_side),
            isYou: isViewer(row.opponent_user_id),
          }
        : null,
      result: row.result,
      winner: row.winner_user_id
        ? row.winner_user_id === row.host_user_id
          ? 'host'
          : 'opponent'
        : null,
      youWon: row.winner_user_id !== null && isViewer(row.winner_user_id),
      serverSeedHash: row.server_seed_hash,
      serverSeed: row.server_seed_reveal,
      hostClientSeed: row.host_client_seed,
      opponentClientSeed: row.opponent_client_seed,
      createdAt: row.created_at.toISOString(),
      settledAt: row.settled_at?.toISOString() ?? null,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /**
   * Debits a stake and writes the ledger row, as one guarded statement — two concurrent requests
   * cannot both read a sufficient balance and both succeed. Same shape as a duel's stake.
   */
  async function debitStake(
    client: DbClient,
    userId: string,
    stake: bigint,
    gameId: string,
    role: 'host' | 'opponent',
  ): Promise<void> {
    const debited = await client.query<{ balance_minor: string }>(
      `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
        WHERE user_id = $1 AND balance_minor >= $2
        RETURNING balance_minor`,
      [userId, stake.toString()],
    );
    const balanceAfter = debited.rows[0]?.balance_minor;
    if (balanceAfter === undefined) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Not enough balance for that stake');
    }
    await client.query(
      `INSERT INTO wallet_transactions
         (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
       VALUES ($1, $2, $3, $4, 'coinflip_stake', $5)`,
      [
        randomUUID(),
        userId,
        (-stake).toString(),
        balanceAfter,
        deterministicUuid('coinflip_stake', gameId, role),
      ],
    );
  }

  /** Closes an open game and hands the host their stake back. False if it was no longer open. */
  async function refundOpenGame(client: DbClient, row: GameRow): Promise<boolean> {
    const closed = await client.query(
      `UPDATE coinflip_games SET status = 'cancelled' WHERE id = $1 AND status = 'open'`,
      [row.id],
    );
    if (closed.rowCount === 0) return false;
    await creditWallet(
      client,
      row.host_user_id,
      BigInt(row.stake_minor),
      'coinflip_refund',
      deterministicUuid('coinflip_refund', row.id, 'host'),
    );
    return true;
  }

  /* ─────────────────────────── reads ─────────────────────────── */

  app.get('/v1/coinflip', { preHandler: softAuth }, async (request) => {
    assertEnabled();
    const viewerId = request.authUser?.id ?? null;
    const open = await db.query<GameRow>(
      `${SELECT_GAME}
        WHERE g.status = 'open' AND g.expires_at > now()
        ORDER BY g.stake_minor DESC, g.created_at DESC
        LIMIT 100`,
    );
    const recent = await db.query<GameRow>(
      `${SELECT_GAME}
        WHERE g.status = 'settled'
        ORDER BY g.settled_at DESC
        LIMIT ${RECENT_FLIPS}`,
    );
    return {
      rakeBps: config.coinflipRakeBps,
      minStakeMinor: config.coinflipMinStakeMinor.toString(),
      maxStakeMinor: config.coinflipMaxStakeMinor.toString(),
      games: open.rows.map((row) => publicGame(row, viewerId)),
      recent: recent.rows.map((row) => publicGame(row, viewerId)),
    };
  });

  app.get('/v1/coinflip/:code', { preHandler: softAuth }, async (request) => {
    assertEnabled();
    const { code } = parseWith(codeParams, request.params);
    const row = await readGame(db, code);
    if (!row) throw new AppError(404, 'COINFLIP_NOT_FOUND', 'No such game');
    return publicGame(row, request.authUser?.id ?? null);
  });

  /* ─────────────────────────── open a game ─────────────────────────── */

  app.post(
    '/v1/coinflip',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      assertEnabled();
      const body = parseWith(createSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to open a coinflip');

      const stake = BigInt(body.stakeMinor);
      if (stake < config.coinflipMinStakeMinor || stake > config.coinflipMaxStakeMinor) {
        throw new AppError(400, 'STAKE_OUT_OF_RANGE', 'That stake is outside the allowed range');
      }

      const created = await db.transaction(async (client) => {
        await assertGameEligible(client, userId);

        const open = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM coinflip_games
            WHERE host_user_id = $1 AND status = 'open'`,
          [userId],
        );
        if (Number(open.rows[0]?.count ?? 0) >= MAX_OPEN_GAMES_PER_USER) {
          throw new AppError(
            429,
            'TOO_MANY_GAMES',
            `You already have ${MAX_OPEN_GAMES_PER_USER} open coinflips`,
          );
        }

        const gameId = randomUUID();
        const code = battleCodeFrom(randomBytes(8));
        const serverSeed = generateServerSeed();
        await client.query(
          `INSERT INTO coinflip_games
             (id, code, host_user_id, host_side, stake_minor, rake_bps, status,
              server_seed_hash, server_seed_ciphertext, host_client_seed, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9,
                   now() + ($10 || ' minutes')::interval)`,
          [
            gameId,
            code,
            userId,
            body.side,
            stake.toString(),
            /* Snapshot, not a lookup at settlement: a fee change must not reprice a game that is
             * already on the board. */
            config.coinflipRakeBps,
            hashServerSeed(serverSeed),
            encryptSecret(serverSeed, config.dataEncryptionKey, `coinflip:${gameId}`),
            body.clientSeed ?? randomBytes(16).toString('hex'),
            String(config.coinflipLobbyTtlMinutes),
          ],
        );
        await debitStake(client, userId, stake, gameId, 'host');
        return readGame(client, code);
      });

      if (!created)
        throw new AppError(500, 'COINFLIP_CREATE_FAILED', 'The game could not be opened');
      publishLiveSoon('coinflip');
      return reply.code(201).send(publicGame(created, userId));
    },
  );

  /* ─────────────────────────── take a game ─────────────────────────── */

  app.post(
    '/v1/coinflip/:code/join',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const { code } = parseWith(codeParams, request.params);
      const body = parseWith(joinSchema, request.body ?? {});
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to join a coinflip');

      const settled = await db.transaction(async (client) => {
        await assertGameEligible(client, userId);

        /* FOR UPDATE: two players taking the same game at the same instant must not both become
         * the opponent. The lock serializes them; the status check rejects the second cleanly. */
        const locked = await client.query<GameRow>(
          `${SELECT_GAME} WHERE g.code = $1 FOR UPDATE OF g`,
          [code],
        );
        const row = locked.rows[0];
        if (!row) throw new AppError(404, 'COINFLIP_NOT_FOUND', 'No such game');
        if (row.status !== 'open') {
          throw new AppError(409, 'COINFLIP_NOT_OPEN', 'That game has already been taken');
        }
        if (row.expires_at.getTime() <= Date.now()) {
          throw new AppError(409, 'COINFLIP_EXPIRED', 'That game has expired');
        }
        if (row.host_user_id === userId) {
          throw new AppError(409, 'CANNOT_FLIP_SELF', 'You cannot take your own game');
        }

        const stake = BigInt(row.stake_minor);
        await debitStake(client, userId, stake, row.id, 'opponent');

        const serverSeed = decryptSecret(
          row.server_seed_ciphertext,
          config.dataEncryptionKey,
          `coinflip:${row.id}`,
        );
        const opponentClientSeed = body.clientSeed ?? randomBytes(16).toString('hex');
        const flip = flipCoin(serverSeed, row.host_client_seed, opponentClientSeed);
        const winnerUserId = flip.side === row.host_side ? row.host_user_id : userId;
        const money = splitPot(stake, row.rake_bps);

        const claimed = await client.query(
          `UPDATE coinflip_games
              SET opponent_user_id = $2, opponent_client_seed = $3, status = 'settled',
                  result = $4, winner_user_id = $5, pot_minor = $6, rake_minor = $7,
                  payout_minor = $8, server_seed_reveal = $9, settled_at = now()
            WHERE id = $1 AND status = 'open'`,
          [
            row.id,
            userId,
            opponentClientSeed,
            flip.side,
            winnerUserId,
            money.potMinor.toString(),
            money.rakeMinor.toString(),
            money.payoutMinor.toString(),
            serverSeed,
          ],
        );
        if (claimed.rowCount === 0) {
          throw new AppError(409, 'COINFLIP_NOT_OPEN', 'That game has already been taken');
        }

        await creditWallet(
          client,
          winnerUserId,
          money.payoutMinor,
          'coinflip_win',
          deterministicUuid('coinflip_win', row.id, winnerUserId),
        );

        /* NOW both stakes are wagers. Each player's margin is half the rake, because they put in
         * half the pot each — the same derivation a duel uses, for the same reason: this mode
         * charges no house edge, so the edge-derived margin would be money never collected. */
        const margin = duelMarginPerPlayer(money);
        for (const player of [row.host_user_id, userId]) {
          await recordWager(
            client,
            config,
            player,
            stake,
            'coinflip',
            deterministicUuid('coinflip_wager', row.id, player),
            ['wagered_minor'],
            margin,
          );
        }
        return readGame(client, code);
      });

      if (!settled) throw new AppError(500, 'COINFLIP_JOIN_FAILED', 'The game could not be joined');
      /* Balance and activity are already announced for both players by recordWager. */
      publishLiveSoon('coinflip');
      return publicGame(settled, userId);
    },
  );

  /* ─────────────────────────── cancel ─────────────────────────── */

  app.post(
    '/v1/coinflip/:code/cancel',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      assertEnabled();
      const { code } = parseWith(codeParams, request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const row = await db.transaction(async (client) => {
        const locked = await client.query<GameRow>(
          `${SELECT_GAME} WHERE g.code = $1 FOR UPDATE OF g`,
          [code],
        );
        const game = locked.rows[0];
        if (!game) throw new AppError(404, 'COINFLIP_NOT_FOUND', 'No such game');
        if (game.host_user_id !== userId) {
          throw new AppError(403, 'NOT_THE_HOST', 'Only the host can cancel');
        }
        if (!(await refundOpenGame(client, game))) {
          throw new AppError(409, 'COINFLIP_NOT_OPEN', 'That game has already been taken');
        }
        return game;
      });

      publishLiveSoon('coinflip');
      return { ok: true, refundedMinor: row.stake_minor };
    },
  );

  /* ─────────────────────────── lapsed games ─────────────────────────── */

  /**
   * Refunds open games nobody took before their TTL. Each one is re-read under lock and closed by
   * the same guarded UPDATE the host's cancel uses, with the same deterministic ledger reference,
   * so a cancel and a sweep racing each other cannot both pay.
   */
  async function sweepLapsed(): Promise<void> {
    if (!config.coinflipEnabled) return;
    const lapsed = await db.query<{ code: string }>(
      `SELECT code FROM coinflip_games WHERE status = 'open' AND expires_at <= now() LIMIT 50`,
    );
    let refunded = 0;
    for (const { code } of lapsed.rows) {
      const done = await db.transaction(async (client) => {
        const locked = await client.query<GameRow>(
          `${SELECT_GAME} WHERE g.code = $1 FOR UPDATE OF g`,
          [code],
        );
        const row = locked.rows[0];
        return row ? refundOpenGame(client, row) : false;
      });
      if (done) refunded += 1;
    }
    if (refunded > 0) publishLiveSoon('coinflip');
  }

  const sweeper = setInterval(() => {
    sweepLapsed().catch((error: unknown) => app.log.error({ error }, 'coinflip sweep failed'));
  }, 30_000);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));
}
