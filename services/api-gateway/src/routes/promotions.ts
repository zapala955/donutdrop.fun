import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { requirementFor } from '../lib/wager-requirements.js';

/**
 * The offers a visitor can be told about before they have an account.
 *
 * Public because the two places that quote them -- the signup screen and the lobby -- are seen
 * first by people who are not signed in yet, and a promise that only appears after signing up is
 * not much of an invitation. Every figure is read from `config` per request, so a change in the
 * admin panel is what the next visitor sees; nothing here is typed twice.
 *
 * Only the house's published terms. Nothing about any player.
 */
export async function registerPromotionRoutes(app: FastifyInstance, config: AppConfig) {
  app.get('/v1/promotions', async () => ({
    signupBonus:
      config.signupBonusMinor > 0n
        ? {
            amountMinor: config.signupBonusMinor.toString(),
            wagerMultiplier: config.signupBonusWagerMultiplier,
            // What must be wagered before the bonus can be withdrawn, precomputed so no client
            // multiplies money in floating point.
            wagerMinor: requirementFor(
              config.signupBonusMinor,
              config.signupBonusWagerMultiplier,
            ).toString(),
          }
        : null,
    referral: config.referralsEnabled
      ? {
          bonusMinor: config.referralBonusMinor.toString(),
          bonusWagerMinor: config.referralBonusWagerMinor.toString(),
        }
      : null,
    depositWagerMultiplier: config.depositWagerMultiplier,
  }));
}
