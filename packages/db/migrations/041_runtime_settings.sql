BEGIN;

-- Non-secret operational settings that an authenticated administrator may change without a
-- deployment. Trust roots (keys, credentials, origins and game outcome maths) deliberately do
-- not belong here. The API owns the allow-list and validation; this table provides persistence,
-- attribution and a small, reviewable surface for the runtime role.
CREATE TABLE runtime_settings (
  key varchar(64) PRIMARY KEY CHECK (key ~ '^[a-z][A-Za-z0-9]{1,63}$'),
  value jsonb NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(value) IN ('boolean', 'number', 'string'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE runtime_settings TO donut_api_runtime;

-- Supersedes donut_schema_ready_v40. Runtime settings are loaded before public routes are served,
-- so an API build expecting them must not become ready against an older database.
CREATE FUNCTION donut_schema_ready_v41() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v41() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v41() TO donut_api_runtime;

COMMIT;
