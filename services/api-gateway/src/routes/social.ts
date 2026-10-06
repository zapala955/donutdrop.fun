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
import { liveEvents } from '../lib/live-events.js';
import { deterministicUuid } from '../lib/battle-engine.js';
import { parseWith } from '../lib/validation.js';
import { safePublicText } from '../lib/sanitize.js';
import { assertWagerRequirementMet } from '../lib/wager-requirements.js';

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

    const recent = await db.query<{ amount_minor: string; won_at: Date }>(
      `SELECT amount_minor, won_at
         FROM vault_jackpot_wins
        ORDER BY won_at DESC LIMIT 5`,
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
    let closedAny = false;
    for (const row of due.rows) {
      try {
        const closed = await db.transaction(async (client) => {
          const locked = await client.query<RainRow>(
            `SELECT * FROM lava_rain_events WHERE id = $1 AND status = 'open' FOR UPDATE`,
            [row.id],
          );
          const event = locked.rows[0];
          if (!event) return false;

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
            return true;
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
          if (claimed.rowCount === 0) return false; // somebody else settled it first

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
          return true;
        });
        closedAny ||= closed;
      } catch (error) {
        app.log.error({ error, eventId: row.id }, 'lava rain settlement failed');
      }
    }
    /* Only when this reader actually closed one. Every open card refetches on the event, and a
     * refetch that finds nothing due publishes nothing, so this cannot feed itself. */
    if (closedAny) liveEvents.publish('rain');
  }

  /**
   * Opens a drop by itself when automatic rain is on and none has opened for the configured
   * interval -- a drop started by hand resets the clock too. Under the same advisory lock as the
   * manual start, so two API processes, or a tick racing an operator, cannot open two at once.
   * `created_by` is null, which is how the table has always marked an automated drop.
   */
  async function autoDropRain(): Promise<boolean> {
    if (!config.lavaRainEnabled || config.lavaRainAutoEveryMinutes <= 0) return false;
    const pool =
      config.lavaRainAutoPoolMinor < config.lavaRainMaxPoolMinor
        ? config.lavaRainAutoPoolMinor
        : config.lavaRainMaxPoolMinor;
    return db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('lava-rain-create', 0))");
      const recent = await client.query(
        `SELECT 1 FROM lava_rain_events
          WHERE (status = 'open' AND closes_at > now())
             OR created_at > now() - make_interval(mins => $1)
          LIMIT 1`,
        [config.lavaRainAutoEveryMinutes],
      );
      if (recent.rows[0]) return false;
      await client.query(
        `INSERT INTO lava_rain_events
           (id, pool_minor, created_by, min_wagered_minor, window_minutes,
            opens_at, closes_at, status)
         VALUES ($1, $2, NULL, $3, $4, now(), now() + make_interval(mins => $5), 'open')`,
        [
          randomUUID(),
          pool.toString(),
          config.lavaRainMinWageredMinor.toString(),
          config.lavaRainWindowMinutes,
          config.lavaRainClaimMinutes,
        ],
      );
      return true;
    });
  }

  /* ── the rain clock ──
   * Settlement used to happen only when somebody loaded the card, so a drop whose window shut with
   * the site quiet stayed unpaid until the next visitor. This pays it within fifteen seconds of
   * closing, page open or not, and opens the automatic drops. Correctness never depends on it: the
   * card still settles whatever is due before it reads. */
  if (typeof app.addHook === 'function') {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await settleClosedRain();
        if (await autoDropRain()) liveEvents.publish('rain');
      } catch (error) {
        app.log.error({ err: error }, 'lava rain tick failed');
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void tick(), 15_000);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
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
      const wagered = await wageredSince(db, config, viewerId, event.window_minutes);
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
      id: string;
      pool_minor: string;
      claimant_count: number | null;
      per_claim_minor: string | null;
      settled_at: Date | null;
    }>(
      `SELECT id, pool_minor, claimant_count, per_claim_minor, settled_at
         FROM lava_rain_events WHERE status = 'settled'
        ORDER BY settled_at DESC LIMIT 3`,
    );

    /* The viewer's own share of a drop that has just paid out. The money moved at settlement,
     * possibly while nobody had this page open, so the card says so once it next loads -- the same
     * readout-of-a-completed-fact shape as the jackpot's `yourWin`. Ten minutes survives a reload
     * without replaying last night's drop every morning. */
    const payout = viewerId
      ? await db.query<{ event_id: string; paid_minor: string; claimant_count: number }>(
          `SELECT c.event_id, c.paid_minor::text AS paid_minor, e.claimant_count
             FROM lava_rain_claims c
             JOIN lava_rain_events e ON e.id = c.event_id
            WHERE c.user_id = $1 AND e.status = 'settled' AND c.paid_minor > 0
              AND e.settled_at > now() - interval '10 minutes'
            ORDER BY e.settled_at DESC LIMIT 1`,
          [viewerId],
        )
      : null;
    const paid = payout?.rows[0];

    /* When the next automatic drop is due, for the countdown the card shows between drops. Null
     * while one is falling or while drops are only started by hand. */
    let next: { at: string; poolMinor: string } | null = null;
    if (!event && config.lavaRainAutoEveryMinutes > 0) {
      const last = await db.query<{ due: Date }>(
        `SELECT greatest(now(), max(created_at) + make_interval(mins => $1)) AS due
           FROM lava_rain_events`,
        [config.lavaRainAutoEveryMinutes],
      );
      const pool =
        config.lavaRainAutoPoolMinor < config.lavaRainMaxPoolMinor
          ? config.lavaRainAutoPoolMinor
          : config.lavaRainMaxPoolMinor;
      next = {
        at: (last.rows[0]?.due ?? new Date()).toISOString(),
        poolMinor: pool.toString(),
      };
    }

    return {
      next,
      active: event
        ? {
            id: event.id,
            poolMinor: event.pool_minor,
            minWageredMinor: event.min_wagered_minor,
            windowMinutes: event.window_minutes,
            opensAt: event.opens_at.toISOString(),
            closesAt: event.closes_at.toISOString(),
            claimants: Number(claimants?.rows[0]?.n ?? '0'),
          }
        : null,
      you,
      yourPayout: paid
        ? { eventId: paid.event_id, paidMinor: paid.paid_minor, claimants: paid.claimant_count }
        : null,
      recent: settled.rows.map((row) => ({
        id: row.id,
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

      const result = await db.transaction(async (client) => {
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
        const wagered = await wageredSince(client, config, userId, event.window_minutes);
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
      /* After the commit, so every other card refetches a claimant count that includes this one. */
      liveEvents.publish('rain');
      return result;
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
      /* A five-minute window is too short to wait for the next poll to notice it. */
      liveEvents.publish('rain');
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
        /* A tip is money leaving this account, exactly like a withdrawal. Without this, a bonus or a
         * deposit that may not be withdrawn yet could be tipped to a second account that owes
         * nothing and withdrawn from there. */
        await assertWagerRequirementMet(client, fromUserId, 'tipping');

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
