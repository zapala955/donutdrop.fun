BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The invite signup bonus's wagering does not count toward the inviter's milestone
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player who joins on an invite is given the invite signup bonus ($10M) with a requirement to
-- wager it (10x, $100M) before it can leave (routes/auth.ts). That wagering is the bonus going
-- round, not the player's own money, and it used to count toward the inviter's milestone ($50M at
-- $100M wagered): at a 10% edge $10M is expected to turn over about $100M before it is gone, so a
-- fresh account could reach the milestone on the bonus alone. The operator's rule, 2026-11-09: the
-- join bonus does not count.
--
-- So each referral keeps what is left of the bonus's wagering. Every counted wager goes to it first
-- and only the rest to wagered_minor, the milestone's progress (lib/referrals.ts,
-- accrueReferralWager). Set at signup, to the requirement the bonus came with; 0 for everybody else.
ALTER TABLE referrals
  ADD COLUMN signup_bonus_wager_left_minor bigint NOT NULL DEFAULT 0
    CONSTRAINT referrals_signup_bonus_wager_left_check CHECK (signup_bonus_wager_left_minor >= 0);

-- Invites already paid the $10M (it began on 2026-11-09, at 10x) and not yet at their milestone:
-- what they have wagered so far went to the bonus first. A milestone already paid stays paid.
UPDATE referrals r
   SET signup_bonus_wager_left_minor = greatest(0, b.bonus_wager - r.wagered_minor),
       wagered_minor = greatest(0, r.wagered_minor - b.bonus_wager),
       updated_at = now()
  FROM (SELECT t.reference_id AS referee_id, t.amount_minor * 10 AS bonus_wager
          FROM wallet_transactions t
         WHERE t.kind = 'signup_bonus' AND t.amount_minor = 10000000
           AND t.created_at >= '2026-11-09T00:00:00Z') b
 WHERE r.referee_id = b.referee_id AND r.bonus_unlocked_at IS NULL;

-- Supersedes donut_schema_ready_v88.
CREATE FUNCTION donut_schema_ready_v89() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v89() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v89() TO donut_api_runtime;

COMMIT;
