import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';

/**
 * The account route.
 *
 * ── WHAT USED TO BE HERE ──
 *
 * A compliance profile (country, date of birth, terms, and a KYC status that moved an account into
 * `pending_compliance` whenever either of the first two changed), a self-set cooldown, and a
 * self-exclusion window of up to ten years.
 *
 * All of it existed because the platform was written to be able to run as a real-money casino,
 * where every one of those is a licensing condition. It settles in DonutSMP dollars. `PATCH
 * /v1/account`, `PUT /v1/account/limits` and `POST /v1/account/self-exclusion` are gone with the
 * columns behind them, and the date of birth this endpoint used to collect is dropped rather than
 * retained — a Minecraft minigame site holding birth dates is a liability with no matching use.
 *
 * What is left is a read. An account's own record of who it is and whether it is active, which is
 * the part a player actually opens this page for.
 *
 * Suspension is untouched. An operator stopping an account was never a compliance control; it is
 * moderation, it lives on `status`, and it is applied from the admin console rather than here.
 */
export async function registerAccountRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get('/v1/account', { preHandler: guards.authenticate }, async (request) => {
    const result = await db.query(
      `SELECT id, minecraft_identity, minecraft_username, role, status, terms_accepted_at,
              created_at, last_login_at
         FROM users WHERE id = $1`,
      [request.authUser?.id],
    );
    return { account: result.rows[0] };
  });
}
