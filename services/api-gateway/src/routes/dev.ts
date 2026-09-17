import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  csrfCookieName,
  sessionCookieName,
  sessionCookieOptions,
} from '../lib/auth.js';
import { hmacHex, randomToken, safeEqualText, sha256 } from '../lib/crypto.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { parseWith } from '../lib/validation.js';

/**
 * The developer login.
 *
 * Normal login proves control of a DonutSMP account by having the player pay a custody bot an
 * exact amount. That is the right gate for production and the wrong one for working on the site:
 * it needs a bot online, a real server, and real money moving, none of which exist on a laptop.
 *
 * This mints a real session for a disposable account so everything downstream is genuinely
 * exercised — real server rolls, real ledger writes, real vault accrual. It is not a mock.
 *
 * WHICH IS EXACTLY WHY IT IS FENCED:
 *
 *   1. config refuses to start if this is enabled with NODE_ENV=production
 *   2. this module is never registered unless DEV_LOGIN_ENABLED is on
 *   3. the request must carry DEV_LOGIN_TOKEN, so an exposed port is not an open door
 *   4. the account it creates is fixed, marked, and can never hold the admin role
 *
 * Any one of those failing is a full authentication bypass, so none of them is optional.
 */

const DEV_IDENTITY = 'dev:local-test-account';
const DEV_USERNAME = 'DevTester';
const DEV_BOT_USERNAME = 'DevCustodyBot';

const devLoginSchema = z
  .object({
    token: z.string().min(24).max(256),
    /** Top the wallet up to this figure. Omitted means the configured default. */
    balanceMinor: z
      .string()
      .regex(/^(0|[1-9]\d{0,18})$/)
      .optional(),
    /**
     * An alternate dev identity.
     *
     * Without this the developer login always returns ONE account, which makes anything
     * multiplayer untestable: a case battle needs two real sessions with two real wallets, and
     * one account cannot sit in two seats — the schema forbids it, correctly.
     *
     * The suffix is confined to [a-z0-9_] and capped, and it is appended to the fixed dev
     * identity rather than replacing it, so every account this can reach is still unmistakably a
     * development account. The route is already fenced four ways (NODE_ENV, the feature flag, the
     * token, and the bind address); this widens what the fence encloses, not the fence.
     */
    identitySuffix: z
      .string()
      .regex(/^[a-z0-9_]{1,24}$/)
      .optional(),
  })
  .strict();

interface UserRow {
  id: string;
  minecraft_identity: string;
  minecraft_username: string;
  role: string;
  status: string;
}

