import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { safeText } from '../lib/sanitize.js';
import { parseWith } from '../lib/validation.js';

/**
 * The community bot's dashboard settings: the welcome DM switch, and who may run /test.
 *
 * Stored per Discord server in `discord_guild_settings`, the table the bot already reads, so the bot
 * sees a change on its next use with no restart. The server's owner and the bot application's owner
 * can always run /test; the list here is for everybody else.
 */

const MAX_TEST_OWNERS = 20;
const SNOWFLAKE = /^[0-9]{5,32}$/;

const guildSchema = z.object({ guildId: z.string().regex(SNOWFLAKE) }).strict();
const updateSchema = z
  .object({
    welcomeDmEnabled: z.boolean().optional(),
    /* Whether the bot SENDS daily codes, and from which UTC hour. Whether the gateway PAYS them, and
     * how much, are runtime settings in the System tab. */
    dailyCodesEnabled: z.boolean().optional(),
    dailyCodesHour: z.number().int().min(0).max(23).optional(),
    /* A list of ids, however they were typed: the console sends one per line or comma-separated and
     * both arrive as an array. Each is checked for shape and the list is de-duplicated, so what is
     * stored is exactly what the bot will compare against. */
    testOwnerIds: z
      .array(z.string().trim().regex(SNOWFLAKE, 'must be a Discord user id'))
      .max(MAX_TEST_OWNERS)
      .optional(),
    reason: safeText(3, 256),
  })
  .strict()
  .refine(
    (value) =>
      value.welcomeDmEnabled !== undefined ||
      value.testOwnerIds !== undefined ||
      value.dailyCodesEnabled !== undefined ||
      value.dailyCodesHour !== undefined,
    { message: 'Change at least one setting' },
  );

interface SettingsRow {
  guild_id: string;
  welcome_dm_enabled: boolean;
  test_owner_ids: string;
  daily_codes_enabled: boolean;
  daily_codes_hour: number;
  subscribers?: string;
  updated_at: Date;
}

const view = (row: SettingsRow) => ({
  guildId: row.guild_id,
  welcomeDmEnabled: row.welcome_dm_enabled,
  testOwnerIds: row.test_owner_ids ? row.test_owner_ids.split(',') : [],
  dailyCodesEnabled: row.daily_codes_enabled,
  dailyCodesHour: row.daily_codes_hour,
  dailyCodeSubscribers: Number(row.subscribers ?? '0'),
  updatedAt: row.updated_at,
});

export async function registerAdminDiscordRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);
  const requireAdminRead = async (request: Parameters<typeof guards.authenticate>[0]) => {
    await guards.authenticate(request);
    if (request.authUser?.role !== 'admin' || request.authUser.status !== 'active') {
      throw new AppError(403, 'ADMIN_REQUIRED', 'Administrator access is required');
    }
  };

  /* Every server the bot has a settings row for. Normally exactly one: the bot serves a single
   * pinned guild and creates its row the first time it needs it. */
  app.get(
    '/v1/admin/discord-bot',
    { preHandler: requireAdminRead, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => {
      const result = await db.query<SettingsRow>(
        `SELECT g.guild_id, g.welcome_dm_enabled, g.test_owner_ids, g.daily_codes_enabled,
                g.daily_codes_hour, g.updated_at,
                (SELECT count(*) FROM discord_daily_subscribers s
                  WHERE s.guild_id = g.guild_id)::text AS subscribers
           FROM discord_guild_settings g ORDER BY g.created_at LIMIT 10`,
      );
      return { guilds: result.rows.map(view), maxTestOwners: MAX_TEST_OWNERS };
    },
  );

  app.patch(
    '/v1/admin/discord-bot/:guildId',
    { preHandler: guards.requireAdmin },
    async (request) => {
      const params = parseWith(guildSchema, request.params);
      const body = parseWith(updateSchema, request.body);
      const actor = request.authUser?.id;
      if (!actor) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');

      const ids = body.testOwnerIds ? [...new Set(body.testOwnerIds)] : undefined;
      return db.transaction(async (client) => {
        const before = await client.query<SettingsRow>(
          `SELECT guild_id, welcome_dm_enabled, test_owner_ids, daily_codes_enabled,
                  daily_codes_hour, updated_at
             FROM discord_guild_settings WHERE guild_id = $1 FOR UPDATE`,
          [params.guildId],
        );
        const previous = before.rows[0];
        if (!previous) {
          throw new AppError(404, 'GUILD_NOT_FOUND', 'The bot has no settings for that server');
        }
        const updated = await client.query<SettingsRow>(
          `UPDATE discord_guild_settings
              SET welcome_dm_enabled = COALESCE($2, welcome_dm_enabled),
                  test_owner_ids = COALESCE($3, test_owner_ids),
                  daily_codes_enabled = COALESCE($4, daily_codes_enabled),
                  daily_codes_hour = COALESCE($5, daily_codes_hour),
                  updated_at = now()
            WHERE guild_id = $1
            RETURNING guild_id, welcome_dm_enabled, test_owner_ids, daily_codes_enabled,
                      daily_codes_hour, updated_at`,
          [
            params.guildId,
            body.welcomeDmEnabled ?? null,
            ids ? ids.join(',') : null,
            body.dailyCodesEnabled ?? null,
            body.dailyCodesHour ?? null,
          ],
        );
        const row = updated.rows[0];
        if (!row)
          throw new AppError(404, 'GUILD_NOT_FOUND', 'The bot has no settings for that server');
        await appendAudit(client, config, {
          actorUserId: actor,
          action: 'discord_bot.update',
          targetType: 'discord_guild',
          targetId: params.guildId,
          details: {
            reason: body.reason,
            previous: {
              welcomeDmEnabled: previous.welcome_dm_enabled,
              testOwnerIds: previous.test_owner_ids,
              dailyCodesEnabled: previous.daily_codes_enabled,
              dailyCodesHour: previous.daily_codes_hour,
            },
            next: {
              welcomeDmEnabled: row.welcome_dm_enabled,
              testOwnerIds: row.test_owner_ids,
              dailyCodesEnabled: row.daily_codes_enabled,
              dailyCodesHour: row.daily_codes_hour,
            },
          },
        });
        return { guild: view(row) };
      });
    },
  );
}
