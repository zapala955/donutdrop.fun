BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Voiding a referral
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A referral programme pays for signups, so it attracts the people who are best at manufacturing
-- them. Until now an administrator who found a ring of self-referrals had nothing to do about it:
-- the relationship is a row keyed on the referee, the accrual paths read that row, and there was
-- no way to stop one paying out short of deleting it.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- MARKED, NOT DELETED
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Deleting the row would stop the accrual and destroy the evidence in the same statement --
-- who referred whom, when, and how much had already been earned on it. That is exactly backwards
-- for a fraud control: the case for the decision has to outlive the decision. A voided referral
-- keeps its row, its counters and its history, and simply stops earning.
--
-- `referral_earnings` and `referral_claims` are untouched by design. They are append-only records
-- of money that really was paid, and a void is not a reversal -- reclaiming it is a deliberate,
-- separately audited wallet adjustment, not a side effect of flipping a flag.
ALTER TABLE referrals
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES users(id),
  ADD COLUMN void_reason varchar(256);

-- Recorded together or not at all, so a voided referral can always name who voided it and why.
-- The same shape cash_withdrawals uses for its approvals.
ALTER TABLE referrals
  ADD CONSTRAINT referrals_void_recorded_together
    CHECK (num_nonnulls(voided_at, voided_by, void_reason) IN (0, 3));

-- The admin console lists what is still live and what has been stopped, and the programme's own
-- accrual paths filter on it in the hot path of every settled wager.
CREATE INDEX referrals_live_idx ON referrals (referrer_id) WHERE voided_at IS NULL;

-- Supersedes donut_schema_ready_v44. An API build that refuses to pay a voided referral must not
-- serve against a database with no column to refuse on -- it would pay every one of them.
CREATE FUNCTION donut_schema_ready_v45() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v45() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v45() TO donut_api_runtime;

COMMIT;
