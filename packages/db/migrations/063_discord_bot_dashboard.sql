BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The Discord bot's welcome DM and /test, configured from the admin dashboard
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two per-server settings the community bot reads every time it needs them, so a change in the
-- dashboard takes effect at once and nothing is restarted:
--
--   welcome_dm_enabled  whether new members get the welcome DM. On by default. WELCOME_DM_ENABLED=false
--                       in the bot's environment is still a hard off above this switch.
--   test_owner_ids      Discord user ids, besides the server's owner and the bot application's
--                       owner, who may run /test (which DMs the welcome message to the owners as a
--                       test). Comma-separated and empty by default. The constraint is the same rule
--                       the dashboard enforces: whole ids only, no spaces, no blanks.
--
-- Additive: two columns with defaults, no existing row rewritten except to fill them. The table's
-- grants already cover them.
ALTER TABLE discord_guild_settings
  ADD COLUMN welcome_dm_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN test_owner_ids varchar(660) NOT NULL DEFAULT ''
    CONSTRAINT discord_guild_test_owner_ids_shape
    CHECK (test_owner_ids ~ '^([0-9]{5,32}(,[0-9]{5,32})*)?$');

-- Supersedes donut_schema_ready_v62.
CREATE FUNCTION donut_schema_ready_v63() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v63() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v63() TO donut_api_runtime;

COMMIT;
