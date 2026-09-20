import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../lib/audit.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, wageredSince } from '../lib/cash-settlement.js';
import type { Database } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { readJackpot } from '../lib/jackpot.js';
import { deterministicUuid } from '../lib/battle-engine.js';
import { parseWith } from '../lib/validation.js';
import { safePublicText } from '../lib/sanitize.js';

/**
 * The social suite: the vault jackpot readout, lava rain, and player-to-player tips.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE JACKPOT HAS NO "TRIGGER" ENDPOINT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The draw happens inside `recordWager`, in the same transaction that settles the round that drew
 * it, and the money is in the winner's wallet before this route ever hears about it. There is
 * nothing here to press. The client polls, sees a win against its own account that it has not shown
 * yet, and plays the flare — which makes the celebration a readout of a completed fact rather than
 * a step in the payment. A player who closes the tab mid-animation has still been paid.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY RAIN PAYS AT SETTLEMENT AND NOT AT CLAIM
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The share depends on how many people claim, and that is not known until the window shuts. So a
 * claim registers an entitlement and the money moves once, at the end, when the divisor is final.
 * Paying on claim would mean either guessing the divisor or paying the first claimant more than the
 * last, and both of those are the same bug.
 *
 * The sweeper that settles a closed drop runs lazily off the read, like the arena's orphan sweep:
 * a route that needs a cron to be correct is a route that is incorrect on the day the cron dies.
 */

const tipSchema = z
  .object({
    /* The name stays, because `/tip <name> 5m` is a real command and somebody typing a name means
     * whoever holds that name. */
    toUsername: z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
    /* And an id wins when the caller has one. Clicking a head in chat means "that person", not
     * "whoever is called that now" — and Minecraft names are reassignable, so the two can differ.
     * Optional because only the avatar path knows an id; the typed command never will. */
    toUserId: z.uuid().optional(),
    amountMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
    /* safePublicText, not a bare string. A tip note is one account's typing rendered inside
     * another account's page, which is the exact case this helper documents itself as being for.
     * It was the only free-text field on the platform still admitting control characters, bidi
     * overrides, zero-width joiners and tag-shaped input. The chat client happens to render it
     * through textContent today, so nothing was live — but "safe because of how one consumer
     * currently renders it" is not a property of the data, and the note is already reachable by
     * the Discord embed feed and the admin console. */
    note: safePublicText(1, 80).optional(),
  })
  .strict();

const rainSchema = z
  .object({
    poolMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
    /** Minutes the claim window stays open. Defaults to the configured value. */
    claimMinutes: z.number().int().min(1).max(60).optional(),
    reason: safePublicText(1, 240).optional(),
  })
  .strict();

function softAuthenticate(guards: { authenticate: (request: FastifyRequest) => Promise<void> }) {
  return async (request: FastifyRequest) => {
    try {
      await guards.authenticate(request);
    } catch {
      /* the jackpot bar and the rain card are readable logged out */
    }
  };
}

interface RainRow {
  id: string;
  pool_minor: string;
  min_wagered_minor: string;
  window_minutes: number;
  opens_at: Date;
  closes_at: Date;
  status: string;
  claimant_count: number | null;
  per_claim_minor: string | null;
}

