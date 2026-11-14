BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- An invite's milestone counts wagers made with the invitee's own deposited money
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 089 kept the invite signup bonus ($10M) out of the inviter's milestone by giving every
-- such invite a fixed bucket of $100M (the bonus at 10x) that every wager filled first. The owner,
-- 2026-11-14: "it just assumes they lose it exactly at 100m wagered and it also makes users think
-- we are scamming so make sure they have to wager 100m with their own deposited money". A player who
-- lost the bonus in $20M of bets and then deposited saw $80M of their own wagering vanish into the
-- bucket; one who won with the bonus could go on wagering its winnings past it, and that counted.
--
-- From now on (lib/referrals.ts, accrueReferralWager) each wager counts by the share of the
-- invitee's balance that is their own deposited money. At the bonus the balance is all bonus; every
-- deposit after it adds own money, so the bonus's share falls to balance-before / balance-after of
-- that deposit, and wins and losses carry both parts alike. Read from the ledger, which records the
-- balance after every row; nothing else is stored. A player who never deposits counts nothing; one
-- who lost the bonus before depositing counts everything after.
--
-- What is stored here is only which invites the rule is for: the bonus the invitee was given.

ALTER TABLE referrals
  ADD COLUMN signup_bonus_minor bigint NOT NULL DEFAULT 0
    CONSTRAINT referrals_signup_bonus_minor_check CHECK (signup_bonus_minor >= 0);

-- The invites that were given the $10M (since 2026-11-09), found as migration 089 found them.
UPDATE referrals r
   SET signup_bonus_minor = t.amount_minor
  FROM wallet_transactions t
 WHERE t.user_id = r.referee_id AND t.kind = 'signup_bonus' AND t.amount_minor = 10000000
   AND t.created_at >= '2026-11-09T00:00:00Z';

-- Invites still on their way to the milestone are counted again by the new rule over every wager
-- since the invite, and keep whichever is higher: nobody loses progress they were shown. House
-- games count at their stake; PvP wagers (counted by their rake, which needs the configured edge)
-- are left out of this recount, and are counted as they come from here on.
WITH inflight AS (
  SELECT r.referee_id, r.created_at,
         (SELECT min(t.seq) FROM wallet_transactions t
           WHERE t.user_id = r.referee_id AND t.kind = 'signup_bonus') AS bonus_seq
    FROM referrals r
   WHERE r.signup_bonus_minor > 0 AND r.bonus_unlocked_at IS NULL AND r.voided_at IS NULL
), deposits AS (
  -- Each deposit after the bonus, and the share of the bonus it leaves (balance before / after).
  SELECT i.referee_id, t.created_at,
         CASE WHEN t.balance_after_minor <= 0 THEN 0
              ELSE (t.balance_after_minor - t.amount_minor)::numeric / t.balance_after_minor END AS keep
    FROM inflight i
    JOIN wallet_transactions t ON t.user_id = i.referee_id
   WHERE i.bonus_seq IS NOT NULL AND t.seq > i.bonus_seq
     AND t.kind IN ('cash_deposit', 'pay_login_deposit')
), counted AS (
  SELECT i.referee_id,
         floor(sum(e.amount_minor * (1 - coalesce((
           SELECT CASE WHEN bool_or(d.keep = 0) THEN 0
                       ELSE exp(sum(ln(greatest(d.keep, 1e-30)))) END
             FROM deposits d
            WHERE d.referee_id = i.referee_id AND d.created_at < e.created_at
         ), 1))))::bigint AS own_minor
    FROM inflight i
    JOIN wager_events e ON e.user_id = i.referee_id AND e.created_at >= i.created_at
   WHERE e.source NOT IN ('coinflip', 'mines_duel', 'slither_arena')
   GROUP BY i.referee_id
)
UPDATE referrals r
   SET wagered_minor = c.own_minor,
       updated_at = now()
  FROM counted c
 WHERE r.referee_id = c.referee_id AND c.own_minor > r.wagered_minor;

-- The bucket is retired: nothing reads it any more.
UPDATE referrals SET signup_bonus_wager_left_minor = 0 WHERE signup_bonus_wager_left_minor <> 0;

-- Supersedes donut_schema_ready_v94.
CREATE FUNCTION donut_schema_ready_v95() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v95() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v95() TO donut_api_runtime;

COMMIT;
