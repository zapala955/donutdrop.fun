import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Database } from '../lib/db.js';
import { parseWith } from '../lib/validation.js';

/**
 * Player heads, served from this origin and keyed on an id that says nothing about the player.
 *
 * ── WHY THIS EXISTS ──
 *
 * Chat renders a head beside every line. It used to do that by pointing an <img> straight at
 * `https://mc-heads.net/avatar/<username>/22`, which put the player's real Minecraft name in a URL
 * on a page that is otherwise careful to mask it. Right-clicking the head and opening it in a new
 * tab read the name straight out of the address bar, and devtools showed it without even that
 * much. The masking beside it was doing nothing.
 *
 * It also told a third party who was in the chat. Every head rendered was a request from the
 * player's own browser to mc-heads.net carrying another player's identity, on every poll.
 *
 * So the browser now asks THIS server, by internal user id. The id is a uuid that means nothing
 * outside this database: it does not resolve to a name at Mojang, it is not a credential, and it
 * is already in the chat payload as `authorId`. This server does the name resolution privately and
 * fetches upstream by account UUID, so mc-heads.net sees a request from one server for one UUID
 * and learns nothing about who asked or what they are called.
 *
 * ── WHAT THIS IS NOT ──
 *
 * It is not anonymity for chat. The raw `author` is still in the chat payload, deliberately, and
 * anyone reading the API sees every name. This closes the URL, which is the part that was leaking
 * the name to people who were not looking for it.
 */

/* The two sizes chat actually renders, as an allowlist rather than a range. An open size parameter
 * is an unbounded set of cache keys and an unbounded set of upstream fetches, for no benefit to a
 * caller that only ever asks for these two. */
const SIZES = new Set([22, 40]);
const DEFAULT_SIZE = 22;

const UPSTREAM = 'https://mc-heads.net/avatar/';
const UPSTREAM_TIMEOUT_MS = 4_000;
const MAX_IMAGE_BYTES = 128 * 1024;

/* A day for a head that resolved. Skins change rarely and a stale one is a cosmetic non-event. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/* Five minutes for one that did not. A Bedrock player has no Mojang head and never will, and
 * mc-heads being down should cost one upstream attempt per five minutes, not one per render. */
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/* Bounded so a flood of ids cannot grow this without limit. Chat shows a few dozen distinct
 * players; this holds far more than that and evicts oldest-first when it does not. */
const MAX_ENTRIES = 512;

interface CacheEntry {
  readonly expiresAt: number;
  /** Null means "upstream had no head for this one" — cached so the miss is not re-fetched. */
  readonly body: Buffer | null;
  readonly contentType: string;
}

const paramsSchema = z.object({ id: z.uuid() }).strict();
const querySchema = z
  .object({ s: z.coerce.number().int().optional() })
  .strict();

export async function registerAvatarRoutes(app: FastifyInstance, db: Database) {
  const cache = new Map<string, CacheEntry>();

  function remember(key: string, entry: CacheEntry): void {
    /* Insertion-ordered, so the first key is the oldest. Deleting before setting keeps a refreshed
     * entry at the young end rather than leaving it where it first landed. */
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  app.get(
    '/v1/avatars/:id',
    {
      /* Public, because chat is. Limited generously: a page of chat renders a few dozen of these
       * at once and they are cached hard afterwards, so the ceiling is for abuse, not for use. */
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const params = parseWith(paramsSchema, request.params);
      const query = parseWith(querySchema, request.query ?? {});
      const size = query.s !== undefined && SIZES.has(query.s) ? query.s : DEFAULT_SIZE;
      const key = `${params.id}:${size}`;

      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.body === null ? notFound(reply) : send(reply, cached.body, cached.contentType);
      }

      /* The one place the name is resolved, and it never leaves this function. */
      const user = await db.query<{ minecraft_identity: string }>(
        'SELECT minecraft_identity FROM users WHERE id = $1',
        [params.id],
      );
      const identity = user.rows[0]?.minecraft_identity ?? '';
      /* Java accounts only. A Bedrock identity is `bedrock:<name>` — there is no Mojang UUID to ask
       * for, and putting the name in an upstream URL is the exact thing this route exists to stop.
       * They get the initials treatment, which is what the client already falls back to. */
      const uuid = /^mc:([a-f0-9]{32})$/.exec(identity)?.[1];
      if (!uuid) {
        remember(key, { expiresAt: Date.now() + NEGATIVE_TTL_MS, body: null, contentType: '' });
        return notFound(reply);
      }

      let upstream: Response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
      try {
        upstream = await fetch(`${UPSTREAM}${uuid}/${size}`, {
          method: 'GET',
          headers: { accept: 'image/png,image/*' },
          signal: controller.signal,
        });
      } catch {
        /* Not cached as a miss: a timeout is about the network right now, not about this player,
         * and burning five minutes of negative cache on a blip would blank the chat for everyone
         * who loaded during it. The client falls back to initials for this render. */
        return notFound(reply);
      } finally {
        clearTimeout(timeout);
      }

      const contentType = upstream.headers.get('content-type') ?? '';
      if (!upstream.ok || !contentType.startsWith('image/')) {
        remember(key, { expiresAt: Date.now() + NEGATIVE_TTL_MS, body: null, contentType: '' });
        return notFound(reply);
      }

      const raw = Buffer.from(await upstream.arrayBuffer());
      /* A head is a couple of kilobytes. Anything of this size is not one, and proxying it would
       * make this endpoint a bandwidth amplifier for whatever upstream decided to return. */
      if (raw.byteLength > MAX_IMAGE_BYTES) {
        remember(key, { expiresAt: Date.now() + NEGATIVE_TTL_MS, body: null, contentType: '' });
        return notFound(reply);
      }

      remember(key, { expiresAt: Date.now() + CACHE_TTL_MS, body: raw, contentType });
      return send(reply, raw, contentType);
    },
  );
}

/* `cache-control` is set here AND the global onSend hook is told to leave this route alone. The
 * hook's no-store default is right for every JSON answer on this API; an image keyed on a stable
 * id is the one thing on it worth caching, and without the exemption every head would be re-fetched
 * on every poll. */
function send(reply: FastifyReply, body: Buffer, contentType: string) {
  return reply
    .header('cache-control', 'public, max-age=86400, immutable')
    .type(contentType)
    .send(body);
}

function notFound(reply: FastifyReply) {
  /* 404 rather than a placeholder image, so the client's existing `onerror` runs and draws the
   * initials tile it already has. A served placeholder would be this server deciding what the
   * fallback looks like, which is the renderer's job.
   *
   * Cached as briefly as a miss is worth: the client will not re-request a 404 image within a
   * render, and a Bedrock player's miss is already held in the map above. */
  return reply
    .header('cache-control', 'public, max-age=300')
    .code(404)
    .send({ error: { code: 'AVATAR_NOT_FOUND', message: 'No avatar' } });
}
