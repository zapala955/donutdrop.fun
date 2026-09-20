BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Remove the real-money compliance apparatus.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Self-exclusion, cooldowns, KYC, age verification and country restriction all existed because
-- this platform was written so that it COULD be run as a real-money casino, where every one of
-- them is a licensing condition. It settles in DonutSMP dollars. `GAME_CURRENCY_ONLY` had already
-- switched most of it off in production, which left a flag with one possible value and a set of
-- code paths nobody ran.
--
-- Suspension and closure are not part of this and are untouched. An operator stopping an account
-- was never a compliance control; it is moderation, and it is the only account state left.
--
-- ── ORDER MATTERS, AND THIS IS THE PART THAT CAN TAKE A SITE DOWN ──
--
-- `users.status` has a CHECK listing the statuses it allows, and rows exist carrying the two values
-- being removed. Postgres validates a new CHECK against every row already in the table, so writing
-- the narrower constraint first fails on exactly the databases that have any of those rows — which
-- is what migration 030 did, in production, with an outage. The rows are moved FIRST and the
-- constraint is narrowed after.
--
-- 'pending_compliance' becomes 'active': the profile they were waiting to complete no longer
-- exists, so waiting is not a state they can be in.
--
-- 'self_excluded' becomes 'active' too, and that deserves to be said plainly rather than buried in
-- a column list. These are accounts that asked to be locked out. The feature is being removed on
-- the operator's decision that in-game currency does not warrant it, and the consequence is that
-- those accounts can play again. Nothing here can make that choice reversible, and it should not
-- look like a side effect of a type change.
UPDATE users SET status = 'active', updated_at = now()
 WHERE status IN ('pending_compliance', 'self_excluded');

ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users
  ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'closed'));

-- The profile itself. `date_of_birth` in particular is dropped rather than retained: a Minecraft
-- minigame site holding birth dates is a liability with nothing left that reads it.
ALTER TABLE users
  DROP COLUMN country_code,
  DROP COLUMN date_of_birth,
  DROP COLUMN age_verified_at,
  DROP COLUMN kyc_status;

-- `terms_accepted_at` stays. Agreeing to the site's terms is not compliance theatre, the signup
-- form still asks for it, and a record that somebody accepted them is worth keeping whatever the
-- currency is.

-- Cooldowns and self-exclusion windows lived here and nothing else did. The table goes whole.
DROP TABLE responsible_limits;

-- Supersedes donut_schema_ready_v35. The readiness probe names the exact schema the running API
-- expects, so a gateway still selecting kyc_status cannot take traffic against a database that no
-- longer has the column.
CREATE FUNCTION donut_schema_ready_v36() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v36() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v36() TO donut_api_runtime;

COMMIT;
