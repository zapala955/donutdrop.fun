import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { requireMatchingBotId, sendAuthenticatedBotResponse, verifyBotSignature } from '../lib/bot-auth.js';
import { verifyCommunityBotSignature } from '../lib/community-bot-auth.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import {
  playerNameSchema,
  SKIN_URL_PATTERN,
  STATS_CACHE_SECONDS,
  STATS_COOLDOWN_SECONDS,
  STATS_HOURLY_LIMIT,
  STATS_MAX_ATTEMPTS,
  STATS_QUEUE_LIMIT,
  STATS_QUEUED_TIMEOUT_SECONDS,
  STATS_RUNNING_TIMEOUT_SECONDS,
  statsSchema,
  type PlayerStats,
} from '../lib/player-stats.js';
import { playerSkin, renderStatsCard } from '../lib/stats-card.js';
import { parseWith } from '../lib/validation.js';

/**
 * /stats in the community bot, answered by the stats bot running DonutSMP's own /stats.
 *
 * A member's /stats queues a lookup (community side); the stats bot, a Minecraft account in role
 * 'stats' with no proxy (migration 102), claims it, runs `/stats <player>` in game, reads what the
 * server shows and reports it (bot side); the community bot polls for the result and posts the card
 * this draws (lib/stats-card.ts). Nothing here touches money: the stats bot is never picked for a
 * deposit, a login or a payout, because every one of those asks for a money role by name.
 */

const normalizedUuid = z.uuid().transform((value) => value.toLowerCase());

const claimSchema = z.object({ eventId: normalizedUuid, botId: normalizedUuid }).strict();

/* What the server showed, kept for checking the reader against the real menu: bounded, plain text. */
const rawSchema = z
  .object({
    title: z.string().max(300).optional(),
    items: z
      .array(z.object({ slot: z.number().int().min(0).max(200), name: z.string().max(300), lore: z.array(z.string().max(300)).max(40) }).strict())
      .max(80)
      .optional(),
    chat: z.array(z.string().max(500)).max(40).optional(),
    dialog: z.array(z.string().max(500)).max(60).optional(),
  })
  .strict();

const reportSchema = z
  .object({
    eventId: normalizedUuid,
    botId: normalizedUuid,
    lookupId: normalizedUuid,
    outcome: z.enum(['found', 'not_found', 'failed']),
    stats: statsSchema.optional(),
    shownName: playerNameSchema.optional(),
    skinUrl: z.string().regex(SKIN_URL_PATTERN).optional(),
    raw: rawSchema.optional(),
    errorCode: z.string().regex(/^[A-Z_]{2,64}$/).optional(),
    retryable: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.outcome !== 'found' || body.stats !== undefined, 'A found lookup carries its stats');

const requestSchema = z
  .object({ player: playerNameSchema, discordUserId: z.string().regex(/^[0-9]{5,25}$/) })
  .strict();
const resultSchema = z.object({ lookupId: normalizedUuid }).strict();

interface LookupRow {
  id: string;
  player: string;
  status: 'queued' | 'running' | 'found' | 'not_found' | 'failed';
  stats: PlayerStats | null;
  shown_name: string | null;
  skin_url: string | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

/**
 * Journals a stats event by its id, as every bot event is journalled (inbound_bot_events): the same
 * id with the same body is a replay and gets the stored answer; with another body it is refused.
 */
async function journal(
  client: DbClient,
  eventId: string,
  botId: string,
  type: 'stats_claim' | 'stats_report',
  body: unknown,
): Promise<{ replay: unknown } | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [eventId]);
  const bodyHash = sha256Hex(canonicalJson(body));
  const prior = await client.query<{ event_type: string; body_hash: string; response_body: unknown }>(
    'SELECT event_type, body_hash, response_body FROM inbound_bot_events WHERE event_id = $1',
    [eventId],
  );
  const previous = prior.rows[0];
  if (previous) {
    if (previous.event_type !== type || previous.body_hash !== bodyHash) {
      conflict('BOT_EVENT_ID_REUSED', 'Bot event ID was reused with a different body');
    }
    return { replay: previous.response_body };
  }
  return null;
}

