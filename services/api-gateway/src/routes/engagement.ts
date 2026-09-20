import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { createAuthGuards } from '../lib/auth.js';
import { creditWallet, streakRewardMinor } from '../lib/cash-settlement.js';
import {
  dailyRewardWagerProgress,
  requireDailyRewardWager,
} from '../lib/daily-rewards.js';
import type { Database } from '../lib/db.js';
import { AppError, conflict } from '../lib/errors.js';
import { parseWith } from '../lib/validation.js';

/**
 * Quests, daily streaks, and the faction war.
 *
 * Everything here pays real balance, so every claim goes through the same wallet ledger as a case
 * win and every one of them is idempotent on a natural key rather than on a client-supplied id:
 * a quest is claimed once per day, a streak once per day, a faction payout once per event. A
 * retried request finds the existing row instead of paying twice.
 */

const claimQuestSchema = z.object({ questCode: z.string().regex(/^[a-z0-9_]{1,48}$/) }).strict();
const joinFactionSchema = z.object({ factionId: z.uuid() }).strict();

interface QuestRow {
  code: string;
  name: string;
  description: string;
  metric: string;
  target_value: string;
  reward_minor: string;
  sort_order: number;
  progress_value: string | null;
  claimed_at: Date | null;
  claimed_reward_minor: string | null;
}

interface StreakRow {
  current_streak: number;
  longest_streak: number;
  last_claim_day: string | null;
  total_claims: number;
}

