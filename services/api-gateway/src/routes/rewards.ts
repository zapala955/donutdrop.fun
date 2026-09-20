import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import {
  RAKEBACK_TIERS,
  TIER_COOLDOWN_MS,
  isValidCurve,
  prizeForRank,
  settleRace,
  tierViews,
  type RakebackTier,
} from '../lib/rewards.js';
import { parseWith } from '../lib/validation.js';
import { creditWallet } from '../lib/wallet.js';

/**
 * Rakeback, wagering races and the creator programme.
 *
 * Everything here pays real balance, so every claim goes through the same wallet ledger as a case
 * win and every one of them is made idempotent by a lock plus a condition on the row, rather than
 * by trusting a client-supplied key. A retried request finds the balance already zero or the
 * cooldown already running, and is refused instead of paying twice.
 */

const claimSchema = z.object({ tier: z.enum(RAKEBACK_TIERS) }).strict();
const applySchema = z
  .object({
    platform: z.enum(['youtube', 'twitch', 'tiktok', 'kick', 'x']),
    channelUrl: z
      .string()
      .trim()
      .min(4)
      .max(512)
      .refine((value) => /^https:\/\//.test(value), 'must be an https URL'),
    audienceSize: z.number().int().min(0).max(1_000_000_000),
    requestedCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{3,16}$/),
  })
  .strict();

interface AccrualRow {
  tier: string;
  accrued_minor: string;
  claimed_minor: string;
  last_claim_at: Date | null;
}

interface RaceRow {
  id: string;
  slug: string;
  name: string;
  cadence: string;
  starts_at: Date;
  ends_at: Date;
  prize_pool_minor: string;
  payout_curve: unknown;
  settled_at: Date | null;
}

