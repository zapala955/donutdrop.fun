import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { parseWith } from '../lib/validation.js';

const catalogQuery = z.object({
  minValueMinor: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
  maxValueMinor: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
  search: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).strict();

export async function registerCatalogRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const provisionedBotIds = [...config.botCredentials.keys()];

  app.get('/v1/catalog/items', { preHandler: guards.authenticate }, async (request) => {
    const query = parseWith(catalogQuery, request.query);
    const result = await db.query(
      `SELECT c.id, c.minecraft_name, c.display_name, c.image_url, c.unit_value_minor,
              c.price_updated_at,
              c.metadata, COALESCE(sum(i.quantity), 0)::bigint AS available_quantity
         FROM catalog_items c
         LEFT JOIN inventory_lots i ON i.catalog_item_id = c.id
          AND i.owner_user_id IS NULL AND i.state = 'available'
          AND EXISTS (
            SELECT 1 FROM bot_accounts b WHERE b.id = i.bot_id AND b.status = 'online'
              AND b.id = ANY($6::uuid[])
              AND b.reconciliation_status = 'matched'
              AND b.last_heartbeat_at > now() - interval '45 seconds'
              AND b.last_snapshot_at > now() - interval '45 seconds'
              AND b.transfer_capable
          )
        WHERE c.enabled
          AND ($1::bigint IS NULL OR c.unit_value_minor >= $1)
          AND ($2::bigint IS NULL OR c.unit_value_minor <= $2)
          AND ($3::text IS NULL OR c.display_name ILIKE '%' || $3 || '%')
        GROUP BY c.id
        ORDER BY c.unit_value_minor, c.id
        LIMIT $4 OFFSET $5`,
      [
        query.minValueMinor ?? null,
        query.maxValueMinor ?? null,
        query.search ?? null,
        query.limit,
        query.offset,
        provisionedBotIds,
      ],
    );
    return { items: result.rows, limit: query.limit, offset: query.offset };
  });

  app.get('/v1/inventory', { preHandler: guards.authenticate }, async (request) => {
    const result = await db.query(
      `SELECT i.id, i.quantity, i.state, i.created_at, c.id AS catalog_item_id,
              c.minecraft_name, c.display_name, c.image_url, c.unit_value_minor,
              c.price_updated_at, c.metadata
         FROM inventory_lots i JOIN catalog_items c ON c.id = i.catalog_item_id
        WHERE i.owner_user_id = $1 AND i.state IN ('available', 'withdrawal_pending')
        ORDER BY i.created_at, i.id`,
      [request.authUser?.id],
    );
    return { items: result.rows };
  });

  app.get('/v1/inventory/movements', { preHandler: guards.authenticate }, async (request) => {
    const result = await db.query(
      `SELECT m.id, m.quantity, m.reason, m.reference_id, m.created_at,
              m.from_user_id = $1 AS was_debit, m.to_user_id = $1 AS was_credit,
              c.id AS catalog_item_id, c.minecraft_name, c.display_name
         FROM custody_movements m JOIN catalog_items c ON c.id = m.catalog_item_id
        WHERE m.from_user_id = $1 OR m.to_user_id = $1
        ORDER BY m.created_at DESC, m.id DESC LIMIT 200`,
      [request.authUser?.id],
    );
    return { movements: result.rows };
  });
}
