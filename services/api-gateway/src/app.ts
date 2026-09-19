import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import type { AppConfig } from './config.js';
import { applyBotResponseSignature } from './lib/bot-auth.js';
import { Database } from './lib/db.js';
import { sessionCookieName } from './lib/auth.js';
import { assertRuntimeDatabaseRole } from './lib/database-role.js';
import { AppError } from './lib/errors.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerBattleRoutes } from './routes/battles.js';
import { registerCommunityRoutes } from './routes/community.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerPayLoginRoutes } from './routes/auth-pay.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerCashDepositRoutes } from './routes/cash-deposits.js';
import { registerCashWithdrawalRoutes } from './routes/cash-withdrawals.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerDevRoutes } from './routes/dev.js';
import { registerDiscordControlRoutes } from './routes/discord-control.js';
import { registerEngagementRoutes } from './routes/engagement.js';
import { registerCaseRoutes } from './routes/cases.js';
import { registerDuelRoutes } from './routes/duels.js';
import { registerEconomyRoutes } from './routes/economy.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMinecraftInternalRoutes } from './routes/minecraft-in.js';
import { registerInsightRoutes } from './routes/insights.js';
import { registerReferralRoutes } from './routes/referrals.js';
import { registerSlitherRoutes } from './routes/slither.js';
import { registerSideBetRoutes } from './routes/sidebets.js';
import { registerSocialRoutes } from './routes/social.js';
import { registerRewardRoutes } from './routes/rewards.js';
import { registerVipRoutes } from './routes/vip.js';
import { assertVipSolvency } from './lib/vip.js';
import { registerTransferRoutes } from './routes/transfers.js';
import { registerUpgradeRoutes } from './routes/upgrades.js';
import { registerVaultRoutes } from './routes/vault.js';