export async function registerDevRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  if (!config.devLoginEnabled) return;

  const provisionedBotIds = [...config.botCredentials.keys()];
  /* assertGameEligible rejects any country outside ALLOWED_COUNTRIES, so the test account has to
   * claim one the deployment actually serves rather than a hardcoded favourite. */
  const devCountry = ([...config.allowedCountries][0] ?? 'gb').toLowerCase();

  app.log.warn(
    'DEVELOPER LOGIN IS ENABLED. /v1/dev/login will mint sessions without identity proof. ' +
      'This must never be reachable from the public internet.',
  );

  app.post(
    '/v1/dev/login',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseWith(devLoginSchema, request.body);

      // Constant-time, so the token cannot be recovered a character at a time from timing.
      if (!config.devLoginToken || !safeEqualText(body.token, config.devLoginToken)) {
        throw new AppError(403, 'DEV_LOGIN_FORBIDDEN', 'Developer login token is invalid');
      }

      const sessionToken = randomToken();
      const csrfToken = randomToken();
      const sessionId = randomUUID();
      const targetBalance = body.balanceMinor
        ? BigInt(body.balanceMinor)
        : config.devLoginBalanceMinor;

      const result = await db.transaction(async (client) => {
        /* The compliance gates are real and assertGameEligible rechecks every one of them on
         * every wager. A test account that fails them cannot open a case or pull the upgrader,
         * so the account is created already satisfying them. This is the bypass being honest
         * about its blast radius: it fabricates a verified player. */
        const upserted = await client.query<UserRow>(
          `INSERT INTO users
             (id, minecraft_identity, minecraft_username, normalized_username, role, status,
              country_code, date_of_birth, terms_accepted_at, age_verified_at, kyc_status,
              last_login_at)
           VALUES ($1, $2, $3::varchar, lower($3::varchar), 'player', 'active',
                   $4::char(2), date '1990-01-01', now(), now(), 'verified', now())
           ON CONFLICT (minecraft_identity) DO UPDATE
             SET status = 'active',
                 terms_accepted_at = COALESCE(users.terms_accepted_at, now()),
                 age_verified_at = COALESCE(users.age_verified_at, now()),
                 kyc_status = 'verified',
                 country_code = $4::char(2),
                 last_login_at = now(),
                 updated_at = now()
           RETURNING id, minecraft_identity, minecraft_username, role, status`,
          [
            randomUUID(),
            body.identitySuffix ? `${DEV_IDENTITY}_${body.identitySuffix}` : DEV_IDENTITY,
            body.identitySuffix ? `${DEV_USERNAME}_${body.identitySuffix}` : DEV_USERNAME,
            devCountry,
          ],
        );
        const user = upserted.rows[0];
        if (!user) throw new Error('Developer user upsert returned no row');

        /* The dev account is a player, always. Promoting it would turn a development
         * convenience into an administrative one, and the admin routes guard real money. */
        if (user.role !== 'player') {
          await client.query("UPDATE users SET role = 'player' WHERE id = $1", [user.id]);
          user.role = 'player';
        }

        await client.query(
          'INSERT INTO responsible_limits(user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [user.id],
        );

        // One live session at a time keeps the test account from accumulating stale sessions
        // every time the button is pressed.
        await client.query(
          'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [user.id],
        );
        await client.query(
          `INSERT INTO sessions
             (id, user_id, token_hash, csrf_hash, ip_hash, user_agent, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 hour'))`,
          [
            sessionId,
            user.id,
            sha256(sessionToken),
            sha256(csrfToken),
            Buffer.from(hmacHex(config.ipHashKey, request.ip), 'hex'),
            request.headers['user-agent']?.slice(0, 512) ?? null,
            config.sessionTtlHours,
          ],
        );

        /* Top up TO the target rather than adding it, so holding the button does not mint an
         * unbounded balance and the account starts each session from a known figure. */
        await client.query(
          `INSERT INTO user_wallets(user_id, balance_minor) VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id],
        );
        const wallet = await client.query<{ balance_minor: string }>(
          'SELECT balance_minor FROM user_wallets WHERE user_id = $1 FOR UPDATE',
          [user.id],
        );
        const current = BigInt(wallet.rows[0]?.balance_minor ?? '0');
        let balanceAfter = current;
        if (current < targetBalance) {
          const topUp = targetBalance - current;
          const credited = await client.query<{ balance_minor: string }>(
            `UPDATE user_wallets SET balance_minor = balance_minor + $2, updated_at = now()
              WHERE user_id = $1 RETURNING balance_minor`,
            [user.id, topUp.toString()],
          );
          balanceAfter = BigInt(credited.rows[0]?.balance_minor ?? '0');
          // Test money is still money as far as the ledger is concerned, and it reconciles as an
          // admin adjustment rather than appearing from nowhere.
          await client.query(
            `INSERT INTO wallet_transactions
               (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
             VALUES ($1, $2, $3, $4, 'admin_adjustment', $5)`,
            [randomUUID(), user.id, topUp.toString(), balanceAfter.toString(), sessionId],
          );
        }

        /* The custody bot the games check for.
         *
         * Stock is only playable when its bot passes every one of these: it is one of the ids in
         * BOT_CREDENTIALS_JSON, online, reconciled, transfer_capable, and carries heartbeat AND
         * snapshot timestamps inside the last 45 seconds. Miss any one and the catalogue reports
         * zero availability and every wager fails — which looks like a bug and is really a bot
         * that is not there.
         *
         * The id therefore has to be a PROVISIONED one rather than a fresh uuid, and
         * transfer_capable has to be set explicitly because the column defaults to false.
         *
         * The timestamps go stale a minute after they are stamped, so every dev login restamps
         * them. That is what the bench's REFRESH BOT button is for. */
        const provisionedBotId = provisionedBotIds[0];
        if (!provisionedBotId) {
          throw new AppError(
            409,
            'NO_PROVISIONED_BOT',
            'BOT_CREDENTIALS_JSON has no bot, so no stock can be made playable',
          );
        }
        const bot = await client.query<{ id: string }>(
          `INSERT INTO bot_accounts
             (id, username, status, server_host, last_heartbeat_at, last_snapshot_at,
              reconciliation_status, transfer_capable)
           VALUES ($1, $2, 'online', 'localhost', now(), now(), 'matched', true)
           ON CONFLICT (id) DO UPDATE
             SET status = 'online',
                 last_heartbeat_at = now(),
                 last_snapshot_at = now(),
                 reconciliation_status = 'matched',
                 transfer_capable = true,
                 updated_at = now()
           RETURNING id`,
          [provisionedBotId, DEV_BOT_USERNAME],
        );
        const botId = bot.rows[0]?.id;
        if (!botId) throw new Error('Developer bot upsert returned no row');

        /* Give the account one lot of every enabled catalog item it does not already hold, so the
         * vault, the trader and the upgrader all have something real to work on. Nothing is
         * invented: these are catalogue rows an operator created through the admin API, and if
         * the catalogue is empty this seeds nothing and says so. */
        const seeded = await client.query<{ count: string }>(
          `WITH missing AS (
             SELECT c.id FROM catalog_items c
              WHERE c.enabled
                AND NOT EXISTS (
                  SELECT 1 FROM inventory_lots i
                   WHERE i.owner_user_id = $1 AND i.catalog_item_id = c.id
                     AND i.state = 'available'
                )
              LIMIT 25
           ), inserted AS (
             INSERT INTO inventory_lots
               (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
             SELECT gen_random_uuid(), missing.id, $1, $2, 1, 'available', 'admin', $3
               FROM missing
             RETURNING 1
           )
           SELECT count(*)::text AS count FROM inserted`,
          [user.id, botId, sessionId],
        );

        /* House stock for the upgrader to award from. Without it every pull fails
         * TARGET_OUT_OF_STOCK, which looks like a bug and is really an empty warehouse. */
        const stocked = await client.query<{ count: string }>(
          `WITH thin AS (
             SELECT c.id FROM catalog_items c
              WHERE c.enabled
                AND (
                  SELECT COALESCE(sum(i.quantity), 0) FROM inventory_lots i
                   WHERE i.owner_user_id IS NULL AND i.catalog_item_id = c.id
                     AND i.state = 'available'
                ) < 5
              LIMIT 50
           ), inserted AS (
             INSERT INTO inventory_lots
               (id, catalog_item_id, owner_user_id, bot_id, quantity, state, source_type, source_ref)
             SELECT gen_random_uuid(), thin.id, NULL, $1, 25, 'available', 'admin', $2
               FROM thin
             RETURNING 1
           )
           SELECT count(*)::text AS count FROM inserted`,
          [botId, sessionId],
        );

        return {
          user,
          balanceMinor: balanceAfter.toString(),
          lotsSeeded: Number(seeded.rows[0]?.count ?? '0'),
          houseLotsSeeded: Number(stocked.rows[0]?.count ?? '0'),
        };
      });

      reply.setCookie(sessionCookieName(config), sessionToken, sessionCookieOptions(config));
      reply.setCookie(csrfCookieName(config), csrfToken, {
        path: '/',
        httpOnly: false,
        secure: config.secureCookies,
        sameSite: 'strict',
        maxAge: config.sessionTtlHours * 60 * 60,
      });

      return reply.send({
        user: {
          id: result.user.id,
          minecraftIdentity: result.user.minecraft_identity,
          minecraftUsername: result.user.minecraft_username,
          role: result.user.role,
          status: result.user.status,
        },
        csrfToken,
        balanceMinor: result.balanceMinor,
        lotsSeeded: result.lotsSeeded,
        houseLotsSeeded: result.houseLotsSeeded,
        developerLogin: true,
      });
    },
  );
}