async function remember(client: DbClient, eventId: string, botId: string, type: string, body: unknown, response: unknown) {
  await client.query(
    `INSERT INTO inbound_bot_events(event_id, bot_id, event_type, body_hash, response_body)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventId, botId, type, sha256Hex(canonicalJson(body)), JSON.stringify(response)],
  );
}

/** Gives a lookup the bot went quiet on back to the queue once, then fails it; fails ones nobody took. */
async function expireStale(client: DbClient): Promise<void> {
  await client.query(
    `UPDATE player_stats_lookups
        SET status = CASE WHEN attempts < $2 THEN 'queued' ELSE 'failed' END,
            error_code = CASE WHEN attempts < $2 THEN error_code ELSE 'TIMED_OUT' END,
            finished_at = CASE WHEN attempts < $2 THEN NULL ELSE now() END,
            claimed_at = NULL
      WHERE status = 'running' AND claimed_at < now() - make_interval(secs => $1)`,
    [STATS_RUNNING_TIMEOUT_SECONDS, STATS_MAX_ATTEMPTS],
  );
  await client.query(
    `UPDATE player_stats_lookups SET status = 'failed', error_code = 'NOT_CLAIMED', finished_at = now()
      WHERE status = 'queued' AND created_at < now() - make_interval(secs => $1)`,
    [STATS_QUEUED_TIMEOUT_SECONDS],
  );
}

/** A stats bot that is in game and taking lookups: role stats, not switched off, heard from lately. */
async function statsBotOnline(client: DbClient, provisioned: string[]): Promise<boolean> {
  const bots = await client.query(
    `SELECT 1 FROM bot_accounts
      WHERE id = ANY($1::uuid[]) AND role = 'stats' AND status IN ('online', 'degraded')
        AND parked_at IS NULL AND last_heartbeat_at > now() - interval '45 seconds'
      LIMIT 1`,
    [provisioned],
  );
  return Boolean(bots.rowCount);
}

export async function registerPlayerStatsRoutes(app: FastifyInstance, db: Database, config: AppConfig): Promise<void> {
  const provisioned = [...config.botCredentials.keys()];

  /* ── The stats bot ───────────────────────────────────────────────────────────────────────── */

  app.post(
    '/internal/v1/minecraft/stats/claim',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const authenticated = verifyBotSignature(request, config);
      const body = parseWith(claimSchema, request.body);
      requireMatchingBotId(authenticated.botId, body.botId);
      const response = await db.transaction(async (client) => {
        const replayed = await journal(client, body.eventId, body.botId, 'stats_claim', body);
        if (replayed) return replayed.replay;
        await expireStale(client);
        // Only a bot in the stats role, switched on, ever gets a lookup.
        const bot = await client.query(
          `SELECT 1 FROM bot_accounts WHERE id = $1 AND role = 'stats' AND status <> 'quarantined' AND parked_at IS NULL`,
          [body.botId],
        );
        let lookup: { id: string; player: string } | null = null;
        if (bot.rowCount) {
          const claimed = await client.query<{ id: string; player: string }>(
            `UPDATE player_stats_lookups
                SET status = 'running', claimed_at = now(), bot_id = $1, attempts = attempts + 1
              WHERE id = (SELECT id FROM player_stats_lookups WHERE status = 'queued'
                           ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
              RETURNING id, player`,
            [body.botId],
          );
          lookup = claimed.rows[0] ?? null;
        }
        const answer = { lookup };
        await remember(client, body.eventId, body.botId, 'stats_claim', body, answer);
        return answer;
      });
      return sendAuthenticatedBotResponse(reply, authenticated, request.body, response);
    },
  );

  app.post(
    '/internal/v1/minecraft/stats/report',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const authenticated = verifyBotSignature(request, config);
      const body = parseWith(reportSchema, request.body);
      requireMatchingBotId(authenticated.botId, body.botId);
      const response = await db.transaction(async (client) => {
        const replayed = await journal(client, body.eventId, body.botId, 'stats_report', body);
        if (replayed) return replayed.replay;
        const raw = body.raw ? JSON.stringify(body.raw) : null;
        let updated;
        if (body.outcome === 'failed' && body.retryable) {
          // Tried again by the next claim, unless it has had its tries.
          updated = await client.query(
            `UPDATE player_stats_lookups
                SET status = CASE WHEN attempts < $3 THEN 'queued' ELSE 'failed' END,
                    finished_at = CASE WHEN attempts < $3 THEN NULL ELSE now() END,
                    claimed_at = NULL, error_code = $4, raw = coalesce($5::jsonb, raw)
              WHERE id = $1 AND bot_id = $2 AND status = 'running'`,
            [body.lookupId, body.botId, STATS_MAX_ATTEMPTS, body.errorCode ?? 'FAILED', raw],
          );
        } else {
          updated = await client.query(
            `UPDATE player_stats_lookups
                SET status = $3, stats = $4::jsonb, shown_name = $5, skin_url = $6, raw = $7::jsonb,
                    error_code = $8, finished_at = now()
              WHERE id = $1 AND bot_id = $2 AND status = 'running'`,
            [
              body.lookupId,
              body.botId,
              body.outcome,
              body.outcome === 'found' ? JSON.stringify(body.stats) : null,
              body.shownName ?? null,
              body.skinUrl ?? null,
              raw,
              body.outcome === 'failed' ? (body.errorCode ?? 'FAILED') : null,
            ],
          );
        }
        const answer = { applied: Boolean(updated.rowCount) };
        await remember(client, body.eventId, body.botId, 'stats_report', body, answer);
        return answer;
      });
      return sendAuthenticatedBotResponse(reply, authenticated, request.body, response);
    },
  );

  /* ── The community bot ───────────────────────────────────────────────────────────────────── */

  if (!config.communityBotEnabled) return;

  app.post(
    '/internal/v1/community/stats/request',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(requestSchema, request.body);
      const normalized = body.player.toLowerCase();
      return db.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 9301))', [normalized]);
        await expireStale(client);
        // The same player looked up a moment ago, or being looked up now: that one answers.
        const recent = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM player_stats_lookups
            WHERE normalized_player = $1
              AND (status IN ('queued', 'running')
                   OR (status IN ('found', 'not_found') AND finished_at > now() - make_interval(secs => $2)))
            ORDER BY created_at DESC LIMIT 1`,
          [normalized, STATS_CACHE_SECONDS],
        );
        if (recent.rows[0]) return { lookupId: recent.rows[0].id, status: recent.rows[0].status, reused: true };

        const asked = await client.query<{ last: Date | null; hour: string }>(
          `SELECT max(created_at) AS last, count(*) FILTER (WHERE created_at > now() - interval '1 hour')::text AS hour
             FROM player_stats_lookups WHERE requested_by_discord_id = $1 AND created_at > now() - interval '1 hour'`,
          [body.discordUserId],
        );
        const last = asked.rows[0]?.last;
        if (last && Date.now() - last.getTime() < STATS_COOLDOWN_SECONDS * 1000) {
          throw new AppError(429, 'STATS_COOLDOWN', `One lookup every ${STATS_COOLDOWN_SECONDS} seconds: try again in a moment.`);
        }
        if (Number(asked.rows[0]?.hour ?? '0') >= STATS_HOURLY_LIMIT) {
          throw new AppError(429, 'STATS_HOURLY_LIMIT', `That is ${STATS_HOURLY_LIMIT} lookups this hour: try again later.`);
        }
        /* 409 and 429, not 503: the community bot passes on a 4xx's own sentence to the member and
         * keeps 5xx for operators, and "the stats bot is not in game" is for the member. */
        if (!(await statsBotOnline(client, provisioned))) {
          throw new AppError(409, 'STATS_BOT_OFFLINE', 'The stats bot is not in game right now. Try again in a minute.');
        }
        const waiting = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM player_stats_lookups WHERE status IN ('queued', 'running')`,
        );
        if (Number(waiting.rows[0]?.count ?? '0') >= STATS_QUEUE_LIMIT) {
          throw new AppError(429, 'STATS_BUSY', 'Lots of lookups right now. Try again in a minute.');
        }
        const id = randomUUID();
        await client.query(
          `INSERT INTO player_stats_lookups (id, player, normalized_player, requested_by_discord_id)
           VALUES ($1, $2, $3, $4)`,
          [id, body.player, normalized, body.discordUserId],
        );
        return { lookupId: id, status: 'queued', reused: false };
      });
    },
  );

  app.post(
    '/internal/v1/community/stats/result',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      verifyCommunityBotSignature(request, config);
      const body = parseWith(resultSchema, request.body);
      const found = await db.query<LookupRow>(
        `SELECT id, player, status, stats, shown_name, skin_url, error_code, created_at, finished_at
           FROM player_stats_lookups WHERE id = $1`,
        [body.lookupId],
      );
      const row = found.rows[0];
      if (!row) throw new AppError(404, 'STATS_LOOKUP_NOT_FOUND', 'No such lookup');
      const player = row.shown_name ?? row.player;
      if (row.status !== 'found' || !row.stats) {
        return { status: row.status, player, errorCode: row.error_code };
      }
      const stats = statsSchema.parse(row.stats);
      const skin = await playerSkin(player, row.skin_url, (url) => SKIN_URL_PATTERN.test(url));
      const card = renderStatsCard({ player, stats, skinPng: skin, fetchedAt: row.finished_at ?? row.created_at });
      return {
        status: row.status,
        player,
        stats,
        finishedAt: row.finished_at?.toISOString() ?? null,
        cardPng: card.toString('base64'),
      };
    },
  );
}
