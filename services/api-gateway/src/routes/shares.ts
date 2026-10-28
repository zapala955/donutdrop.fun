import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import type { Database, DbClient } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { ROUND_GAME_KEYS, roundGameName, roundSql } from '../lib/player-rounds.js';
import { ensureReferralCode } from '../lib/referrals.js';
import { parseWith } from '../lib/validation.js';
import { multiplierText, renderWinCard } from '../lib/win-card.js';
import {
  isLinkPreview,
  isShareable,
  newShareId,
  SHARE_ID_PATTERN,
  shareImageUrl,
  shareLandingPath,
  sharePageHtml,
  shareTitle,
  type WinShare,
} from '../lib/win-shares.js';

/**
 * Win cards (lib/win-shares.ts): a player shares one of their own settled wins.
 *
 *   POST /v1/shares        make the link for a round of yours (or hand back the one already made)
 *   GET  /v1/shares/:id    the share, for the banner a visitor arriving on it is shown
 *   GET  /w/:id            the link itself: the card's page for a link preview, the site for a person
 *   GET  /w/:id.png        the card
 */

const createSchema = z.object({ game: z.enum(ROUND_GAME_KEYS), id: z.uuid() }).strict();
const idSchema = z.object({ id: z.string().regex(SHARE_ID_PATTERN) }).strict();
const slugSchema = z.object({ slug: z.string().max(16) }).strict();

interface ShareRow {
  id: string;
  game: string;
  wager_minor: string;
  payout_minor: string;
  referral_code: string | null;
}

// Never player_name: a share says nothing about who played it (lib/win-shares.ts).
const SHARE_COLUMNS = 'id, game, wager_minor, payout_minor, referral_code';

function toShare(row: ShareRow): WinShare {
  return {
    id: row.id,
    game: row.game,
    gameName: roundGameName(row.game),
    wagerMinor: BigInt(row.wager_minor),
    payoutMinor: BigInt(row.payout_minor),
    referralCode: row.referral_code,
  };
}

function shareBody(share: WinShare, config: AppConfig) {
  return {
    id: share.id,
    game: share.game,
    gameName: share.gameName,
    wagerMinor: share.wagerMinor.toString(),
    payoutMinor: share.payoutMinor.toString(),
    multiplier: multiplierText(share.wagerMinor, share.payoutMinor),
    // Whether the link brings a visitor in on the player's invite; the code itself is in the link.
    invite: share.referralCode !== null,
    title: shareTitle(share),
    url: `${config.appOrigin}/w/${share.id}`,
    imageUrl: shareImageUrl(share, config.appOrigin),
  };
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}

async function findShare(db: Database, id: string): Promise<WinShare | undefined> {
  const result = await db.query<ShareRow>(`SELECT ${SHARE_COLUMNS} FROM win_shares WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toShare(row) : undefined;
}

/** The share for one of the player's rounds: the one already made, or a new one from the round. */
async function shareRound(
  client: DbClient,
  config: AppConfig,
  userId: string,
  game: string,
  roundId: string,
): Promise<WinShare> {
  const existing = await client.query<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM win_shares WHERE user_id = $1 AND game = $2 AND round_id = $3`,
    [userId, game, roundId],
  );
  if (existing.rows[0]) return toShare(existing.rows[0]);

  const round = await client.query<{ wager: string; payout: string }>(roundSql(game), [userId, roundId, game]);
  const found = round.rows[0];
  if (!found) throw new AppError(404, 'ROUND_NOT_FOUND', 'That round is not in your history.');
  const wager = BigInt(found.wager);
  const payout = BigInt(found.payout);
  if (!isShareable(wager, payout)) {
    throw new AppError(409, 'ROUND_NOT_SHAREABLE', 'Only a win of 5x or more, or $10M or more profit, can be shared.');
  }

  const player = await client.query<{ name: string; demo: boolean; referral_blocked: boolean }>(
    `SELECT minecraft_username AS name, demo_of IS NOT NULL AS demo,
            referral_blocked_at IS NOT NULL AS referral_blocked
       FROM users WHERE id = $1`,
    [userId],
  );
  const account = player.rows[0];
  if (!account) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  // Play money is never advertised as a win (lib/media-test.ts).
  if (account.demo) throw new AppError(409, 'SHARE_TEST_MODE', 'Rounds played in test mode cannot be shared.');
  const code =
    config.referralsEnabled && !account.referral_blocked ? await ensureReferralCode(client, userId) : null;

  /* Two ways the insert can find a row already there: the same round shared at the same moment
   * (the unique round), or a new id drawn twice (the key). The first is answered with that share;
   * the second draws again. */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inserted = await client.query<ShareRow>(
      `INSERT INTO win_shares (id, user_id, game, round_id, player_name, wager_minor, payout_minor, referral_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING ${SHARE_COLUMNS}`,
      [newShareId(), userId, game, roundId, account.name, wager.toString(), payout.toString(), code],
    );
    if (inserted.rows[0]) return toShare(inserted.rows[0]);
    const raced = await client.query<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM win_shares WHERE user_id = $1 AND game = $2 AND round_id = $3`,
      [userId, game, roundId],
    );
    if (raced.rows[0]) return toShare(raced.rows[0]);
  }
  throw new Error('could not draw an unused share id');
}

export async function registerShareRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);

  app.post(
    '/v1/shares',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const userId = requireUserId(request.authUser?.id);
      if (request.authUser?.demoOf) {
        throw new AppError(409, 'SHARE_TEST_MODE', 'Rounds played in test mode cannot be shared.');
      }
      const body = parseWith(createSchema, request.body);
      const share = await db.transaction((client) => shareRound(client, config, userId, body.game, body.id));
      return shareBody(share, config);
    },
  );

  app.get(
    '/v1/shares/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const { id } = parseWith(idSchema, request.params);
      const share = await findShare(db, id);
      if (!share) throw new AppError(404, 'SHARE_NOT_FOUND', 'That win is not shared.');
      return shareBody(share, config);
    },
  );

  app.get(
    '/w/:slug',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { slug } = parseWith(slugSchema, request.params);
      const image = slug.endsWith('.png');
      const id = image ? slug.slice(0, -4) : slug;
      const share = SHARE_ID_PATTERN.test(id) ? await findShare(db, id) : undefined;

      if (image) {
        if (!share) throw new AppError(404, 'SHARE_NOT_FOUND', 'That win is not shared.');
        /* Not cached: the API answers everything no-store (app.ts, onSend), so each fetch draws the
         * card afresh, in its current design. Link previews keep their own copy whatever we say,
         * which is what CARD_VERSION in the address is for. */
        return reply
          .header('content-type', 'image/png')
          // Previews fetch it from their own servers, and some clients then load it from ours.
          .header('cross-origin-resource-policy', 'cross-origin')
          .send(renderWinCard(share));
      }

      if (!share) return reply.redirect('/', 302);
      if (isLinkPreview(request.headers['user-agent'])) {
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .send(sharePageHtml(share, config.appOrigin));
      }
      // Counted, never waited on: a visitor is not held at the door for a tally.
      void db
        .query('UPDATE win_shares SET views = views + 1 WHERE id = $1', [share.id])
        .catch((error: unknown) => request.log.warn({ err: error }, 'could not count a win share visit'));
      return reply.header('cache-control', 'no-store').redirect(shareLandingPath(share), 302);
    },
  );
}
