BEGIN;

-- Readiness calls a versioned, owner-controlled marker instead of merely
-- checking whether PostgreSQL accepts connections. If this migration is absent,
-- an API built for schema v3 stays out of load-balancer rotation.
CREATE FUNCTION donut_schema_ready_v3() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v3() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v3() TO donut_api_runtime;

COMMIT;
