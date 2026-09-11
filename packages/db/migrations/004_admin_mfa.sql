BEGIN;

ALTER TABLE users ADD COLUMN admin_totp_last_counter bigint;
ALTER TABLE users ADD CONSTRAINT users_admin_totp_counter_nonnegative
  CHECK (admin_totp_last_counter IS NULL OR admin_totp_last_counter >= 0);

ALTER TABLE sessions ADD COLUMN admin_mfa_verified_at timestamptz;

-- Existing administrator sessions predate MFA proof and must not retain
-- privileged access after this migration.
UPDATE sessions
   SET revoked_at = COALESCE(revoked_at, now())
 WHERE user_id IN (SELECT id FROM users WHERE role = 'admin');

CREATE FUNCTION donut_schema_ready_v4() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v4() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v4() TO donut_api_runtime;

COMMIT;