export async function registerEngagementRoutes(
  app: FastifyInstance,
  db: Database,
  config: AppConfig,
) {
  const guards = createAuthGuards(db, config);

  // ── quests ────────────────────────────────────────────────────────────────

  app.get('/v1/quests', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const result = await db.query<QuestRow>(
      `SELECT q.code, q.name, q.description, q.metric, q.target_value, q.reward_minor,
              q.sort_order, p.progress_value, p.claimed_at, p.claimed_reward_minor
         FROM quest_definitions q
         LEFT JOIN quest_progress p
           ON p.quest_code = q.code AND p.user_id = $1
          AND p.quest_day = (now() AT TIME ZONE 'utc')::date
        WHERE q.enabled
        ORDER BY q.sort_order, q.code`,
      [userId],
    );

    const quests = result.rows.map((row) => {
      const progress = BigInt(row.progress_value ?? '0');
      const target = BigInt(row.target_value);
      const complete = progress >= target;
      return {
        code: row.code,
        name: row.name,
        description: row.description,
        metric: row.metric,
        targetValue: row.target_value,
        rewardMinor: row.reward_minor,
        progressValue: progress.toString(),
        // Clamped so a metric that overshot its target cannot render a bar past 100%.
        progressRatio: target > 0n ? Math.min(1, Number(progress) / Number(target)) : 0,
        complete,
        claimed: !!row.claimed_at,
        claimable: complete && !row.claimed_at,
        claimedAt: row.claimed_at,
        claimedRewardMinor: row.claimed_reward_minor,
      };
    });

    return {
      quests,
      // The UTC day these counters belong to, so the client can show an honest reset countdown.
      questDay: new Date().toISOString().slice(0, 10),
      claimableCount: quests.filter((quest) => quest.claimable).length,
    };
  });

  app.post(
    '/v1/quests/claim',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseWith(claimQuestSchema, request.body);
      const userId = requireUserId(request.authUser?.id);

      const claimed = await db.transaction(async (client) => {
        /* The progress row is locked, and the claim is recorded on it. That row is unique on
         * (user, quest, day), so it is the idempotency key: a second claim finds claimed_at
         * already set and is refused rather than paying again. */
        const progress = await client.query<{
          progress_value: string;
          claimed_at: Date | null;
          target_value: string;
          reward_minor: string;
        }>(
          `SELECT p.progress_value, p.claimed_at, q.target_value, q.reward_minor
             FROM quest_progress p JOIN quest_definitions q ON q.code = p.quest_code
            WHERE p.user_id = $1 AND p.quest_code = $2
              AND p.quest_day = (now() AT TIME ZONE 'utc')::date
              AND q.enabled
            FOR UPDATE OF p`,
          [userId, body.questCode],
        );
        const row = progress.rows[0];
        if (!row) throw new AppError(404, 'QUEST_NOT_STARTED', 'No progress on that quest today');
        if (row.claimed_at) conflict('QUEST_ALREADY_CLAIMED', 'That quest is already claimed');
        if (BigInt(row.progress_value) < BigInt(row.target_value)) {
          throw new AppError(409, 'QUEST_INCOMPLETE', 'That quest is not complete yet');
        }

        const reward = BigInt(row.reward_minor);
        const balanceAfter = await creditWallet(
          client,
          userId,
          reward,
          'quest_reward',
          questReferenceId(userId, body.questCode),
        );
        await client.query(
          `UPDATE quest_progress
              SET claimed_at = now(), claimed_reward_minor = $3, balance_after_minor = $4,
                  updated_at = now()
            WHERE user_id = $1 AND quest_code = $2
              AND quest_day = (now() AT TIME ZONE 'utc')::date`,
          [userId, body.questCode, reward.toString(), balanceAfter],
        );
        return { rewardMinor: reward.toString(), balanceAfterMinor: balanceAfter };
      });

      return reply.code(201).send(claimed);
    },
  );

  // ── daily streak ──────────────────────────────────────────────────────────

  app.get('/v1/streak', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const [result, wager] = await Promise.all([
      db.query<StreakRow>(
        `SELECT current_streak, longest_streak, last_claim_day::text AS last_claim_day, total_claims
           FROM user_streaks WHERE user_id = $1`,
        [userId],
      ),
      dailyRewardWagerProgress(db, config, userId),
    ]);
    const row = result.rows[0];
    const today = utcDay();
    const claimedToday = row?.last_claim_day === today;
    const nextLength = claimedToday
      ? (row?.current_streak ?? 0)
      : projectedStreak(row?.last_claim_day ?? null, row?.current_streak ?? 0);

    return {
      currentStreak: row?.current_streak ?? 0,
      longestStreak: row?.longest_streak ?? 0,
      totalClaims: row?.total_claims ?? 0,
      lastClaimDay: row?.last_claim_day ?? null,
      claimedToday,
      claimable: !claimedToday && wager.met,
      wageredTodayMinor: wager.wageredMinor.toString(),
      wagerRequirementMinor: wager.requiredMinor.toString(),
      wagerRemainingMinor: wager.remainingMinor.toString(),
      wagerRequirementMet: wager.met,
      wagerProgressRatio:
        wager.requiredMinor > 0n
          ? Math.min(1, Number(wager.wageredMinor) / Number(wager.requiredMinor))
          : 1,
      nextStreakLength: nextLength,
      nextRewardMinor: streakRewardMinor(config, nextLength).toString(),
      maxMultiplier: config.streakMaxMultiplier,
      baseRewardMinor: config.streakBaseRewardMinor.toString(),
    };
  });

  app.post(
    '/v1/streak/claim',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const userId = requireUserId(request.authUser?.id);

      const claimed = await db.transaction(async (client) => {
        await client.query(
          'INSERT INTO user_streaks(user_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [userId],
        );
        const current = await client.query<StreakRow>(
          `SELECT current_streak, longest_streak, last_claim_day::text AS last_claim_day,
                  total_claims
             FROM user_streaks WHERE user_id = $1 FOR UPDATE`,
          [userId],
        );
        const row = current.rows[0];
        if (!row) throw new Error('Streak row missing after insert');

        const today = utcDay();
        if (row.last_claim_day === today) {
          conflict('STREAK_ALREADY_CLAIMED', 'Today is already claimed');
        }

        // This check is inside the same transaction as the wallet credit. A client cannot unlock
        // the button locally, and a wager only counts after its own settlement has committed.
        await requireDailyRewardWager(client, config, userId);

        /* A streak continues only if yesterday was claimed. Any longer gap starts again at one —
         * that is what makes it a streak rather than a counter. */
        const nextStreak = projectedStreak(row.last_claim_day, row.current_streak);
        const reward = streakRewardMinor(config, nextStreak);
        const balanceAfter = await creditWallet(
          client,
          userId,
          reward,
          'streak_reward',
          streakReferenceId(userId, today),
        );

        await client.query(
          `UPDATE user_streaks
              SET current_streak = $2,
                  longest_streak = GREATEST(longest_streak, $2),
                  last_claim_day = $3::date,
                  total_claims = total_claims + 1,
                  updated_at = now()
            WHERE user_id = $1`,
          [userId, nextStreak, today],
        );
        await client.query(
          `INSERT INTO streak_claims
             (id, user_id, claim_day, streak_length, reward_minor, balance_after_minor)
           VALUES ($1, $2, $3::date, $4, $5, $6)`,
          [randomUUID(), userId, today, nextStreak, reward.toString(), balanceAfter],
        );

        return {
          streakLength: nextStreak,
          rewardMinor: reward.toString(),
          balanceAfterMinor: balanceAfter,
        };
      });

      return reply.code(201).send(claimed);
    },
  );

  // ── faction war ───────────────────────────────────────────────────────────

  app.get('/v1/factions', { preHandler: guards.authenticate }, async (request) => {
    const userId = requireUserId(request.authUser?.id);
    const eventResult = await db.query<{
      id: string;
      slug: string;
      name: string;
      description: string;
      prize_pool_minor: string;
      starts_at: Date;
      ends_at: Date;
      settled_at: Date | null;
    }>(
      `SELECT id, slug, name, description, prize_pool_minor, starts_at, ends_at, settled_at
         FROM faction_events
        WHERE settled_at IS NULL AND now() < ends_at
        ORDER BY starts_at LIMIT 1`,
    );
    const event = eventResult.rows[0];
    if (!event) return { event: null, factions: [], membership: null, leaderboard: [] };

    const factionResult = await db.query<{
      id: string;
      code: string;
      name: string;
      color: string;
      blurb: string;
      total_minor: string;
      member_count: string;
    }>(
      `SELECT f.id, f.code, f.name, f.color, f.blurb,
              COALESCE(c.total_minor, 0)::text AS total_minor,
              COALESCE(m.member_count, 0)::text AS member_count
         FROM factions f
         LEFT JOIN (
           SELECT faction_id, sum(amount_minor) AS total_minor
             FROM faction_contributions WHERE event_id = $1 GROUP BY faction_id
         ) c ON c.faction_id = f.id
         LEFT JOIN (
           SELECT faction_id, count(*) AS member_count
             FROM faction_members WHERE event_id = $1 GROUP BY faction_id
         ) m ON m.faction_id = f.id
        WHERE f.event_id = $1
        ORDER BY f.code`,
      [event.id],
    );

    const totals = factionResult.rows.map((row) => BigInt(row.total_minor));
    const grand = totals.reduce((sum, value) => sum + value, 0n);

    const membershipResult = await db.query<{ faction_id: string; contributed: string }>(
      `SELECT m.faction_id,
              COALESCE((
                SELECT sum(amount_minor) FROM faction_contributions
                 WHERE event_id = $1 AND user_id = $2
              ), 0)::text AS contributed
         FROM faction_members m WHERE m.event_id = $1 AND m.user_id = $2`,
      [event.id, userId],
    );

    const leaderboard = await db.query<{
      user_id: string;
      faction_id: string;
      total_minor: string;
      player: string;
    }>(
      `SELECT c.user_id, c.faction_id, sum(c.amount_minor)::text AS total_minor,
              'Player-' || upper(substr(md5(c.user_id::text), 1, 6)) AS player
         FROM faction_contributions c
        WHERE c.event_id = $1
        GROUP BY c.user_id, c.faction_id
        ORDER BY sum(c.amount_minor) DESC
        LIMIT 25`,
      [event.id],
    );

    return {
      event: {
        id: event.id,
        slug: event.slug,
        name: event.name,
        description: event.description,
        prizePoolMinor: event.prize_pool_minor,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        totalContributedMinor: grand.toString(),
      },
      factions: factionResult.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        color: row.color,
        blurb: row.blurb,
        totalMinor: row.total_minor,
        memberCount: Number(row.member_count),
        /* Share of everything contributed so far. With nothing contributed the bars sit at zero
         * rather than splitting three ways, because an even split would imply a dead heat that
         * nobody has actually played for. */
        share: grand > 0n ? Number(BigInt(row.total_minor)) / Number(grand) : 0,
      })),
      membership: membershipResult.rows[0]
        ? {
            factionId: membershipResult.rows[0].faction_id,
            contributedMinor: membershipResult.rows[0].contributed,
          }
        : null,
      leaderboard: leaderboard.rows.map((row) => ({
        player: row.player,
        factionId: row.faction_id,
        totalMinor: row.total_minor,
        isYou: row.user_id === userId,
      })),
    };
  });

  app.post(
    '/v1/factions/join',
    { preHandler: guards.requireCsrf, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = parseWith(joinFactionSchema, request.body);
      const userId = requireUserId(request.authUser?.id);

      const joined = await db.transaction(async (client) => {
        const faction = await client.query<{ id: string; event_id: string; name: string }>(
          `SELECT f.id, f.event_id, f.name
             FROM factions f JOIN faction_events e ON e.id = f.event_id
            WHERE f.id = $1 AND e.settled_at IS NULL
              AND now() >= e.starts_at AND now() < e.ends_at`,
          [body.factionId],
        );
        const row = faction.rows[0];
        if (!row) throw new AppError(404, 'FACTION_NOT_FOUND', 'That faction is not in a live war');

        /* One team per player per event, and no switching. A player who could move to whichever
         * side is winning makes every leaderboard and every payout meaningless. */
        const inserted = await client.query<{ faction_id: string }>(
          `INSERT INTO faction_members (event_id, user_id, faction_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (event_id, user_id) DO NOTHING
           RETURNING faction_id`,
          [row.event_id, userId, row.id],
        );
        if (!inserted.rows[0]) {
          const existing = await client.query<{ faction_id: string }>(
            'SELECT faction_id FROM faction_members WHERE event_id = $1 AND user_id = $2',
            [row.event_id, userId],
          );
          const current = existing.rows[0];
          if (current && current.faction_id !== row.id) {
            conflict('FACTION_LOCKED', 'You have already picked a side for this war');
          }
          return { factionId: row.id, eventId: row.event_id, alreadyJoined: true };
        }
        return { factionId: row.id, eventId: row.event_id, alreadyJoined: false };
      });

      return reply.code(joined.alreadyJoined ? 200 : 201).send(joined);
    },
  );
}

/** UTC day as YYYY-MM-DD. Everything daily in this file agrees on this definition of a day. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What the streak becomes if it is claimed now: one longer if yesterday was claimed, otherwise
 * back to one. Never continues across a gap.
 */
function projectedStreak(lastClaimDay: string | null, currentStreak: number): number {
  if (!lastClaimDay) return 1;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return lastClaimDay === yesterday ? currentStreak + 1 : 1;
}

/* wallet_transactions is unique on (kind, reference_id), and a quest or streak claim has no round
 * id of its own. Deriving a stable uuid from the natural key makes that uniqueness constraint the
 * thing that stops a double payout, rather than hoping the caller sends a fresh idempotency key. */
function questReferenceId(userId: string, questCode: string): string {
  return deterministicUuid(`quest:${userId}:${questCode}:${utcDay()}`);
}

function streakReferenceId(userId: string, day: string): string {
  return deterministicUuid(`streak:${userId}:${day}`);
}

function deterministicUuid(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  const characters = digest.slice(0, 32).split('');
  characters[12] = '4';
  characters[16] = '8';
  const hex = characters.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function requireUserId(value: string | undefined): string {
  if (!value) throw new AppError(401, 'AUTH_REQUIRED', 'Authentication is required');
  return value;
}
