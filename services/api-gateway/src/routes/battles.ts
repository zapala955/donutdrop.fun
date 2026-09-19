import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { generateServerSeed, hashServerSeed } from '@donut/provably-fair';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import {
  BATTLE_MODES,
  LOBBY_TTL_MS,
  MAX_ROUNDS,
  MIN_ROUNDS,
  START_LEAD_MS,
  battleCodeFrom,
  combineSeeds,
  deterministicUuid,
  digestToRollWeight,
  resolveBattle,
  reelDigest,
  roundSchedule,
  shapeFor,
  teamForSeat,
  type BattleMode,
  type SeatTotal,
} from '../lib/battle-engine.js';
import { BattleHub } from '../lib/battle-hub.js';

import { creditWallet, recordWager } from '../lib/cash-settlement.js';
import { payCreatorRoyalty } from '../lib/creator-royalties.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { safeText } from '../lib/sanitize.js';
import { maskedName } from '../lib/masked-name.js';
import { parseWith } from '../lib/validation.js';
import { LOBBY_SOCKET_BUDGET, createSocketBudget } from '../lib/socket-limit.js';

/**
 * Case Battles.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MONEY, IN ORDER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. a seat is bought when a player joins. The stake is the sum of the crate prices, debited
 *      under a SERIALIZABLE transaction with the wallet row locked, exactly like a solo open.
 *   2. nothing is credited per reel. Every drop goes into the pot instead of into the player who
 *      spun it, which is what makes a battle a contest rather than several simultaneous opens.
 *   3. the pot — the sum of every drop across every reel — goes to the winning team when the last
 *      seat fills and the battle settles.
 *
 * The house edge is the crates' own 10% and nothing else. A battle takes no rake: the pot is
 * already 90% of what was staked, in expectation, because that is what the crates return. Adding
 * a cut on top would charge the edge twice and make the published crate odds a lie.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE WHOLE BATTLE IS ROLLED AT ONCE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Every round of every seat is decided in ONE transaction the moment the lobby fills, before a
 * single pixel moves. The clients are then told the outcomes and a start time, and they animate
 * toward a result that is already final and already banked.
 *
 * It looks backwards and it is the only honest way to do it. If rounds settled as they animated,
 * a disconnect mid-battle would leave a half-paid match, and the server would have to decide
 * whether to finish it for an absent player or refund a partially spun pot. Settling first means
 * a disconnect costs you the animation and nothing else: your money moved when you joined, and
 * your result was determined before your screen ever lit up.
 */

const MAX_OPEN_LOBBIES_PER_USER = 3;
const BOT_NAMES = [
  'CrateGoblin', 'AnvilAndy', 'NetherNoodle', 'ObsidianOtto', 'PearlPilot',
  'BastionBeck', 'SculkSam', 'BlazeBetty',
] as const;

const createSchema = z
  .object({
    format: z.enum(['1v1', '1v1v1', '1v1v1v1', '2v2']),
    mode: z.enum(['standard', 'crazy']),
    visibility: z.enum(['public', 'private']),
    allowBots: z.boolean().default(false),
    /* The crate list, in the order it will be opened. Ids only: the price comes from the
     * database, never from the client, so a forged body cannot buy a 150M crate for 5,000. */
    caseIds: z.array(z.uuid()).min(MIN_ROUNDS).max(MAX_ROUNDS),
    clientSeed: safeText(1, 128),
  })
  .strict();

const joinSchema = z.object({ clientSeed: safeText(1, 128) }).strict();
const codeSchema = z.object({ code: z.string().regex(/^[A-Z0-9]{6,12}$/) }).strict();
const fastSchema = z.object({ fast: z.boolean() }).strict();
const listQuery = z
  .object({
    status: z.enum(['lobby', 'running', 'settled']).default('lobby'),
    limit: z.coerce.number().int().min(1).max(50).default(24),
  })
  .strict();

interface CaseRow {
  id: string;
  name: string;
  slug: string;
  price_minor: string;
  image_url: string | null;
  metadata: Record<string, unknown> | null;
  creator_user_id: string | null;
  royalty_bps: number;
  community_status: string;
}

interface DropRow {
  catalog_item_id: string;
  weight: number;
  unit_value_minor: string;
}


/**
 * Authenticates if a session is present, and does nothing if it is not.
 *
 * These reads are public — a lobby list and a crate page are both visible logged out — but they
 * are BETTER when the viewer is known: seats can be marked as yours, and a creator can see their
 * own unpublished draft. Without a preHandler, `request.authUser` is simply never populated, so
 * every one of those reads behaved as anonymous even for a signed-in player.
 *
 * It swallows the auth failure rather than reporting it, because not being logged in is the
 * expected case here, not an error.
 */
