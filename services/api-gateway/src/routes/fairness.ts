import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { FAIR_GAME_KEYS, FAIR_GAME_NAMES, fairRoundsSql } from '../lib/fair-rounds.js';
import { roundGameName } from '../lib/player-rounds.js';
import { parseWith } from '../lib/validation.js';

/**
 * GET /v1/fairness/rounds: the player's own seeded rounds, every game, newest first, each with the
 * hash committed before it, the seed revealed after it, its client seed and nonce, and -- for a
 * single-draw game -- the exact message hashed and the recorded result (lib/fair-rounds.ts). What
 * the Provably Fair page checks in the browser. Pages by time, like the history.
 */

const roundsSchema = z
  .object({
    game: z.enum(FAIR_GAME_KEYS).optional(),
    before: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

interface FairRow {
  game: string;
  id: string;
  at: string;
  wager: string;
  payout: string;
  detail: string | null;
  server_seed_hash: string;
  server_seed_reveal: string;
  client_seed: string | null;
  nonce: number | null;
  message: string | null;
  facts: Record<string, unknown> | null;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}

export async function registerFairnessRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.get(
    '/v1/fairness/rounds',
    { preHandler: guards.authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      const query = parseWith(roundsSchema, request.query ?? {});
      const result = await db.query<FairRow>(fairRoundsSql(query.game ?? null), [
        userId,
        query.before ?? 'infinity',
        query.limit,
      ]);
      return {
        rounds: result.rows.map((row) => ({
          game: row.game,
          name: FAIR_GAME_NAMES[row.game] ?? roundGameName(row.game),
          id: row.id,
          at: row.at,
          wagerMinor: row.wager,
          payoutMinor: row.payout,
          detail: row.detail || null,
          serverSeedHash: row.server_seed_hash.trim(),
          serverSeed: row.server_seed_reveal.trim(),
          clientSeed: row.client_seed,
          nonce: row.nonce,
          message: row.message,
          facts: row.facts,
        })),
        next: result.rows.length === query.limit ? result.rows[result.rows.length - 1]!.at : null,
        games: FAIR_GAME_KEYS.map((game) => ({ game, name: FAIR_GAME_NAMES[game] ?? roundGameName(game) })),
      };
    },
  );
}
