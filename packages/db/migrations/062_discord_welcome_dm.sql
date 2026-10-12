BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The welcome DM: once per member, ever
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The community bot sends a new member one direct message with the website, how to link, the server
-- tag and how to invite friends. "Once" has to survive a leave and a rejoin, or leaving and coming
-- back would be a way to make the bot message somebody over and over. discord_invited_members is
-- already one row per member rather than one per join (see migration 047), so the mark lives there:
-- the bot claims it with a single guarded statement BEFORE it sends, which means two joins racing
-- each other send one message, and a member whose DMs are closed is not retried either.
--
-- Additive: one nullable column, no existing row touched. The table's grants already cover it.
ALTER TABLE discord_invited_members ADD COLUMN welcomed_at timestamptz;

-- Supersedes donut_schema_ready_v61.
CREATE FUNCTION donut_schema_ready_v62() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v62() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v62() TO donut_api_runtime;

COMMIT;
