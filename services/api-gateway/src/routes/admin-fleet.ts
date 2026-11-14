import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';

/**
 * The bot fleet's dashboard, as a tab of the admin console.
 *
 * The fleet is a separate service on the same host (its own user, its own containers). It holds the
 * accounts' session tokens and can send commands as them, so it is never reachable from outside:
 * this route is the only door, and it opens only for a signed-in administrator. A write also needs
 * the CSRF token and the site's own origin, exactly like every other admin write.
 *
 * It forwards, it does not interpret. Nothing here touches the ledger, the teller or the vault.
 * Registers nothing at all unless FLEET_URL is set, so a deployment without a fleet is unchanged.
 */

export const FLEET_PREFIX = '/v1/admin/fleet';

const REQUEST_TIMEOUT_MS = 30_000;

/* An allow-list rather than "everything under /api": a path the fleet grows later stays closed
 * until somebody opens it here. */
const GET_PATHS = [/^\/$/, /^\/api\/live$/, /^\/api\/relays$/, /^\/api\/accounts\/[0-9a-f]+\/log$/];
const POST_PATHS = [/^\/api\/[a-z0-9]+(?:[/-][a-z0-9]+){0,4}$/];

export function isAllowedFleetPath(method: string, path: string): boolean {
  if (path.length > 200 || path.includes('..') || path.includes('//')) return false;
  const patterns = method === 'GET' ? GET_PATHS : method === 'POST' ? POST_PATHS : [];
  return patterns.some((pattern) => pattern.test(path));
}

/* Headers that may travel back. No cookies from the fleet, ever. */
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'content-security-policy'];

export async function registerAdminFleetRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
): Promise<void> {
  if (!config.fleetUrl) return;
  const guards = createAuthGuards(db, config);
  const fleet = new URL(config.fleetUrl);
  /* What the fleet calls itself: it only accepts its own loopback address as Host and Origin, whatever
   * name this proxy reaches it under (host.docker.internal from inside the container). */
  const loopback = `127.0.0.1:${fleet.port || '80'}`;

  const requireAdminRead = async (request: FastifyRequest) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };

  app.route({
    method: ['GET', 'POST'],
    url: `${FLEET_PREFIX}/*`,
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    preHandler: async (request) => {
      if (request.method === 'GET') await requireAdminRead(request);
      else await guards.requireAdmin(request);
    },
    handler: async (request, reply) => {
      const rest = `/${(request.params as Record<string, string | undefined>)['*'] ?? ''}`;
      if (!isAllowedFleetPath(request.method, rest)) {
        throw new AppError(404, 'NOT_FOUND', 'Not found');
      }
      const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';

      /* The fleet checks Host and Origin against its own address and refuses anything else, which
       * is its defence against a web page talking to it from a browser. This is not a browser, so
       * it says what the fleet expects. The browser's real origin was already checked above. */
      const headers: Record<string, string> = {
        host: loopback,
        origin: `http://${loopback}`,
        'user-agent': 'donutluxe-admin-fleet-proxy',
      };
      const token = request.headers['x-token'];
      if (typeof token === 'string') headers['x-token'] = token;
      let body: string | undefined;
      if (request.method === 'POST') {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(request.body ?? {});
      }

      const controller = new AbortController();
      const isStream = rest === '/api/live';
      const timer = isStream ? undefined : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      request.raw.on('close', () => controller.abort());

      let upstream: Response;
      try {
        upstream = await fetch(new URL(`${rest}${query}`, fleet), {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch {
        clearTimeout(timer);
        throw new AppError(502, 'FLEET_UNAVAILABLE', 'The fleet service is not reachable');
      }
      clearTimeout(timer);

      reply.status(upstream.status);
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) reply.header(name, value);
      }
      reply.header('x-content-type-options', 'nosniff');
      if (!upstream.body) return reply.send('');
      return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
    },
  });

  /* The tab opens the directory with a trailing slash. Without one, the page's relative links would
   * resolve against /v1/admin instead. */
  app.get(FLEET_PREFIX, { preHandler: requireAdminRead }, async (_request, reply) => {
    return reply.redirect(`${FLEET_PREFIX}/`, 308);
  });
}
