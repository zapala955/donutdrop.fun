BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- One invite-code entry for a player who is already registered
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An invite link only counts for somebody who is signing up: the code rides on the login challenge
-- and is spent in the transaction that creates the account. A player who already has an account can
-- enter a code ONCE, from Settings (POST /v1/referrals/attach), either to set the inviter they never
-- had or to swap one that has not earned anything yet. This column is the "once": it is set in the
-- same transaction as the entry and is never cleared, so there is no second use to find.
--
-- Additive: one nullable column, no existing row touched.
ALTER TABLE users ADD COLUMN referral_entry_used_at timestamptz;

-- Supersedes donut_schema_ready_v60.
CREATE FUNCTION donut_schema_ready_v61() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v61() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v61() TO donut_api_runtime;

COMMIT;
