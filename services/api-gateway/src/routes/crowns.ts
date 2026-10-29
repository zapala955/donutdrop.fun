import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import { CROWN_GAMES, MAX_OPEN_BOUNTIES, readCrownBoard } from '../lib/crowns.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { liveEvents } from '../lib/live-events.js';
import { parseWith } from '../lib/validation.js';

/**
 * Crowns and bounties (lib/crowns.ts): the board everybody can read, and the two staff buttons.
 *
 * The board is public, like the leaderboard it sits on: masked names, multipliers and stakes, the
 * same things the live feed already shows. Signed in, it also says what the viewer's own best is on
 * each game, which is what they would have to beat.
 *
 * Nothing here crowns anybody or pays a bounty. The sweeper does both from finished rounds; a staff
 * member can only put a bounty up or take an open one down, and both are audited.
 */

const minorString = z.string().regex(/^[1-9][0-9]{0,17}$/, 'a whole amount');

const bountySchema = z
  .object({
    game: z.enum(CROWN_GAMES),
    /* As a player reads it: 1000 means 1,000x. Stored in hundredths. */
    minMultiplier: z.number().min(1.01).max(1_000_000),
    minStakeMinor: minorString,
    prizeMinor: minorString,
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 14),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

const cancelParams = z.object({ id: z.uuid() }).strict();
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

export async function registerCrownRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  /* Readable signed out: a crown nobody can see before signing up is not worth chasing. */
  const softAuth = async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* anonymous is a valid answer here */
    }
  };

  app.get(
    '/v1/crowns',
    { preHandler: softAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => readCrownBoard(db, config, request.authUser?.id ?? null),
  );

  /** Puts a bounty up. Staff only: it spends the house's money, like a rain. */
  app.post(
    '/v1/crowns/bounties',
    { preHandler: guards.requireAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      if (!config.crownsEnabled) {
        throw new AppError(404, 'CROWNS_DISABLED', 'Crowns are not switched on');
      }
      const actorId = request.authUser?.id;
      if (!actorId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const body = parseWith(bountySchema, request.body);
      const prize = BigInt(body.prizeMinor);
      if (prize > config.crownBountyMaxPrizeMinor) {
        throw new AppError(
          400,
          'BOUNTY_PRIZE_TOO_LARGE',
          'That exceeds the largest bounty prize allowed',
        );
      }
      const multiplierX100 = BigInt(Math.round(body.minMultiplier * 100));

      const id = randomUUID();
      const created = await db.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('crown-bounty-create', 0))",
        );
        const open = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM crown_bounties WHERE status = 'open' AND closes_at > now()`,
        );
        if (Number(open.rows[0]?.n ?? '0') >= MAX_OPEN_BOUNTIES) {
          throw new AppError(
            409,
            'BOUNTY_LIMIT',
            `At most ${MAX_OPEN_BOUNTIES} bounties can be open at once`,
          );
        }
        const inserted = await client.query<{ opens_at: Date; closes_at: Date }>(
          `INSERT INTO crown_bounties
             (id, game, min_multiplier_x100, min_stake_minor, prize_minor, opens_at, closes_at, created_by)
           VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(hours => $6), $7)
           RETURNING opens_at, closes_at`,
          [
            id,
            body.game,
            multiplierX100.toString(),
            body.minStakeMinor,
            prize.toString(),
            body.hours,
            actorId,
          ],
        );
        await appendAudit(client, config, {
          actorUserId: actorId,
          action: 'crown_bounty.create',
          targetType: 'crown_bounty',
          targetId: id,
          details: {
            game: body.game,
            minMultiplierX100: multiplierX100.toString(),
            minStakeMinor: body.minStakeMinor,
            prizeMinor: prize.toString(),
            hours: body.hours,
            reason: body.reason,
          },
        });
        return inserted.rows[0]!;
      });
      liveEvents.publish('crowns');
      return {
        id,
        game: body.game,
        minMultiplierX100: multiplierX100.toString(),
        minStakeMinor: body.minStakeMinor,
        prizeMinor: prize.toString(),
        opensAt: new Date(created.opens_at).toISOString(),
        closesAt: new Date(created.closes_at).toISOString(),
      };
    },
  );

  /** Takes an open bounty down. A bounty that has been won stays won. */
  app.post(
    '/v1/crowns/bounties/:id/cancel',
    { preHandler: guards.requireAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const actorId = request.authUser?.id;
      if (!actorId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
      const { id } = parseWith(cancelParams, request.params);
      const body = parseWith(cancelSchema, request.body ?? {});
      await db.transaction(async (client) => {
        const cancelled = await client.query(
          `UPDATE crown_bounties SET status = 'cancelled' WHERE id = $1 AND status = 'open'`,
          [id],
        );
        if (!cancelled.rowCount) {
          throw new AppError(404, 'BOUNTY_NOT_OPEN', 'That bounty is not open');
        }
        await appendAudit(client, config, {
          actorUserId: actorId,
          action: 'crown_bounty.cancel',
          targetType: 'crown_bounty',
          targetId: id,
          details: { reason: body.reason },
        });
      });
      liveEvents.publish('crowns');
      return { id, status: 'cancelled' };
    },
  );
}
