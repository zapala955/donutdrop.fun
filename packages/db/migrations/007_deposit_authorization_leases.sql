BEGIN;

-- A deposit handoff is authorized by one short-lived, single-use capability.
-- The capability secret itself is never stored: the API persists only its
-- SHA-256 hash and deterministically re-derives the secret for an exact retry
-- of the same journaled authorization event.
CREATE TABLE deposit_authorization_leases (
  authorization_event_id uuid PRIMARY KEY
    REFERENCES inbound_bot_events(event_id) DEFERRABLE INITIALLY DEFERRED,
  deposit_id uuid NOT NULL UNIQUE REFERENCES deposit_intents(id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  token_hash bytea NOT NULL CHECK (pg_catalog.octet_length(token_hash) = 32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + interval '150 seconds')
);
CREATE INDEX deposit_authorization_leases_expiry_idx
  ON deposit_authorization_leases (expires_at, deposit_id);

-- Authorization evidence is permanent. In particular, an expired capability
-- is never deleted to make the same deposit eligible for a second handoff.
CREATE TRIGGER deposit_authorization_leases_append_only
  BEFORE UPDATE OR DELETE ON deposit_authorization_leases
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE ALL ON TABLE deposit_authorization_leases FROM PUBLIC;
REVOKE ALL ON TABLE deposit_authorization_leases FROM donut_api_runtime;
GRANT SELECT, INSERT ON TABLE deposit_authorization_leases TO donut_api_runtime;

CREATE FUNCTION donut_schema_ready_v7() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v7() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v7() TO donut_api_runtime;

COMMIT;
