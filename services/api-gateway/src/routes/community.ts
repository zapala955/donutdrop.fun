import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import {
  DEFAULT_ROYALTY_BPS,
  MARKETPLACE_SORTS,
  MAX_COMMUNITY_DROPS,
  MAX_DROP_WEIGHT,
  MAX_ROYALTY_BPS,
  MIN_COMMUNITY_DROPS,
  MIN_DROP_WEIGHT,
  MIN_ROYALTY_BPS,
  communitySlug,
  computeCrateEconomics,
  isMarketplaceSort,
  type DraftDrop,
} from '../lib/community-cases.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { safePublicText } from '../lib/sanitize.js';
import { parseWith } from '../lib/validation.js';

/**
 * Community Cases: the creator studio and the marketplace.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PRICE IS NEVER SENT BY THE CLIENT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The studio shows a live price as the weights move, and that number is a PREVIEW. The request
 * that creates a crate carries contents and weights only; the server recomputes the expected
 * value from its own item prices and derives `price = ceil(EV / 0.90)` itself.
 *
 * This is the whole security model of the feature. If the price travelled in the body, the
 * exploit writes itself — publish a crate stuffed with netherite, declare it costs a thousand,
 * open it yourself until the platform is empty. Deriving the price server-side removes the attack
 * rather than validating against it, and the same code path produces the studio's preview, so the
 * two cannot disagree.
 *
 * Item VALUES are read fresh from catalog_items at creation time and never taken from the client
 * either, for the same reason.
 */

const MAX_CRATES_PER_CREATOR = 20;

const dropSchema = z
  .object({
    catalogItemId: z.uuid(),
    weight: z.coerce.number().int().min(MIN_DROP_WEIGHT).max(MAX_DROP_WEIGHT),
  })
  .strict();

/* The name and the blurb are rendered inside other players' pages, so they go through
 * safePublicText: control characters, bidi overrides, zero-width characters, HTML tags and
 * script-bearing URL schemes are all refused at the door rather than escaped downstream. */
const createSchema = z
  .object({
    name: safePublicText(3, 48),
    description: safePublicText(0, 160).optional().default(''),
    decal: z.string().regex(/^(?:items|block)\/[A-Za-z0-9_-]+\.(?:png|gif|jpe?g|webp)$/),
    royaltyBps: z.coerce.number().int().min(MIN_ROYALTY_BPS).max(MAX_ROYALTY_BPS)
      .default(DEFAULT_ROYALTY_BPS),
    drops: z.array(dropSchema).min(MIN_COMMUNITY_DROPS).max(MAX_COMMUNITY_DROPS),
    publish: z.boolean().default(true),
  })
  .strict();

/** The studio's live preview. Same maths, no writes, no session cost. */
const previewSchema = z
  .object({
    royaltyBps: z.coerce.number().int().min(MIN_ROYALTY_BPS).max(MAX_ROYALTY_BPS)
      .default(DEFAULT_ROYALTY_BPS),
    drops: z.array(dropSchema).min(1).max(MAX_COMMUNITY_DROPS),
  })
  .strict();

const listQuery = z
  .object({
    sort: z.string().default('opened'),
    limit: z.coerce.number().int().min(1).max(60).default(24),
    search: z.string().max(48).optional(),
  })
  .strict();

const slugParam = z.object({ slug: z.string().min(1).max(80) }).strict();

