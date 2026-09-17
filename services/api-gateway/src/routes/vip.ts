import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { LADDER, MAX_RATE, RATE_SCALE, progressFor } from '../lib/vip.js';

/**
 * The VIP ladder, and where one player stands on it.
 *
 * The whole thirty-row ladder is returned on every call rather than paginated or trimmed. It is a
 * fixed table of thirty small objects — under two kilobytes — and the dashboard renders all of it
 * at once, so splitting it across requests would trade a trivial payload for a loading state.
 *
 * The level is derived here from the lifetime total, never read from a column. There is no stored
 * level to go stale, and the rate shown on this page is computed by the same function that priced
 * the player's last wager.
 */

/** Rates are hundredths of a basis point on the wire, as they are in the ladder. */
function ratePercent(rate: number): number {
  return rate / Number(RATE_SCALE / 100n);
}

export async function registerVipRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  /**
   * The ladder alone, with no player attached.
   *
   * Public, because the VIP scale is a published term of the platform. Somebody deciding whether
   * to play here should be able to read what volume buys what rate without signing up first.
   */
  app.get('/v1/vip/ladder', async () => {
    if (!config.vipEnabled) {
      throw new AppError(404, 'VIP_DISABLED', 'The VIP programme is not enabled');
    }
    return {
      maxRatePercent: ratePercent(MAX_RATE),
      levels: LADDER.map((level) => ({
        level: level.level,
        tier: level.tier,
        tierLabel: level.tierLabel,
        sub: level.sub,
        label: level.label,
        thresholdMinor: level.thresholdMinor.toString(),
        ratePercent: ratePercent(level.rakebackBps),
      })),
    };
  });

  /** The ladder plus the caller's standing on it. */
  app.get('/v1/vip', { preHandler: guards.authenticate }, async (request) => {
    if (!config.vipEnabled) {
      throw new AppError(404, 'VIP_DISABLED', 'The VIP programme is not enabled');
    }
    const userId = request.authUser?.id;
    if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');

    const totals = await db.query<{ wagered_minor: string }>(
      'SELECT wagered_minor FROM user_wager_totals WHERE user_id = $1',
      [userId],
    );
    /* No row means no wager has ever settled for this account, which is Bronze I at zero rather
     * than an error. A player who has just signed up is on the ladder, at the bottom of it. */
    const wagered = BigInt(totals.rows[0]?.wagered_minor ?? '0');

    /* What the VIP tier has paid and is holding. Read off the shared rakeback ledger, which is
     * where VIP rakeback accrues — so this figure and the one on the rakeback page are the same
     * row, not two counts of the same money. */
    const accrual = await db.query<{ accrued_minor: string; claimed_minor: string }>(
      "SELECT accrued_minor, claimed_minor FROM rakeback_accruals WHERE user_id = $1 AND tier = 'vip'",
      [userId],
    );
    const accrued = BigInt(accrual.rows[0]?.accrued_minor ?? '0');
    const claimed = BigInt(accrual.rows[0]?.claimed_minor ?? '0');

    const { current, next, ratio, remainingMinor } = progressFor(wagered);

    return {
      wageredMinor: wagered.toString(),
      maxRatePercent: ratePercent(MAX_RATE),
      current: {
        level: current.level,
        tier: current.tier,
        tierLabel: current.tierLabel,
        sub: current.sub,
        label: current.label,
        ratePercent: ratePercent(current.rakebackBps),
        thresholdMinor: current.thresholdMinor.toString(),
      },
      next: next
        ? {
            level: next.level,
            tier: next.tier,
            tierLabel: next.tierLabel,
            sub: next.sub,
            label: next.label,
            ratePercent: ratePercent(next.rakebackBps),
            thresholdMinor: next.thresholdMinor.toString(),
          }
        : null,
      progress: {
        ratio,
        remainingMinor: remainingMinor.toString(),
        // The gain the next level actually buys, so the client never subtracts two rates itself.
        rateGainPercent: next ? ratePercent(next.rakebackBps - current.rakebackBps) : 0,
      },
      rakeback: {
        accruedMinor: accrued.toString(),
        claimedMinor: claimed.toString(),
        claimableMinor: (accrued - claimed).toString(),
      },
      levels: LADDER.map((level) => ({
        level: level.level,
        tier: level.tier,
        tierLabel: level.tierLabel,
        sub: level.sub,
        label: level.label,
        thresholdMinor: level.thresholdMinor.toString(),
        ratePercent: ratePercent(level.rakebackBps),
        // Three states, decided server-side so the client never re-derives them from thresholds.
        state:
          level.level < current.level
            ? 'complete'
            : level.level === current.level
              ? 'active'
              : 'locked',
      })),
    };
  });
}
