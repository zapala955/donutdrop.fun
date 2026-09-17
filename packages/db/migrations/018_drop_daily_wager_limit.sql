BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Remove the daily wager limit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Both halves of the cap are gone, by explicit product decision:
--
--   * the platform-wide ceiling (MAX_DAILY_WAGER_MINOR), and
--   * the per-player self-set limit stored in this column.
--
-- The column is DROPPED rather than left in place unread. A column named
-- `daily_wager_limit_minor` that nothing enforces is worse than no column at all: it reads as a
-- live control to anyone auditing the schema, and it is exactly the kind of field somebody re-wires
-- later believing it still works. If the cap ever returns it should return as a new, deliberate
-- migration rather than by reviving a value nobody has maintained.
--
-- This is destructive and irreversible: any limit a player had set for themselves is discarded
-- with the column.
--
-- WHAT REMAINS. Only the turnover cap has been removed. Every other responsible-play and
-- compliance gate in assertGameEligible is untouched and still enforced on every wager:
--
--   * account status must be 'active'
--   * age verification, terms acceptance and country of residence must be recorded
--   * KYC must be 'verified'
--   * the country must be inside ALLOWED_COUNTRIES
--   * an active cooldown blocks play      (responsible_limits.cooldown_until)
--   * self-exclusion blocks play          (responsible_limits.self_excluded_until)
--
-- Those two timestamp columns stay, and cooldown_until still only ever moves forward.
ALTER TABLE responsible_limits DROP COLUMN daily_wager_limit_minor;

-- Supersedes donut_schema_ready_v17.
CREATE FUNCTION donut_schema_ready_v18() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v18() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v18() TO donut_api_runtime;

COMMIT;