export async function registerRewardRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  function requireFeature(enabled: boolean, code: string): void {
    if (!enabled) throw new AppError(404, code, 'That programme is not enabled');
  }

  // ── rakeback ──────────────────────────────────────────────────────────────

  app.get('/v1/rakeback', { preHandler: guards.authenticate }, async (request) => {
    requireFeature(config.rakebackEnabled, 'RAKEBACK_DISABLED');
    const userId = requireUserId(request.authUser?.id);

    const accruals = await db.query<AccrualRow>(
      'SELECT tier, accrued_minor, claimed_minor, last_claim_at FROM rakeback_accruals WHERE user_id = $1',
      [userId],
    );
    const history = await db.query<{ tier: string; amount_minor: string; created_at: Date }>(
      `SELECT tier, amount_minor, created_at FROM rakeback_claims
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [userId],
    );

    const tiers = tierViews(config, accruals.rows);
    const lifetime = tiers.reduce((sum, tier) => sum + BigInt(tier.claimedMinor), 0n);
    const claimable = tiers.reduce((sum, tier) => sum + BigInt(tier.claimableMinor), 0n);

    return {
      // The rates are shares of the house margin, and the client is told the edge so it never has
      // to guess what the percentage is a percentage of.
      houseEdgeBps: config.houseEdgeBps,
      tiers,
      totals: {
        claimableMinor: claimable.toString(),
        lifetimeMinor: lifetime.toString(),
      },
      history: history.rows.map((row) => ({
        tier: row.tier,
        amountMinor: row.amount_minor,
        createdAt: row.created_at,
      })),
    };
  });

  app.post(
    '/v1/rakeback/claim',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      requireFeature(config.rakebackEnabled, 'RAKEBACK_DISABLED');
      const body = parseWith(claimSchema, request.body);
      const userId = requireUserId(request.authUser?.id);
      const tier: RakebackTier = body.tier;

      return db.transaction(async (client) => {
        /* The accrual row is the lock AND the idempotency key. A replayed claim blocks here, then
         * reads a row whose claimed_minor already equals accrued_minor and is refused for an
         * empty balance — so a double-submit cannot pay twice even inside the same millisecond. */
        const locked = await client.query<AccrualRow>(
          `SELECT tier, accrued_minor, claimed_minor, last_claim_at
             FROM rakeback_accruals WHERE user_id = $1 AND tier = $2 FOR UPDATE`,
          [userId, tier],
        );
        const row = locked.rows[0];
        if (!row) throw new AppError(404, 'RAKEBACK_EMPTY', 'Nothing has accrued on that tier');

        const amount = BigInt(row.accrued_minor) - BigInt(row.claimed_minor);
        if (amount <= 0n) conflict('RAKEBACK_EMPTY', 'That tier has nothing to claim');

        const cooldown = TIER_COOLDOWN_MS[tier];
        if (cooldown > 0 && row.last_claim_at) {
          const readyAt = new Date(row.last_claim_at).getTime() + cooldown;
          if (readyAt > Date.now()) {
            throw new AppError(409, 'RAKEBACK_COOLING_DOWN', 'That tier is still on cooldown', {
              availableAt: new Date(readyAt).toISOString(),
            });
          }
        }

        const balanceAfter = await creditWallet(
          client,
          userId,
          amount,
          'rakeback_claim',
          randomUUID(),
        );
        await client.query(
          `UPDATE rakeback_accruals
              SET claimed_minor = accrued_minor, last_claim_at = now(), updated_at = now()
            WHERE user_id = $1 AND tier = $2`,
          [userId, tier],
        );
        await client.query(
          `INSERT INTO rakeback_claims (id, user_id, tier, amount_minor, balance_after_minor)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), userId, tier, amount.toString(), balanceAfter],
        );

        return { tier, claimedMinor: amount.toString(), balanceMinor: balanceAfter };
      });
    },
  );

  // ── wagering races ────────────────────────────────────────────────────────

  app.get('/v1/races', async (request) => {
    requireFeature(config.racesEnabled, 'RACES_DISABLED');
    const viewerId = request.authUser?.id ?? null;

    const races = await db.query<RaceRow>(
      `SELECT id, slug, name, cadence, starts_at, ends_at, prize_pool_minor, payout_curve,
              settled_at
         FROM wager_races
        WHERE settled_at IS NULL AND now() < ends_at
        ORDER BY ends_at ASC
        LIMIT 8`,
    );

    const boards = await Promise.all(
      races.rows.map(async (race) => {
        const entries = await db.query<{
          user_id: string;
          minecraft_username: string;
          wagered_minor: string;
        }>(
          `SELECT e.user_id, u.minecraft_username, e.wagered_minor
             FROM wager_race_entries e JOIN users u ON u.id = e.user_id
            WHERE e.race_id = $1 AND e.wagered_minor > 0
            ORDER BY e.wagered_minor DESC, e.updated_at ASC
            LIMIT $2`,
          [race.id, config.raceLeaderboardSize],
        );

        const curve = isValidCurve(race.payout_curve) ? race.payout_curve : [];
        const pool = BigInt(race.prize_pool_minor);
        const leaderboard = entries.rows.map((entry, index) => ({
          rank: index + 1,
          username: entry.minecraft_username,
          // The viewer's own row is flagged server-side so the client never has to match on a
          // username, which is not a stable identifier.
          isViewer: viewerId !== null && entry.user_id === viewerId,
          wageredMinor: entry.wagered_minor,
          // Projected from the SAME function that settles the race, so the figure a player is
          // racing for is the figure they will actually be paid.
          projectedPrizeMinor: prizeForRank(pool, curve, index + 1).toString(),
        }));

        return {
          slug: race.slug,
          name: race.name,
          cadence: race.cadence,
          startsAt: race.starts_at,
          endsAt: race.ends_at,
          prizePoolMinor: race.prize_pool_minor,
          payoutCurveBps: curve,
          paidPlaces: curve.length,
          entrants: leaderboard.length,
          viewerRank: leaderboard.find((row) => row.isViewer)?.rank ?? null,
          leaderboard,
        };
      }),
    );

    return { races: boards, leaderboardSize: config.raceLeaderboardSize };
  });

  /**
   * Settles every race whose clock has run out.
   *
   * Open to any authenticated caller on purpose: it is idempotent, it only ever acts on races the
   * clock has already ended, and the alternative is a prize pool that sits unpaid until an
   * operator remembers to run something. A scheduled job can call it too; whoever gets there
   * first does the work and everybody else finds nothing to do.
   */
  app.post(
    '/v1/races/settle',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async () => {
      requireFeature(config.racesEnabled, 'RACES_DISABLED');
      const due = await db.query<{ id: string }>(
        `SELECT id FROM wager_races WHERE settled_at IS NULL AND now() >= ends_at
          ORDER BY ends_at ASC LIMIT 5`,
      );
      let settled = 0;
      let paid = 0;
      for (const race of due.rows) {
        paid += await db.transaction((client) => settleRace(client, config, race.id));
        settled += 1;
      }
      return { settled, paid };
    },
  );

  // ── creator programme ─────────────────────────────────────────────────────

  app.get('/v1/creators/me', { preHandler: guards.authenticate }, async (request) => {
    requireFeature(config.creatorProgrammeEnabled, 'CREATOR_PROGRAMME_DISABLED');
    const userId = requireUserId(request.authUser?.id);

    const application = await db.query<{
      id: string;
      platform: string;
      channel_url: string;
      audience_size: number;
      requested_code: string;
      status: string;
      granted_revshare_bps: number | null;
      review_note: string | null;
      created_at: Date;
      reviewed_at: Date | null;
    }>(
      `SELECT id, platform, channel_url, audience_size, requested_code, status,
              granted_revshare_bps, review_note, created_at, reviewed_at
         FROM creator_applications WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );

    /* The volume a creator has actually driven, read off the referral ledger rather than counted
     * separately: the creator programme is a boosted rate on the same relationship, so inventing a
     * second source of truth for the same number would guarantee the two disagree. */
    const driven = await db.query<{ referrals: string; wagered: string; earned: string }>(
      `SELECT count(*)::text AS referrals,
              coalesce(sum(r.wagered_minor), 0)::text AS wagered,
              coalesce(sum(
                r.revshare_paid_minor + r.revshare_claimable_minor
                + coalesce(r.bonus_paid_minor, 0)
              ), 0)::text AS earned
         FROM referrals r WHERE r.referrer_id = $1`,
      [userId],
    );
    const code = await db.query<{ code: string }>(
      'SELECT code FROM referral_codes WHERE user_id = $1',
      [userId],
    );

    const row = application.rows[0];
    const stats = driven.rows[0];
    return {
      maxRevshareBps: config.creatorMaxRevshareBps,
      defaultRevshareBps: config.referralRevshareBps,
      code: code.rows[0]?.code ?? null,
      application: row
        ? {
            id: row.id,
            platform: row.platform,
            channelUrl: row.channel_url,
            audienceSize: row.audience_size,
            requestedCode: row.requested_code,
            status: row.status,
            grantedRevshareBps: row.granted_revshare_bps,
            reviewNote: row.review_note,
            createdAt: row.created_at,
            reviewedAt: row.reviewed_at,
          }
        : null,
      metrics: {
        activeCodeUses: Number(stats?.referrals ?? '0'),
        volumeDrivenMinor: stats?.wagered ?? '0',
        earnedMinor: stats?.earned ?? '0',
      },
    };
  });

  app.post(
    '/v1/creators/apply',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request) => {
      requireFeature(config.creatorProgrammeEnabled, 'CREATOR_PROGRAMME_DISABLED');
      const body = parseWith(applySchema, request.body);
      const userId = requireUserId(request.authUser?.id);

      return db.transaction(async (client) => {
        /* The partial unique index allows exactly one pending row per account, so a second
         * application while one is open fails here rather than filling the review queue with
         * duplicates from somebody refreshing the form. */
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO creator_applications
             (id, user_id, platform, channel_url, audience_size, requested_code)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING
           RETURNING id`,
          [
            randomUUID(),
            userId,
            body.platform,
            body.channelUrl,
            body.audienceSize,
            body.requestedCode,
          ],
        );
        if (!inserted.rows[0]) {
          conflict('CREATOR_APPLICATION_OPEN', 'You already have an application under review');
        }
        return { id: inserted.rows[0].id, status: 'pending' };
      });
    },
  );

  app.post(
    '/v1/creators/withdraw',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      requireFeature(config.creatorProgrammeEnabled, 'CREATOR_PROGRAMME_DISABLED');
      const userId = requireUserId(request.authUser?.id);
      const updated = await db.query(
        `UPDATE creator_applications
            SET status = 'withdrawn', reviewed_at = now(), updated_at = now()
          WHERE user_id = $1 AND status = 'pending'`,
        [userId],
      );
      if (!updated.rowCount) {
        throw new AppError(404, 'CREATOR_APPLICATION_NONE', 'No application is under review');
      }
      return { withdrawn: true };
    },
  );
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
