BEGIN;

-- The admin console can manage daily quest definitions at runtime. INSERT and SELECT were already
-- granted when quests shipped; UPDATE is intentionally added only now that every edit is behind
-- administrator MFA and written to the hash-chained audit log.
GRANT UPDATE ON TABLE quest_definitions TO donut_api_runtime;

-- Supersedes donut_schema_ready_v36. The gateway registers quest management routes, so it must not
-- receive traffic until the runtime role has the privilege those routes require.
CREATE FUNCTION donut_schema_ready_v37() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v37() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v37() TO donut_api_runtime;

COMMIT;