interface ItemRow {
  id: string;
  minecraft_name: string;
  display_name: string;
  image_url: string | null;
  unit_value_minor: string;
  metadata: Record<string, unknown> | null;
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

export async function registerCommunityRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  /** Reads the requested items and refuses the request if any is missing or disabled. */
  async function loadItems(ids: readonly string[]): Promise<Map<string, ItemRow>> {
    const unique = [...new Set(ids)];
    const result = await db.query<ItemRow>(
      `SELECT id, minecraft_name, display_name, image_url, unit_value_minor, metadata
         FROM catalog_items
        WHERE id = ANY($1::uuid[]) AND enabled`,
      [unique],
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    for (const id of unique) {
      if (!byId.has(id)) throw new AppError(400, 'ITEM_UNAVAILABLE', 'An item is not available');
    }
    return byId;
  }

  /**
   * The palette a creator may build from.
   *
   * God-tier mystery payloads are excluded. They exist to sit behind the platform's own `?` slot
   * at odds the engine controls; letting a creator put a $1B vault in a crate would let them
   * mint one at whatever price EV/0.9 happened to work out to, and the mystery slot's scarcity —
   * which is the entire reason it means anything — would be theirs to sell.
   */
  app.get('/v1/community/palette', async () => {
    const result = await db.query<ItemRow>(
      `SELECT id, minecraft_name, display_name, image_url, unit_value_minor, metadata
         FROM catalog_items
        WHERE enabled
          AND COALESCE((metadata ->> 'mystery')::boolean, false) = false
        ORDER BY unit_value_minor`,
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        minecraftName: row.minecraft_name,
        displayName: row.display_name,
        imageUrl: row.image_url,
        unitValueMinor: row.unit_value_minor,
        metadata: row.metadata ?? {},
      })),
      limits: {
        minDrops: MIN_COMMUNITY_DROPS,
        maxDrops: MAX_COMMUNITY_DROPS,
        minWeight: MIN_DROP_WEIGHT,
        maxWeight: MAX_DROP_WEIGHT,
        minRoyaltyBps: MIN_ROYALTY_BPS,
        maxRoyaltyBps: MAX_ROYALTY_BPS,
        defaultRoyaltyBps: DEFAULT_ROYALTY_BPS,
      },
    };
  });

  /**
   * The live preview the studio renders while a slider moves.
   *
   * Deliberately the same function the create path calls. A preview computed by different code
   * from the real thing is a preview that will eventually lie, and the number it lies about here
   * is the price.
   */
  app.post(
    '/v1/community/preview',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const body = parseWith(previewSchema, request.body);
      const items = await loadItems(body.drops.map((drop) => drop.catalogItemId));

      const drops: DraftDrop[] = body.drops.map((drop) => ({
        catalogItemId: drop.catalogItemId,
        valueMinor: BigInt(items.get(drop.catalogItemId)?.unit_value_minor ?? '0'),
        weight: drop.weight,
      }));

      /* An incomplete draft is the normal state of the studio, not an error: a creator with two
       * items in the builder should see a price forming, not a validation failure. The bounds are
       * enforced on CREATE, where they matter. */
      try {
        const economics = computeCrateEconomics(
          drops.length < MIN_COMMUNITY_DROPS
            ? [...drops, ...Array.from(
              { length: MIN_COMMUNITY_DROPS - drops.length },
              () => drops[0] as DraftDrop,
            )]
            : drops,
          body.royaltyBps,
        );
        return {
          ok: true,
          complete: drops.length >= MIN_COMMUNITY_DROPS,
          expectedValueMinor: economics.expectedValueMinor.toString(),
          priceMinor: economics.priceMinor.toString(),
          rtpBps: economics.rtpBps,
          houseEdgeBps: economics.houseEdgeBps,
          royaltyPerOpenMinor: economics.royaltyPerOpenMinor.toString(),
          platformNetPerOpenMinor: economics.platformNetPerOpenMinor.toString(),
          totalWeight: economics.totalWeight.toString(),
          chancesPpm: economics.chancesPpm,
          riskPercent: economics.riskPercent,
          riskLabel: economics.riskLabel,
          topMultiple: economics.topMultiple,
        };
      } catch (error) {
        return { ok: false, complete: false, reason: (error as Error).message };
      }
    },
  );

  app.post(
    '/v1/community/cases',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseWith(createSchema, request.body);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to publish a crate');

      const seen = new Set(body.drops.map((drop) => drop.catalogItemId));
      if (seen.size !== body.drops.length) {
        throw new AppError(400, 'DUPLICATE_ITEM', 'Each item may appear once; use its weight');
      }

      const items = await loadItems(body.drops.map((drop) => drop.catalogItemId));
      const drops: DraftDrop[] = body.drops.map((drop) => ({
        catalogItemId: drop.catalogItemId,
        // The VALUE comes from the database, never from the request.
        valueMinor: BigInt(items.get(drop.catalogItemId)?.unit_value_minor ?? '0'),
        weight: drop.weight,
      }));

      let economics;
      try {
        economics = computeCrateEconomics(drops, body.royaltyBps);
      } catch (error) {
        throw new AppError(400, 'INVALID_CRATE', (error as Error).message);
      }

      const created = await db.transaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

        const owned = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM cases
            WHERE creator_user_id = $1 AND community_status <> 'retired'`,
          [userId],
        );
        if (Number(owned.rows[0]?.count ?? 0) >= MAX_CRATES_PER_CREATOR) {
          throw new AppError(
            429, 'TOO_MANY_CRATES',
            `A creator may keep ${MAX_CRATES_PER_CREATOR} live crates`,
          );
        }

        const caseId = randomUUID();
        const slug = communitySlug(body.name, randomBytes(3).toString('hex'));

        await client.query(
          `INSERT INTO cases
             (id, slug, name, description, image_url, price_minor, enabled, metadata,
              creator_user_id, royalty_bps, community_status)
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7::jsonb, $8, $9, $10)`,
          [
            caseId, slug, body.name, body.description,
            economics.priceMinor.toString(),
            body.publish,
            JSON.stringify({
              community: true,
              frontendAsset: body.decal,
              risk: 'community',
              riskPercent: economics.riskPercent,
              riskLabel: economics.riskLabel,
              edgeBps: economics.houseEdgeBps,
              expectedValueMinor: economics.expectedValueMinor.toString(),
              topMultiple: economics.topMultiple,
              royaltyBps: body.royaltyBps,
            }),
            userId, body.royaltyBps, body.publish ? 'published' : 'draft',
          ],
        );

        for (const drop of body.drops) {
          await client.query(
            `INSERT INTO case_items (case_id, catalog_item_id, weight, quantity, enabled)
             VALUES ($1, $2, $3, 1, true)`,
            [caseId, drop.catalogItemId, drop.weight],
          );
        }
        return { caseId, slug };
      });

      return reply.code(201).send({
        crate: {
          id: created.caseId,
          slug: created.slug,
          name: body.name,
          priceMinor: economics.priceMinor.toString(),
          expectedValueMinor: economics.expectedValueMinor.toString(),
          rtpBps: economics.rtpBps,
          houseEdgeBps: economics.houseEdgeBps,
          royaltyBps: body.royaltyBps,
          royaltyPerOpenMinor: economics.royaltyPerOpenMinor.toString(),
          riskPercent: economics.riskPercent,
          riskLabel: economics.riskLabel,
          published: body.publish,
        },
      });
    },
  );

  app.get('/v1/community/cases', async (request) => {
    const query = parseWith(listQuery, request.query);
    const sort = isMarketplaceSort(query.sort) ? query.sort : 'opened';
    /* The ORDER BY is chosen from a fixed map and interpolated as a known-safe literal. The map's
     * values are compile-time constants in this repository, never user input — the alternative,
     * building an ORDER BY from a request string, is the textbook injection this codebase bans. */
    const orderBy = MARKETPLACE_SORTS[sort];

    const result = await db.query<{
      id: string; slug: string; name: string; description: string; price_minor: string;
      metadata: Record<string, unknown> | null; royalty_bps: number; opens_count: string;
      volume_minor: string; royalties_paid_minor: string; created_at: Date;
      creator: string; creator_role: string; drop_count: string;
    }>(
      `SELECT c.id, c.slug, c.name, c.description, c.price_minor, c.metadata, c.royalty_bps,
              c.opens_count, c.volume_minor, c.royalties_paid_minor, c.created_at,
              u.minecraft_username AS creator, u.role AS creator_role,
              (SELECT count(*) FROM case_items k WHERE k.case_id = c.id AND k.enabled) AS drop_count
         FROM cases c JOIN users u ON u.id = c.creator_user_id
        WHERE c.community_status = 'published' AND c.enabled
          AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%')
        ORDER BY ${orderBy}
        LIMIT $1`,
      [query.limit, query.search ?? null],
    );

    return {
      crates: result.rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        priceMinor: row.price_minor,
        metadata: row.metadata ?? {},
        royaltyBps: row.royalty_bps,
        opensCount: row.opens_count,
        volumeMinor: row.volume_minor,
        royaltiesPaidMinor: row.royalties_paid_minor,
        dropCount: Number(row.drop_count),
        createdAt: row.created_at,
        creator: row.creator,
        creatorVerified: row.creator_role === 'admin' || Number(row.opens_count) >= 100,
      })),
      sort,
      sorts: Object.keys(MARKETPLACE_SORTS),
    };
  });

  app.get('/v1/community/cases/:slug', { preHandler: softAuth }, async (request) => {
    const params = parseWith(slugParam, request.params);
    const result = await db.query<{
      id: string; slug: string; name: string; description: string; price_minor: string;
      metadata: Record<string, unknown> | null; royalty_bps: number; opens_count: string;
      volume_minor: string; royalties_paid_minor: string; created_at: Date; creator: string;
      creator_role: string; community_status: string; creator_user_id: string;
    }>(
      `SELECT c.*, u.minecraft_username AS creator, u.role AS creator_role
         FROM cases c JOIN users u ON u.id = c.creator_user_id
        WHERE c.slug = $1`,
      [params.slug],
    );
    const crate = result.rows[0];
    if (!crate) throw new AppError(404, 'CRATE_NOT_FOUND', 'No community crate with that slug');

    // A draft is visible only to the person who wrote it.
    const viewerId = request.authUser?.id ?? null;
    if (crate.community_status === 'draft' && viewerId !== crate.creator_user_id) {
      throw new AppError(404, 'CRATE_NOT_FOUND', 'No community crate with that slug');
    }

    const drops = await db.query<{
      catalog_item_id: string; weight: number; minecraft_name: string; display_name: string;
      image_url: string | null; unit_value_minor: string; metadata: Record<string, unknown> | null;
    }>(
      `SELECT k.catalog_item_id, k.weight, ci.minecraft_name, ci.display_name, ci.image_url,
              ci.unit_value_minor, ci.metadata
         FROM case_items k JOIN catalog_items ci ON ci.id = k.catalog_item_id
        WHERE k.case_id = $1 AND k.enabled
        ORDER BY ci.unit_value_minor DESC`,
      [crate.id],
    );
    const totalWeight = drops.rows.reduce((sum, row) => sum + BigInt(row.weight), 0n);

    return {
      crate: {
        id: crate.id,
        slug: crate.slug,
        name: crate.name,
        description: crate.description,
        priceMinor: crate.price_minor,
        metadata: crate.metadata ?? {},
        royaltyBps: crate.royalty_bps,
        opensCount: crate.opens_count,
        volumeMinor: crate.volume_minor,
        royaltiesPaidMinor: crate.royalties_paid_minor,
        status: crate.community_status,
        creator: crate.creator,
        creatorVerified: crate.creator_role === 'admin' || Number(crate.opens_count) >= 100,
        createdAt: crate.created_at,
        drops: drops.rows.map((row) => ({
          catalogItemId: row.catalog_item_id,
          weight: row.weight,
          chancePpm: totalWeight > 0n
            ? Number((BigInt(row.weight) * 1_000_000n) / totalWeight)
            : 0,
          minecraftName: row.minecraft_name,
          displayName: row.display_name,
          imageUrl: row.image_url,
          unitValueMinor: row.unit_value_minor,
          metadata: row.metadata ?? {},
        })),
      },
    };
  });

  /** A creator's own crates and what they have earned. */
  /* The one GET here that truly needs a user. It read request.authUser without a preHandler,
   * which is never populated on its own — so it answered 401 to everybody, signed in or not, and
   * the creator earnings tab could not load at all. */
  app.get('/v1/community/mine', { preHandler: guards.authenticate }, async (request) => {
    const userId = request.authUser?.id;
    if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in to see your crates');

    const [crates, earnings] = await Promise.all([
      db.query<{
        id: string; slug: string; name: string; price_minor: string; community_status: string;
        royalty_bps: number; opens_count: string; volume_minor: string;
        royalties_paid_minor: string; metadata: Record<string, unknown> | null; created_at: Date;
      }>(
        `SELECT id, slug, name, price_minor, community_status, royalty_bps, opens_count,
                volume_minor, royalties_paid_minor, metadata, created_at
           FROM cases WHERE creator_user_id = $1 ORDER BY created_at DESC`,
        [userId],
      ),
      db.query<{ total: string; payments: string }>(
        `SELECT COALESCE(sum(amount_minor), 0)::text AS total, count(*)::text AS payments
           FROM creator_royalties WHERE creator_user_id = $1`,
        [userId],
      ),
    ]);

    return {
      crates: crates.rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        priceMinor: row.price_minor,
        status: row.community_status,
        royaltyBps: row.royalty_bps,
        opensCount: row.opens_count,
        volumeMinor: row.volume_minor,
        royaltiesPaidMinor: row.royalties_paid_minor,
        metadata: row.metadata ?? {},
        createdAt: row.created_at,
      })),
      earnings: {
        totalMinor: earnings.rows[0]?.total ?? '0',
        payments: Number(earnings.rows[0]?.payments ?? 0),
      },
    };
  });

  /** Retire a crate. Not a delete: battles and rounds reference it forever. */
  app.post(
    '/v1/community/cases/:slug/retire',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const params = parseWith(slugParam, request.params);
      const userId = request.authUser?.id;
      if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');

      const result = await db.query<{ id: string }>(
        `UPDATE cases
            SET community_status = 'retired', enabled = false, updated_at = now()
          WHERE slug = $1 AND creator_user_id = $2 AND community_status <> 'retired'
          RETURNING id`,
        [params.slug, userId],
      );
      if (result.rows.length === 0) {
        throw new AppError(404, 'CRATE_NOT_FOUND', 'No live crate of yours with that slug');
      }
      return { retired: true };
    },
  );
}