export async function registerSocialRoutes(app: FastifyInstance, db: Database, config: AppConfig) {
  const guards = createAuthGuards(db, config);
  const softAuth = softAuthenticate(guards);

  function requireUser(request: FastifyRequest): string {
    const userId = request.authUser?.id;
    if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Log in first');
    return userId;
  }

  /* ═════════════════════════ the vault jackpot ═════════════════════════ */

  app.get('/v1/social/jackpot', { preHandler: softAuth }, async (request) => {
    if (!config.vaultJackpotEnabled) {
      throw new AppError(404, 'JACKPOT_DISABLED', 'The vault jackpot is not switched on');
    }
    const viewerId = request.authUser?.id ?? null;
    const pot = await readJackpot(db);

    const recent = await db.query<{ amount_minor: string; won_at: Date; winner: string | null }>(
      `SELECT w.amount_minor, w.won_at, u.minecraft_username AS winner
         FROM vault_jackpot_wins w JOIN users u ON u.id = w.user_id
        ORDER BY w.won_at DESC LIMIT 5`,
    );

    /* A win the viewer has not necessarily seen yet. Five minutes is long enough to survive a
     * reload and short enough that yesterday's win does not re-fire the flare every morning. */
    const yours = viewerId
      ? await db.query<{ id: string; amount_minor: string; won_at: Date }>(
          `SELECT id, amount_minor, won_at FROM vault_jackpot_wins
            WHERE user_id = $1 AND won_at > now() - interval '5 minutes'
            ORDER BY won_at DESC LIMIT 1`,
          [viewerId],
        )
      : { rows: [] as { id: string; amount_minor: string; won_at: Date }[] };

    return {
      potMinor: pot.potMinor,
      seedMinor: pot.seedMinor,
      lifetimePaidMinor: pot.lifetimePaidMinor,
      /* Published so a player can check the odds they were given. `chance = wager / divisor`. */
      oddsDivisorMinor: config.vaultJackpotOddsDivisorMinor.toString(),
      recentWins: recent.rows.map((row) => ({
        winner: row.winner,
        amountMinor: row.amount_minor,
        wonAt: row.won_at.toISOString(),
      })),
      yourWin: yours.rows[0]
        ? {
            id: yours.rows[0].id,
            amountMinor: yours.rows[0].amount_minor,
            wonAt: yours.rows[0].won_at.toISOString(),
          }
        : null,
    };
  });

  /* ═════════════════════════ lava rain ═════════════════════════ */

  /**
   * Settles every drop whose window has shut.
   *
   * Idempotent and guarded by `status = 'open'` inside the UPDATE, so two readers racing cannot
   * both pay the same pool out. A drop nobody claimed is marked `expired` rather than settled: the
   * pool was never handed out and the row says so instead of recording a payment of nothing.
   */
  async function settleClosedRain(): Promise<void> {
    const due = await db.query<{ id: string }>(
      `SELECT id FROM lava_rain_events WHERE status = 'open' AND closes_at <= now() LIMIT 5`,
    );
    for (const row of due.rows) {
      try {
        await db.transaction(async (client) => {
          const locked = await client.query<RainRow>(
            `SELECT * FROM lava_rain_events WHERE id = $1 AND status = 'open' FOR UPDATE`,
            [row.id],
          );
          const event = locked.rows[0];
          if (!event) return;

          const claims = await client.query<{ user_id: string }>(
            'SELECT user_id FROM lava_rain_claims WHERE event_id = $1 ORDER BY claimed_at',
            [event.id],
          );
          const count = claims.rowCount ?? 0;
          const pool = BigInt(event.pool_minor);

          if (count === 0) {
            await client.query(
              `UPDATE lava_rain_events
                  SET status = 'expired', settled_at = now(), claimant_count = 0,
                      per_claim_minor = 0, remainder_minor = $2
                WHERE id = $1 AND status = 'open'`,
              [event.id, pool.toString()],
            );
            return;
          }

          /* Integer division, with the undividable units kept on the row rather than quietly
           * dropped. `lava_rain_pool_adds_up` refuses the write if they do not reconcile. */
          const each = pool / BigInt(count);
          const remainder = pool - each * BigInt(count);

          const claimed = await client.query(
            `UPDATE lava_rain_events
                SET status = 'settled', settled_at = now(), claimant_count = $2,
                    per_claim_minor = $3, remainder_minor = $4
              WHERE id = $1 AND status = 'open'`,
            [event.id, count, each.toString(), remainder.toString()],
          );
          if (claimed.rowCount === 0) return; // somebody else settled it first

          for (const claim of claims.rows) {
            await client.query(
              'UPDATE lava_rain_claims SET paid_minor = $3 WHERE event_id = $1 AND user_id = $2',
              [event.id, claim.user_id, each.toString()],
            );
            if (each > 0n) {
              await creditWallet(
                client,
                claim.user_id,
                each,
                'rain_claim',
                deterministicUuid('rain_claim', event.id, claim.user_id),
              );
            }
          }
        });
      } catch (error) {
        app.log.error({ error, eventId: row.id }, 'lava rain settlement failed');
      }
    }
  }

  app.get('/v1/social/rain', { preHandler: softAuth }, async (request) => {
    if (!config.lavaRainEnabled) {
      throw new AppError(404, 'RAIN_DISABLED', 'Lava rain is not switched on');
    }
    await settleClosedRain();
    const viewerId = request.authUser?.id ?? null;

    const live = await db.query<RainRow>(
      `SELECT * FROM lava_rain_events
        WHERE status = 'open' AND closes_at > now()
        ORDER BY closes_at LIMIT 1`,
    );
    const event = live.rows[0] ?? null;

    let you = null;
    if (event && viewerId) {
      const wagered = await wageredSince(db, viewerId, event.window_minutes);
      const claimed = await db.query(
        'SELECT 1 FROM lava_rain_claims WHERE event_id = $1 AND user_id = $2',
        [event.id, viewerId],
      );
      you = {
        wageredMinor: wagered.toString(),
        eligible: wagered >= BigInt(event.min_wagered_minor),
        claimed: (claimed.rowCount ?? 0) > 0,
      };
    }

    const claimants = event
      ? await db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM lava_rain_claims WHERE event_id = $1',
          [event.id],
        )
      : null;

    const settled = await db.query<{
      pool_minor: string;
      claimant_count: number | null;
      per_claim_minor: string | null;
      settled_at: Date | null;
    }>(
      `SELECT pool_minor, claimant_count, per_claim_minor, settled_at
         FROM lava_rain_events WHERE status = 'settled'
        ORDER BY settled_at DESC LIMIT 3`,
    );

    return {
      active: event
        ? {
            id: event.id,
            poolMinor: event.pool_minor,
            minWageredMinor: event.min_wagered_minor,
            windowMinutes: event.window_minutes,
            closesAt: event.closes_at.toISOString(),
            claimants: Number(claimants?.rows[0]?.n ?? '0'),
          }
        : null,
      you,
      recent: settled.rows.map((row) => ({
        poolMinor: row.pool_minor,
        claimants: row.claimant_count,
        perClaimMinor: row.per_claim_minor,
        settledAt: row.settled_at?.toISOString() ?? null,
      })),
    };
  });

  app.post(
    '/v1/social/rain/claim',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      if (!config.lavaRainEnabled) {
        throw new AppError(404, 'RAIN_DISABLED', 'Lava rain is not switched on');
      }
      const userId = requireUser(request);

      return db.transaction(async (client) => {
        const live = await client.query<RainRow>(
          `SELECT * FROM lava_rain_events
            WHERE status = 'open' AND closes_at > now()
            ORDER BY closes_at LIMIT 1 FOR UPDATE`,
        );
        const event = live.rows[0];
        if (!event) throw new AppError(404, 'NO_RAIN', 'Nothing is falling right now');

        /* Eligibility is rechecked HERE, against the live window, rather than trusted from whatever
         * the client was shown. The card a player is looking at may be thirty seconds stale, and
         * thirty seconds is enough for a window to roll past a wager that was inside it. */
        const wagered = await wageredSince(client, userId, event.window_minutes);
        if (wagered < BigInt(event.min_wagered_minor)) {
          throw new AppError(403, 'RAIN_NOT_ELIGIBLE', 'Not enough wagered inside the window');
        }

        try {
          await client.query(
            `INSERT INTO lava_rain_claims (event_id, user_id, qualifying_wagered_minor)
             VALUES ($1, $2, $3)`,
            [event.id, userId, wagered.toString()],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new AppError(409, 'RAIN_ALREADY_CLAIMED', 'You are already in this one');
          }
          throw error;
        }

        const claimants = await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM lava_rain_claims WHERE event_id = $1',
          [event.id],
        );
        return {
          ok: true,
          /* An estimate, and labelled as one: the divisor is still moving. The real figure is paid
           * when the window shuts. */
          claimants: Number(claimants.rows[0]?.n ?? '1'),
          estimatedShareMinor: (
            BigInt(event.pool_minor) / BigInt(claimants.rows[0]?.n ?? '1')
          ).toString(),
          closesAt: event.closes_at.toISOString(),
        };
      });
    },
  );

  /** Starts a drop by hand. Staff only — this spends the operator's money. */
  app.post(
    '/v1/social/rain',
    { preHandler: guards.requireAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      if (!config.lavaRainEnabled) {
        throw new AppError(404, 'RAIN_DISABLED', 'Lava rain is not switched on');
      }
      const userId = requireUser(request);
      const body = parseWith(rainSchema, request.body);
      const pool = BigInt(body.poolMinor);
      if (pool > config.lavaRainMaxPoolMinor) {
        throw new AppError(400, 'RAIN_POOL_TOO_LARGE', 'That exceeds the configured maximum pool');
      }

      const minutes = body.claimMinutes ?? config.lavaRainClaimMinutes;
      const id = randomUUID();
      await db.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lava-rain-create', 0))");
        const existing = await client.query(
          `SELECT 1 FROM lava_rain_events
            WHERE status = 'open' AND closes_at > now() LIMIT 1`,
        );
        if (existing.rows[0]) {
          throw new AppError(409, 'RAIN_ALREADY_ACTIVE', 'A Lava Rain event is already active');
        }
        await client.query(
          `INSERT INTO lava_rain_events
             (id, pool_minor, created_by, min_wagered_minor, window_minutes,
              opens_at, closes_at, status)
           VALUES ($1, $2, $3, $4, $5, now(), now() + make_interval(mins => $6), 'open')`,
          [
            id,
            pool.toString(),
            userId,
            config.lavaRainMinWageredMinor.toString(),
            config.lavaRainWindowMinutes,
            minutes,
          ],
        );
        await appendAudit(client, config, {
          actorUserId: userId,
          action: 'lava_rain.create',
          targetType: 'lava_rain_event',
          targetId: id,
          details: {
            poolMinor: pool.toString(),
            claimMinutes: minutes,
            reason: body.reason ?? 'Manual operator promotion',
          },
        });
      });
      return { id, poolMinor: pool.toString(), claimMinutes: minutes };
    },
  );

  /* ═════════════════════════ tips ═════════════════════════ */

  app.post(
    '/v1/social/tip',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      if (!config.tipsEnabled) {
        throw new AppError(404, 'TIPS_DISABLED', 'Tipping is not switched on');
      }
      const fromUserId = requireUser(request);
      const body = parseWith(tipSchema, request.body);
      const amount = BigInt(body.amountMinor);
      if (amount < config.tipMinMinor || amount > config.tipMaxMinor) {
        throw new AppError(400, 'TIP_OUT_OF_BAND', 'That amount is outside the tip limits');
      }

      return db.transaction(async (client) => {
        const target = body.toUserId
          ? await client.query<{ id: string; minecraft_username: string }>(
              `SELECT id, minecraft_username FROM users WHERE id = $1 AND status = 'active'`,
              [body.toUserId],
            )
          : await client.query<{ id: string; minecraft_username: string }>(
              `SELECT id, minecraft_username FROM users
                WHERE normalized_username = lower($1::varchar) AND status = 'active'`,
              [body.toUsername],
            );
        const recipient = target.rows[0];
        if (!recipient) throw new AppError(404, 'NO_SUCH_PLAYER', 'No active player by that name');
        if (recipient.id === fromUserId) {
          throw new AppError(400, 'TIP_TO_SELF', 'You cannot tip yourself');
        }

        /* Debit and balance check in ONE statement, as everywhere else on this platform. A
         * read-then-write here is how a player tips money they no longer have. */
        const debited = await client.query<{ balance_minor: string }>(
          `UPDATE user_wallets SET balance_minor = balance_minor - $2, updated_at = now()
            WHERE user_id = $1 AND balance_minor >= $2
            RETURNING balance_minor`,
          [fromUserId, amount.toString()],
        );
        const balanceAfter = debited.rows[0]?.balance_minor;
        if (balanceAfter === undefined) {
          throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Not enough balance for that tip');
        }

        const tipId = randomUUID();
        await client.query(
          `INSERT INTO player_tips (id, from_user_id, to_user_id, amount_minor, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [tipId, fromUserId, recipient.id, amount.toString(), body.note ?? null],
        );
        await client.query(
          `INSERT INTO wallet_transactions
             (id, user_id, amount_minor, balance_after_minor, kind, reference_id)
           VALUES ($1, $2, $3, $4, 'tip_sent', $5)`,
          [randomUUID(), fromUserId, (-amount).toString(), balanceAfter, tipId],
        );
        await creditWallet(client, recipient.id, amount, 'tip_received', tipId);

        /* Deliberately NOT recorded as a wager. A tip generates no margin, and if it counted toward
         * wagered volume two accounts could pass the same money back and forth to farm the VIP
         * ladder, rakeback and every rain window on the platform. */
        return {
          ok: true,
          tipId,
          toUsername: recipient.minecraft_username,
          amountMinor: amount.toString(),
        };
      });
    },
  );
}
