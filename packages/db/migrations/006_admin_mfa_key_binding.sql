BEGIN;

-- Bind privileged sessions to the exact TOTP key that authenticated them. A
-- secret rotation must revoke sessions created with the previous key instead
-- of merely checking that some key remains configured for the administrator.
ALTER TABLE sessions ADD COLUMN admin_mfa_key_fingerprint char(64);
ALTER TABLE sessions ADD CONSTRAINT sessions_admin_mfa_key_fingerprint_format
  CHECK (
    admin_mfa_key_fingerprint IS NULL
    OR admin_mfa_key_fingerprint ~ '^[a-f0-9]{64}$'
  );
-- Sessions issued before key binding cannot prove which MFA key was used.
UPDATE sessions
   SET revoked_at = COALESCE(revoked_at, now())
 WHERE user_id IN (SELECT id FROM users WHERE role = 'admin');

ALTER TABLE sessions ADD CONSTRAINT sessions_active_admin_mfa_key_binding
  CHECK (
    revoked_at IS NOT NULL
    OR (admin_mfa_verified_at IS NULL) = (admin_mfa_key_fingerprint IS NULL)
  );

CREATE FUNCTION donut_schema_ready_v6() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v6() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v6() TO donut_api_runtime;

COMMIT;