export async function buildApp(config: AppConfig, suppliedDatabase?: Database) {
  /* Before anything is served. The VIP ceiling, the four tier rakebacks and the referral share are
   * all drawn from the same house margin, and nothing else adds them up — each is individually
   * sane and the combination is what can be insolvent. Refusing to boot is the only version of
   * this check that cannot be ignored. */
  assertVipSolvency(config);

  const app = Fastify({
    // Only the dedicated edge subnet may supply forwarding headers. A boolean `true`
    // here would let direct clients spoof their IP and bypass rate limits.
    trustProxy: [...config.trustedProxyCidrs],
    bodyLimit: 64 * 1024,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
    keepAliveTimeout: 72_000,
    maxRequestsPerSocket: 1000,
    genReqId: () => randomUUID(),
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers.x-csrf-token',
          'req.headers.x-bot-signature',
          'req.body.adminTotpCode',
          'req.body.leaseToken',
          'res.headers.set-cookie',
          'res.headers.x-api-signature',
          '*.adminTotpCode',
          '*.leaseToken',
          '*.server_seed_ciphertext',
          '*.delivery_code_ciphertext',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  const db = suppliedDatabase ?? new Database(config);
  if (!suppliedDatabase) await assertRuntimeDatabaseRole(db);
  const redis = config.redisUrl
    ? new Redis(config.redisUrl, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      })
    : undefined;

  await app.register(cookie, { secret: config.cookieSecret, hook: 'onRequest' });
  await app.register(cors, {
    origin: config.appOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'idempotency-key',
      'x-csrf-token',
      'x-bot-timestamp',
      'x-bot-id',
      'x-bot-signature',
    ],
    maxAge: 600,
  });
  await app.register(helmet, {
    /* This service returns JSON and nothing else, so the policy forbids everything. If a response
     * is ever rendered as a document — by a browser sniffing an error page, or by a future
     * endpoint that serves HTML by mistake — there is nothing it is permitted to load or execute.
     * The frontend ships its own, separate policy; this one is not it. */
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
        'frame-ancestors': ["'none'"],
        sandbox: [],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: config.secureCookies
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
  });
  /* WebSockets, for Case Battles.
   *
   * Registered with a small frame cap: this socket carries watch/unwatch and a ping, nothing
   * larger, and every action that moves money is a CSRF-guarded REST call. A generous frame
   * limit on a socket that never needs one is free memory pressure for anyone who asks. */
  await app.register(websocket, {
    options: { maxPayload: 8 * 1024, clientTracking: false },
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    redis,
    /* Layered: per authenticated user first, per IP otherwise.
     *
     * Keying on IP alone is wrong in both directions. Behind a carrier NAT or a university proxy
     * thousands of players share one address, so one abuser throttles everybody around them; and
     * a single account rotating through addresses is never limited at all. The session cookie is
     * the stable identity, so it is the key whenever there is one.
     *
     * The cookie is read raw rather than through the auth guard because rate limiting runs before
     * authentication — the point is to bound the work an attacker can make the server do, and a
     * limiter that must first verify a session has already done the expensive part. It is only an
     * identity hint, never an authorisation decision.
     */
    keyGenerator(request) {
      const raw = request.cookies?.[sessionCookieName(config)];
      /* The SIGNATURE is checked before the value is trusted as a bucket key.
       *
       * Reading the cookie raw made this trivially bypassable: any attacker-chosen string is a
       * distinct key, so sending a fresh random session cookie on every request bought a fresh
       * budget every time and defeated every limit on the API — including the deliberately tight
       * ones on login and on the admin link redemption.
       *
       * Unsigning is an HMAC and no database round trip, which keeps the property that mattered
       * about reading it raw: this still runs before authentication and never becomes the
       * expensive work it exists to bound. It is an identity hint, never an authorisation
       * decision — but a hint an attacker can mint at will is not a limit. */
      if (typeof raw === 'string' && raw.length > 0) {
        const unsigned = request.unsignCookie(raw);
        if (unsigned.valid && unsigned.value) {
          // Hashed so a session token never lands in a Redis key or a rate-limit log line.
          return 'u:' + createHash('sha256').update(unsigned.value).digest('hex').slice(0, 32);
        }
      }
      /* No cookie, or one this server did not sign. Both fall to the address, which an attacker
       * cannot rotate for free. */
      return 'ip:' + request.ip;
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  app.addHook('onSend', async (request, reply) => {
    /* no-store is the right default for every JSON answer this API gives: they are all about one
     * account at one moment, and a cached one is a wrong one. The avatar route is the single
     * exception — an image keyed on a stable id, which sets its own long cache-control and would
     * otherwise be re-fetched on every chat poll. It opts out by name rather than by sniffing the
     * header the handler set, so the exemption is a list a reader can check. */
    if (request.routeOptions.url !== '/v1/avatars/:id') {
      reply.header('cache-control', 'no-store');
    }
    reply.header('content-language', 'en');
    reply.header('x-content-type-options', 'nosniff');
  });

  await registerHealthRoutes(app, db, redis);
  await registerAuthRoutes(app, db, config);
  await registerPayLoginRoutes(app, db, config);
  await registerAccountRoutes(app, db, config);
  await registerAvatarRoutes(app, db);
  await registerActivityRoutes(app, db, config);
  await registerCaseRoutes(app, db, config);
  await registerCatalogRoutes(app, db, config);
  await registerCashDepositRoutes(app, db, config);
  await registerCashWithdrawalRoutes(app, db, config);
  await registerChatRoutes(app, db, config);
  await registerBattleRoutes(app, db, config);
  await registerDuelRoutes(app, db, config);
  await registerSlitherRoutes(app, db, config);
  await registerSocialRoutes(app, db, config);
  await registerSideBetRoutes(app, db, config);
  await registerCommunityRoutes(app, db, config);
  await registerEconomyRoutes(app, db, config);
  await registerTransferRoutes(app, db, config);
  await registerUpgradeRoutes(app, db, config);
  await registerVaultRoutes(app, db, config);
  await registerEngagementRoutes(app, db, config);
  await registerReferralRoutes(app, db, config);
  await registerRewardRoutes(app, db, config);
  await registerInsightRoutes(app, db, config);
  await registerVipRoutes(app, db, config);
  // Registers nothing unless DEV_LOGIN_ENABLED is on, and config refuses to boot with it on
  // in production. See routes/dev.ts for the full fencing.
  await registerDevRoutes(app, db, config);
  await registerAdminRoutes(app, db, config);
  /* Registers nothing at all unless DISCORD_CONTROL_ENABLED is on — see the note in the module.
   * Sits next to the admin routes because that is what it is: a second, narrower door into the
   * same privileges, and the two belong where a reader finds them together. */
  await registerDiscordControlRoutes(app, db, config);
  await registerMinecraftInternalRoutes(app, db, config);

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );
  app.setErrorHandler(async (error, request, reply) => {
    // A caller that already proved its bot signature receives authenticated failures as well as
    // authenticated successes. The bot drives its retry, quarantine, and job-failure handling
    // from these responses, so leaving them unsigned would leave exactly one forgeable channel.
    const send = (statusCode: number, body: unknown) => {
      const bot = request.authenticatedBot;
      if (bot) applyBotResponseSignature(reply, bot, request.body, body, statusCode);
      return reply.code(statusCode).send(body);
    };
    // An absent `details` is omitted rather than set to undefined. JSON.stringify drops an
    // undefined value but canonicalJson counts the key, so keeping it would make the signature
    // cover a structure the bot never receives, and every signed failure would fail to verify.
    const errorBody = (code: string, message: string, details?: unknown) => ({
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        requestId: request.id,
      },
    });
    if (error instanceof AppError) {
      if (error.internalDetails !== undefined) {
        request.log.warn(
          { code: error.code, internalDetails: error.internalDetails },
          'Request rejected before handling',
        );
      }
      return send(error.statusCode, errorBody(error.code, error.message, error.details));
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    ) {
      return send(
        error.statusCode,
        errorBody('REQUEST_ERROR', error instanceof Error ? error.message : 'Invalid request'),
      );
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return send(500, errorBody('INTERNAL_ERROR', 'An internal error occurred'));
  });

  app.addHook('onClose', async () => {
    await db.close();
    if (redis) await redis.quit();
  });
  return app;
}
