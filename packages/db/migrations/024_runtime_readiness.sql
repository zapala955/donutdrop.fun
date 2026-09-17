BEGIN;

-- Migrations 020-023 added the duel, Slither, social and Discord-control schemas after the last
-- runtime marker. The API uses all four groups, so reporting ready against v19 could admit traffic
-- while a partial deploy was still missing tables. Existence of this marker proves the migrator
-- committed every preceding migration in the same ordered chain.
CREATE FUNCTION donut_schema_ready_v24() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v24() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v24() TO donut_api_runtime;

COMMIT;