function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* anonymous is a valid way to read these */
    }
  };
}

export async function registerBattleRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);
  const hub = new BattleHub();
  app.addHook('onClose', async () => hub.close());

  /* ─────────────────────────── shared readers ─────────────────────────── */

  /** The full public shape of a battle: lobby row, seats, crate list, and results if settled. */
  async function readBattle(code: string, viewerId: string | null) {
    const battleResult = await db.query<{
      id: string; code: string; host_user_id: string; team_count: number; team_size: number;
      seat_count: number; mode: string; visibility: string; allow_bots: boolean;
      entry_cost_minor: string; status: string; server_seed_hash: string;
      server_seed_reveal: string | null; combined_seed_hash: string | null; nonce: number;
      pot_minor: string | null; winning_team: number | null; created_at: Date;
      started_at: Date | null; settled_at: Date | null; expires_at: Date; host_name: string;
    }>(
      /* The host is named to everyone browsing the lobby list, so the name is masked in the
       * query and the real one never leaves. See lib/masked-name.ts. */
      `SELECT b.*, ${maskedName('u.minecraft_username')} AS host_name
         FROM battles b JOIN users u ON u.id = b.host_user_id
        WHERE b.code = $1`,
      [code],
    );
    const battle = battleResult.rows[0];
    if (!battle) throw new AppError(404, 'BATTLE_NOT_FOUND', 'No battle with that code');

    const [seats, rounds, results] = await Promise.all([
      db.query<{
        seat: number; team: number; user_id: string | null; is_bot: boolean;
        display_name: string; staked_minor: string; total_drop_minor: string | null;
        payout_minor: string | null; client_seed: string;
      }>(
        /* Masked here too, which also covers the fairness panel: it lists a client seed per
         * seat and labelled each one with the player's real name, so verifying a battle meant
         * reading the names of everyone in it. `display_name` stays raw in the table — an audit
         * of who actually played needs it — and is masked on the way out. */
        `SELECT seat, team, user_id, is_bot,
                ${maskedName('display_name')} AS display_name,
                staked_minor, total_drop_minor, payout_minor, client_seed
           FROM battle_players WHERE battle_id = $1 ORDER BY seat`,
        [battle.id],
      ),
      db.query<{ round_index: number; case_id: string; price_minor: string; name: string; slug: string; image_url: string | null; metadata: Record<string, unknown> | null }>(
        `SELECT r.round_index, r.case_id, r.price_minor, c.name, c.slug, c.image_url, c.metadata
           FROM battle_rounds r JOIN cases c ON c.id = r.case_id
          WHERE r.battle_id = $1 ORDER BY r.round_index`,
        [battle.id],
      ),
      db.query<{
        round_index: number; seat: number; payout_minor: string; roll_digest: string;
        roll_weight: string; total_weight: string; minecraft_name: string;
        display_name: string; image_url: string | null; unit_value_minor: string;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT br.round_index, br.seat, br.payout_minor, br.roll_digest, br.roll_weight,
                br.total_weight, ci.minecraft_name, ci.display_name, ci.image_url,
                ci.unit_value_minor, ci.metadata
           FROM battle_results br JOIN catalog_items ci ON ci.id = br.catalog_item_id
          WHERE br.battle_id = $1 ORDER BY br.round_index, br.seat`,
        [battle.id],
      ),
    ]);

    /* A client seed is another player's chosen string. It is published only once the battle has
     * settled, alongside the revealed server seed — that is the moment it becomes an audit input
     * rather than information about a game still in progress. */
    const settled = battle.status === 'settled';

    return {
      code: battle.code,
      status: battle.status,
      mode: battle.mode,
      format: `${battle.team_count}x${battle.team_size}`,
      teamCount: battle.team_count,
      teamSize: battle.team_size,
      seatCount: battle.seat_count,
      visibility: battle.visibility,
      allowBots: battle.allow_bots,
      host: battle.host_name,
      isHost: viewerId !== null && viewerId === battle.host_user_id,
      entryCostMinor: battle.entry_cost_minor,
      potMinor: battle.pot_minor,
      winningTeam: battle.winning_team,
      createdAt: battle.created_at,
      startedAt: battle.started_at,
      settledAt: battle.settled_at,
      expiresAt: battle.expires_at,
      watchers: hub.watchers(battle.code),
      fairness: {
        serverSeedHash: battle.server_seed_hash,
        serverSeedReveal: battle.server_seed_reveal,
        combinedSeedHash: battle.combined_seed_hash,
        nonce: battle.nonce,
        formula: 'SHA256(serverSeed + clientSeed[0..n] + nonce), then HMAC(combined, "round:seat")',
      },
      rounds: rounds.rows.map((row) => ({
        index: row.round_index,
        caseId: row.case_id,
        name: row.name,
        slug: row.slug,
        priceMinor: row.price_minor,
        imageUrl: row.image_url,
        metadata: row.metadata ?? {},
      })),
      seats: seats.rows.map((row) => ({
        seat: row.seat,
        team: row.team,
        name: row.display_name,
        isBot: row.is_bot,
        isYou: viewerId !== null && row.user_id === viewerId,
        stakedMinor: row.staked_minor,
        totalDropMinor: row.total_drop_minor,
        payoutMinor: row.payout_minor,
        clientSeed: settled ? row.client_seed : null,
      })),
      results: results.rows.map((row) => ({
        round: row.round_index,
        seat: row.seat,
        payoutMinor: row.payout_minor,
        rollDigest: settled ? row.roll_digest : null,
        rollWeight: settled ? row.roll_weight : null,
        totalWeight: settled ? row.total_weight : null,
        item: {
          minecraftName: row.minecraft_name,
          displayName: row.display_name,
          imageUrl: row.image_url,
          unitValueMinor: row.unit_value_minor,
          metadata: row.metadata ?? {},
        },
      })),
    };
  }

  /* ─────────────────────────── settlement ─────────────────────────── */

  /**
   * Rolls every reel, decides the winner and pays the pot. One transaction, all or nothing.
   *
   * Called with the battle row already locked FOR UPDATE by the caller, so two players filling
   * the last seat at the same instant cannot both trigger a settlement.
   */
  async function settleBattle(client: DbClient, battleId: string): Promise<void> {
    const battleResult = await client.query<{
      id: string; code: string; mode: string; team_size: number; nonce: number;
      server_seed_ciphertext: string; server_seed_hash: string; status: string;
    }>(
      `SELECT id, code, mode, team_size, nonce, server_seed_ciphertext, server_seed_hash, status
         FROM battles WHERE id = $1 FOR UPDATE`,
      [battleId],
    );
    const battle = battleResult.rows[0];
    if (!battle) throw new AppError(404, 'BATTLE_NOT_FOUND', 'No such battle');
    // Idempotent: a retry that arrives after the first settlement is a no-op, not a second payout.
    if (battle.status === 'settled') return;
    if (battle.status !== 'lobby' && battle.status !== 'running') {
      throw new AppError(409, 'BATTLE_NOT_RUNNABLE', 'This battle cannot be settled');
    }

    const serverSeed = decryptSecret(
      battle.server_seed_ciphertext,
      config.dataEncryptionKey,
      `battle:${battle.id}`,
    );
    if (hashServerSeed(serverSeed) !== battle.server_seed_hash) {
      throw new AppError(500, 'FAIRNESS_MISMATCH', 'The committed server seed does not verify');
    }

    const seats = await client.query<{
      seat: number; team: number; user_id: string | null; is_bot: boolean; client_seed: string;
    }>(
      `SELECT seat, team, user_id, is_bot, client_seed
         FROM battle_players WHERE battle_id = $1 ORDER BY seat`,
      [battleId],
    );
    const rounds = await client.query<{ round_index: number; case_id: string; price_minor: string }>(
      `SELECT round_index, case_id, price_minor FROM battle_rounds
        WHERE battle_id = $1 ORDER BY round_index`,
      [battleId],
    );
    if (seats.rows.length === 0 || rounds.rows.length === 0) {
      throw new AppError(409, 'BATTLE_INCOMPLETE', 'This battle has no seats or no rounds');
    }

    // Seat order is the definition, so the seeds are combined in the order the query returned.
    const combined = combineSeeds(
      serverSeed,
      seats.rows.map((row) => row.client_seed),
      battle.nonce,
    );

    /* Every crate's weight table, read once. A crate appearing twice in the round list is rolled
     * twice from the same table, which is correct: the second open is independent of the first. */
    const dropsByCase = new Map<string, DropRow[]>();
    for (const round of rounds.rows) {
      if (dropsByCase.has(round.case_id)) continue;
      const drops = await client.query<DropRow>(
        `SELECT k.catalog_item_id, k.weight, ci.unit_value_minor
           FROM case_items k JOIN catalog_items ci ON ci.id = k.catalog_item_id
          WHERE k.case_id = $1 AND k.enabled AND ci.enabled
          ORDER BY ci.unit_value_minor, k.catalog_item_id`,
        [round.case_id],
      );
      if (drops.rows.length === 0) {
        throw new AppError(409, 'CASE_EMPTY', 'A crate in this battle has no enabled drops');
      }
      dropsByCase.set(round.case_id, drops.rows);
    }

    const totals = new Map<number, bigint>();
    for (const seat of seats.rows) totals.set(seat.seat, 0n);

    for (const round of rounds.rows) {
      const drops = dropsByCase.get(round.case_id) ?? [];
      const totalWeight = drops.reduce((sum, drop) => sum + BigInt(drop.weight), 0n);

      for (const seat of seats.rows) {
        const digest = reelDigest(combined, round.round_index, seat.seat);
        const rollWeight = digestToRollWeight(digest, totalWeight);

        let cursor = 0n;
        let chosen = drops[drops.length - 1];
        let chosenWeight = chosen ? chosen.weight : 1;
        for (const drop of drops) {
          cursor += BigInt(drop.weight);
          if (rollWeight < cursor) {
            chosen = drop;
            chosenWeight = drop.weight;
            break;
          }
        }
        if (!chosen) throw new AppError(500, 'ROLL_FAILED', 'A reel resolved to no outcome');

        const payout = BigInt(chosen.unit_value_minor);
        totals.set(seat.seat, (totals.get(seat.seat) ?? 0n) + payout);

        await client.query(
          `INSERT INTO battle_results
             (battle_id, round_index, seat, case_id, catalog_item_id, roll_digest, roll_weight,
              total_weight, awarded_weight, payout_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            battleId, round.round_index, seat.seat, round.case_id, chosen.catalog_item_id,
            digest, rollWeight.toString(), totalWeight.toString(), chosenWeight,
            payout.toString(),
          ],
        );
      }
    }

    const botSeats = new Set(seats.rows.filter((row) => row.is_bot).map((row) => row.seat));
    const seatTotals: SeatTotal[] = seats.rows.map((row) => ({
      seat: row.seat,
      team: row.team,
      totalDropMinor: totals.get(row.seat) ?? 0n,
    }));
    const outcome = resolveBattle(seatTotals, battle.mode as BattleMode, botSeats);

    for (const seat of seats.rows) {
      const payout = outcome.payouts.get(seat.seat) ?? 0n;
      await client.query(
        `UPDATE battle_players
            SET total_drop_minor = $3, payout_minor = $4
          WHERE battle_id = $1 AND seat = $2`,
        [battleId, seat.seat, (totals.get(seat.seat) ?? 0n).toString(), payout.toString()],
      );
      if (payout > 0n && seat.user_id) {
        /* Deterministic, so a retried settlement collides on the ledger's UNIQUE (kind,
         * reference_id) instead of paying the pot a second time. */
        await creditWallet(
          client, seat.user_id, payout, 'battle_win',
          deterministicUuid('battle_win', battleId, seat.seat),
        );
      }
    }

    /* Creator royalties. A community crate pays its author every time it is opened, including
     * inside a battle — a crate that earned nothing when used competitively would push creators
     * away from the feature that shows their work off.
     *
     * One royalty per crate per battle, sized by how many HUMAN seats opened it. Bot seats spin
     * reels that fund the pot but stake nothing, so paying a creator for them would mint royalty
     * out of money nobody put in. */
    const humanSeats = seats.rows.filter((row) => !row.is_bot).length;
    const opensByCase = new Map<string, number>();
    for (const round of rounds.rows) {
      opensByCase.set(round.case_id, (opensByCase.get(round.case_id) ?? 0) + humanSeats);
    }
    for (const [caseId, openCount] of opensByCase) {
      await payCreatorRoyalty(
        client, caseId, null, 'battle',
        deterministicUuid('creator_royalty', battleId, caseId), openCount,
      );
    }

    await client.query(
      `UPDATE battles
          SET status = 'settled', settled_at = now(), server_seed_reveal = $2,
              combined_seed_hash = $3, pot_minor = $4, winning_team = $5
        WHERE id = $1`,
      [
        battleId, serverSeed, combined, outcome.potMinor.toString(), outcome.winningTeam,
      ],
    );
  }

  /* ─────────────────────────── REST ─────────────────────────── */

  app.get('/v1/battles/modes', async () => ({
    modes: BATTLE_MODES,
    minRounds: MIN_ROUNDS,
    maxRounds: MAX_ROUNDS,
    lobbyTtlMs: LOBBY_TTL_MS,
  }));

  app.get('/v1/battles', { preHandler: softAuth }, async (request) => {
    const query = parseWith(listQuery, request.query);
    const result = await db.query<{ code: string }>(
      `SELECT b.code
         FROM battles b
        WHERE b.status = $1
          AND (b.visibility = 'public' OR b.status <> 'lobby')
          AND (b.status <> 'lobby' OR b.expires_at > now())
        ORDER BY b.created_at DESC
        LIMIT $2`,
      [query.status, query.limit],
    );
    const viewerId = request.authUser?.id ?? null;
    const battles = [];
    for (const row of result.rows) battles.push(await readBattle(row.code, viewerId));
    return { battles };
  });

  app.get('/v1/battles/:code', { preHandler: softAuth }, async (request) => {
    const params = parseWith(codeSchema, request.params);
    return { battle: await readBattle(params.code, request.authUser?.id ?? null) };
  });

  app.post(
    '/v1/battles',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseWith(createSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to host a battle');

      const shape = shapeFor(body.format);

      const created = await db.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

        const open = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM battles
            WHERE host_user_id = $1 AND status = 'lobby' AND expires_at > now()`,
          [userId],
        );
        if (Number(open.rows[0]?.count ?? 0) >= MAX_OPEN_LOBBIES_PER_USER) {
          throw new AppError(
            429, 'TOO_MANY_LOBBIES',
            `You already have ${MAX_OPEN_LOBBIES_PER_USER} open lobbies`,
          );
        }

        /* Prices come from the database. The client sends ids and nothing else, so a tampered
         * body cannot stake less than the crates it selected actually cost. */
        const crates = await client.query<CaseRow>(
          `SELECT id, name, slug, price_minor, image_url, metadata, creator_user_id,
                  royalty_bps, community_status
             FROM cases
            WHERE id = ANY($1::uuid[]) AND enabled
              AND community_status IN ('first_party', 'published')`,
          [body.caseIds],
        );
        const byId = new Map(crates.rows.map((row) => [row.id, row]));
        for (const id of body.caseIds) {
          if (!byId.has(id)) {
            throw new AppError(400, 'CASE_UNAVAILABLE', 'A selected crate is not available');
          }
        }

        let entryCost = 0n;
        for (const id of body.caseIds) entryCost += BigInt(byId.get(id)?.price_minor ?? '0');
        if (entryCost <= 0n) throw new AppError(400, 'INVALID_WAGER', 'The wager must be positive');

        const battleId = randomUUID();
        const serverSeed = generateServerSeed();
        const code = battleCodeFrom(randomBytes(16));

        await client.query(
          `INSERT INTO battles
             (id, code, host_user_id, team_count, team_size, seat_count, mode, visibility,
              allow_bots, entry_cost_minor, status, server_seed_hash, server_seed_ciphertext,
              expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'lobby', $11, $12,
                   now() + make_interval(secs => $13))`,
          [
            battleId, code, userId, shape.teamCount, shape.teamSize, shape.seatCount,
            body.mode, body.visibility, body.allowBots, entryCost.toString(),
            hashServerSeed(serverSeed),
            encryptSecret(serverSeed, config.dataEncryptionKey, `battle:${battleId}`),
            Math.round(LOBBY_TTL_MS / 1000),
          ],
        );

        for (let index = 0; index < body.caseIds.length; index += 1) {
          const id = body.caseIds[index];
          if (!id) continue;
          await client.query(
            `INSERT INTO battle_rounds (battle_id, round_index, case_id, price_minor)
             VALUES ($1, $2, $3, $4)`,
            [battleId, index, id, byId.get(id)?.price_minor ?? '0'],
          );
        }

        await takeSeat(client, battleId, 0, shape.teamSize, userId, body.clientSeed, entryCost);
        return { code, battleId };
      });

      const battle = await readBattle(created.code, userId);
      hub.broadcastLobby({ type: 'lobby:created', battle });
      return reply.code(201).send({ battle });
    },
  );

  app.post(
    '/v1/battles/:code/join',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(codeSchema, request.params);
      const body = parseWith(joinSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to join a battle');

      const filled = await db.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

        const battleResult = await client.query<{
          id: string; status: string; seat_count: number; team_size: number;
          entry_cost_minor: string; expires_at: Date;
        }>(
          `SELECT id, status, seat_count, team_size, entry_cost_minor, expires_at
             FROM battles WHERE code = $1 FOR UPDATE`,
          [params.code],
        );
        const battle = battleResult.rows[0];
        if (!battle) throw new AppError(404, 'BATTLE_NOT_FOUND', 'No battle with that code');
        if (battle.status !== 'lobby') {
          throw new AppError(409, 'BATTLE_CLOSED', 'This battle has already started');
        }
        if (battle.expires_at.getTime() <= Date.now()) {
          throw new AppError(409, 'BATTLE_EXPIRED', 'This lobby has expired');
        }

        const taken = await client.query<{ seat: number; user_id: string | null }>(
          `SELECT seat, user_id FROM battle_players WHERE battle_id = $1 ORDER BY seat`,
          [battle.id],
        );
        if (taken.rows.some((row) => row.user_id === userId)) {
          throw new AppError(409, 'ALREADY_SEATED', 'You are already in this battle');
        }
        const used = new Set(taken.rows.map((row) => row.seat));
        let seat = -1;
        for (let index = 0; index < battle.seat_count; index += 1) {
          if (!used.has(index)) { seat = index; break; }
        }
        if (seat < 0) throw new AppError(409, 'BATTLE_FULL', 'Every seat is taken');

        await takeSeat(
          client, battle.id, seat, battle.team_size, userId, body.clientSeed,
          BigInt(battle.entry_cost_minor),
        );

        const isFull = taken.rows.length + 1 >= battle.seat_count;
        if (isFull) {
          await client.query(
            `UPDATE battles SET status = 'running', started_at = now() WHERE id = $1`,
            [battle.id],
          );
          await settleBattle(client, battle.id);
        }
        return { battleId: battle.id, isFull };
      });

      const battle = await readBattle(params.code, userId);
      hub.broadcast(params.code, { type: 'battle:seat', code: params.code, battle });
      hub.broadcastLobby({ type: 'lobby:updated', battle });
      if (filled.isFull) announceStart(params.code, battle);
      return { battle };
    },
  );

  app.post(
    '/v1/battles/:code/bots',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(codeSchema, request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      await db.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const battleResult = await client.query<{
          id: string; host_user_id: string; status: string; seat_count: number;
          team_size: number; allow_bots: boolean;
        }>(
          `SELECT id, host_user_id, status, seat_count, team_size, allow_bots
             FROM battles WHERE code = $1 FOR UPDATE`,
          [params.code],
        );
        const battle = battleResult.rows[0];
        if (!battle) throw new AppError(404, 'BATTLE_NOT_FOUND', 'No battle with that code');
        if (battle.host_user_id !== userId) {
          throw new AppError(403, 'NOT_HOST', 'Only the host can add bots');
        }
        if (!battle.allow_bots) {
          throw new AppError(409, 'BOTS_DISABLED', 'This battle was created without bot fillers');
        }
        if (battle.status !== 'lobby') {
          throw new AppError(409, 'BATTLE_CLOSED', 'This battle has already started');
        }

        const taken = await client.query<{ seat: number }>(
          `SELECT seat FROM battle_players WHERE battle_id = $1`,
          [battle.id],
        );
        const used = new Set(taken.rows.map((row) => row.seat));
        for (let seat = 0; seat < battle.seat_count; seat += 1) {
          if (used.has(seat)) continue;
          await client.query(
            `INSERT INTO battle_players
               (battle_id, seat, team, user_id, is_bot, display_name, client_seed, staked_minor)
             VALUES ($1, $2, $3, NULL, true, $4, $5, 0)`,
            [
              battle.id, seat, teamForSeat(seat, battle.team_size),
              BOT_NAMES[seat % BOT_NAMES.length] ?? `Bot ${seat}`,
              randomBytes(16).toString('hex'),
            ],
          );
        }

        await client.query(
          `UPDATE battles SET status = 'running', started_at = now() WHERE id = $1`,
          [battle.id],
        );
        await settleBattle(client, battle.id);
      });

      const battle = await readBattle(params.code, userId);
      hub.broadcast(params.code, { type: 'battle:seat', code: params.code, battle });
      hub.broadcastLobby({ type: 'lobby:updated', battle });
      announceStart(params.code, battle);
      return { battle };
    },
  );

  app.post(
    '/v1/battles/:code/leave',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(codeSchema, request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const cancelled = await db.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
        const battleResult = await client.query<{ id: string; status: string; host_user_id: string }>(
          `SELECT id, status, host_user_id FROM battles WHERE code = $1 FOR UPDATE`,
          [params.code],
        );
        const battle = battleResult.rows[0];
        if (!battle) throw new AppError(404, 'BATTLE_NOT_FOUND', 'No battle with that code');
        if (battle.status !== 'lobby') {
          throw new AppError(409, 'BATTLE_CLOSED', 'A running battle cannot be left');
        }

        const seat = await client.query<{ seat: number; staked_minor: string }>(
          `SELECT seat, staked_minor FROM battle_players
            WHERE battle_id = $1 AND user_id = $2`,
          [battle.id, userId],
        );
        const row = seat.rows[0];
        if (!row) throw new AppError(404, 'NOT_SEATED', 'You are not in this battle');

        /* Refund, then remove the seat. The refund is keyed on battle and seat so a double leave
         * cannot pay twice: the wallet ledger's unique (kind, reference_id) rejects the second. */
        if (BigInt(row.staked_minor) > 0n) {
          await creditWallet(
            client, userId, BigInt(row.staked_minor), 'battle_refund',
            deterministicUuid('battle_refund', battle.id, row.seat),
          );
        }
        await client.query(
          `DELETE FROM battle_players WHERE battle_id = $1 AND seat = $2`,
          [battle.id, row.seat],
        );

        /* The host leaving cancels the lobby and refunds everybody, rather than leaving an
         * ownerless room that can never be started or cleaned up. */
        if (battle.host_user_id === userId) {
          const remaining = await client.query<{ seat: number; user_id: string | null; staked_minor: string }>(
            `SELECT seat, user_id, staked_minor FROM battle_players WHERE battle_id = $1`,
            [battle.id],
          );
          for (const other of remaining.rows) {
            if (other.user_id && BigInt(other.staked_minor) > 0n) {
              await creditWallet(
                client, other.user_id, BigInt(other.staked_minor), 'battle_refund',
                deterministicUuid('battle_refund', battle.id, other.seat),
              );
            }
          }
          await client.query(`DELETE FROM battle_players WHERE battle_id = $1`, [battle.id]);
          await client.query(
            `UPDATE battles SET status = 'cancelled' WHERE id = $1`, [battle.id],
          );
          return true;
        }
        return false;
      });

      if (cancelled) {
        hub.broadcast(params.code, {
          type: 'battle:cancelled', code: params.code, reason: 'The host left the lobby',
        });
        hub.broadcastLobby({ type: 'lobby:removed', code: params.code });
        return { cancelled: true };
      }
      const battle = await readBattle(params.code, userId);
      hub.broadcast(params.code, { type: 'battle:seat', code: params.code, battle });
      hub.broadcastLobby({ type: 'lobby:updated', battle });
      return { battle };
    },
  );

  /**
   * Fast Roll.
   *
   * Changes the shared round duration and republishes the anchor, so every client recomputes the
   * SAME schedule from the same two numbers. Nobody's animation is sped up locally — that would
   * desynchronise the table instantly — they are all re-derived from one broadcast.
   */
  app.post(
    '/v1/battles/:code/speed',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(codeSchema, request.params);
      const body = parseWith(fastSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const result = await db.query<{ host_user_id: string; status: string; rounds: number }>(
        `SELECT b.host_user_id, b.status,
                (SELECT count(*) FROM battle_rounds r WHERE r.battle_id = b.id)::int AS rounds
           FROM battles b WHERE b.code = $1`,
        [params.code],
      );
      const battle = result.rows[0];
      if (!battle) throw new AppError(404, 'BATTLE_NOT_FOUND', 'No battle with that code');
      if (battle.host_user_id !== userId) {
        throw new AppError(403, 'NOT_HOST', 'Only the host controls the roll speed');
      }

      const schedule = roundSchedule(Date.now() + START_LEAD_MS, battle.rounds, body.fast);
      hub.broadcast(params.code, {
        type: 'battle:speed',
        code: params.code,
        fast: body.fast,
        startsAt: schedule.startsAt,
        roundMs: schedule.roundMs,
      });
      return { fast: body.fast, startsAt: schedule.startsAt, roundMs: schedule.roundMs };
    },
  );

  /* ─────────────────────────── WebSocket ─────────────────────────── */

  app.get('/v1/battles/live', { websocket: true }, (socket) => {
    /* @fastify/websocket v11 hands the raw ws socket straight to the handler. Everything the hub
     * needs is on it; there is no wrapper object to unpack.
     *
     * The subscriber is registered with a null user, and that is explicit rather than accidental.
     * This route runs no authentication preHandler, so `request.authUser` was always undefined and
     * the id passed here was always null — it merely looked as though the socket knew who was on
     * it. Passing null openly means anything added later that needs an identity has to authenticate
     * the socket first, instead of inheriting a value that reads as already solved. */
    const subscriber = hub.add(socket, null);
    const budget = createSocketBudget(LOBBY_SOCKET_BUDGET);

    socket.on('message', (raw: Buffer) => {
      if (!budget.take()) return;
      /* Everything arriving on a socket is untrusted and unvalidated by any route schema, so it
       * is parsed defensively and answered with a tiny, fixed vocabulary. A socket cannot move
       * money: joining, leaving and starting are all REST calls behind CSRF. */
      let message: unknown;
      try {
        if (raw.length > 4096) throw new Error('frame too large');
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        hub.send(subscriber, { type: 'error', message: 'Malformed frame' });
        return;
      }
      if (typeof message !== 'object' || message === null) return;
      const action = (message as { type?: unknown }).type;
      const code = (message as { code?: unknown }).code;

      if (action === 'ping') {
        hub.send(subscriber, { type: 'pong', now: Date.now() });
        return;
      }
      if (typeof code !== 'string' || !/^[A-Z0-9]{6,12}$/.test(code)) return;
      if (action === 'watch') hub.join(subscriber, code);
      else if (action === 'unwatch') hub.leave(subscriber, code);
    });

    socket.on('close', () => {
      if (budget.refused > 0) {
        app.log.warn({ refused: budget.refused }, 'battle socket exceeded its frame budget');
      }
      hub.remove(subscriber);
    });
  });

  /* ─────────────────────────── helpers ─────────────────────────── */

  /**
   * Buys a seat: debits the wallet under a locked row, then writes the seat.
   *
   * The debit is guarded by `balance_minor >= $2` in the UPDATE itself rather than by a read
   * followed by a write, so two concurrent joins cannot both pass a balance check and leave the
   * wallet negative.
   */
  async function takeSeat(
    client: DbClient,
    battleId: string,
    seat: number,
    teamSize: number,
    userId: string,
    clientSeed: string,
    stake: bigint,
  ): Promise<void> {
    const user = await client.query<{ minecraft_username: string; status: string }>(
      `SELECT minecraft_username, status FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const player = user.rows[0];
    if (!player) throw new AppError(404, 'USER_NOT_FOUND', 'No such account');
    if (player.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account cannot place wagers');
    }

    await client.query(
      `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const debited = await client.query<{ balance_minor: string }>(
      `UPDATE user_wallets
          SET balance_minor = balance_minor - $2, updated_at = now()
        WHERE user_id = $1 AND balance_minor >= $2
        RETURNING balance_minor`,
      [userId, stake.toString()],
    );
    if (debited.rows.length === 0) {
      throw new AppError(402, 'INSUFFICIENT_FUNDS', 'Your balance does not cover this battle');
    }
    const balanceAfter = debited.rows[0]?.balance_minor ?? '0';

    await client.query(
      `INSERT INTO wallet_transactions
         (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
       VALUES ($1, $2, $3, $4, 'battle_stake', $5)`,
      [
        randomUUID(), userId, (-stake).toString(), balanceAfter,
        deterministicUuid('battle_stake', battleId, seat),
      ],
    );

    await client.query(
      `INSERT INTO battle_players
         (battle_id, seat, team, user_id, is_bot, display_name, client_seed, staked_minor)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7)`,
      [
        battleId, seat, teamForSeat(seat, teamSize), userId,
        player.minecraft_username, clientSeed, stake.toString(),
      ],
    );

    /* Battle stakes count toward quests and the faction war exactly as a solo open does. A
     * wager is a wager; routing it differently because it happened in a battle would quietly
     * make the competitive mode the wrong way to chase a daily. */
    await recordWager(
      client, config, userId, stake, 'case',
      deterministicUuid('battle_wager', battleId, seat), ['cases_opened'],
    );
  }

  /** Publishes the start: the outcomes are already final, only the clock is new. */
  function announceStart(code: string, battle: { rounds: unknown[] }): void {
    const schedule = roundSchedule(Date.now() + START_LEAD_MS, battle.rounds.length, false);
    hub.broadcast(code, { type: 'battle:start', code, battle: { ...battle, schedule } });
    hub.broadcastLobby({ type: 'lobby:updated', battle });
  }

  return hub;
}
