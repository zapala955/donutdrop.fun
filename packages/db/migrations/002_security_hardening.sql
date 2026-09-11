-- Request hashes bind idempotency keys to their original payload. Historical
-- rows cannot be reconstructed, so they receive an impossible sentinel hash;
-- replaying one safely returns an idempotency conflict.
ALTER TABLE upgrader_rounds
  ADD COLUMN request_hash char(64) NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE upgrader_rounds ALTER COLUMN request_hash DROP DEFAULT;
ALTER TABLE upgrader_rounds ADD CONSTRAINT upgrader_rounds_request_hash_format
  CHECK (request_hash ~ '^[a-f0-9]{64}$');

ALTER TABLE deposit_intents ADD CONSTRAINT deposit_intents_request_hash_format
  CHECK (request_hash ~ '^[a-f0-9]{64}$');

-- A link code is valid only for the bot selected by the browser flow. Pending
-- challenges created by the older schema cannot be attributed safely, so they
-- are invalidated during this deployment instead of being accepted by any bot.
ALTER TABLE auth_link_challenges
  ADD COLUMN bot_id uuid REFERENCES bot_accounts(id);
DELETE FROM auth_link_challenges WHERE completed_at IS NULL;
ALTER TABLE auth_link_challenges ADD CONSTRAINT auth_link_challenge_bot_bound
  CHECK (completed_at IS NOT NULL OR bot_id IS NOT NULL);

ALTER TABLE withdrawals
  ADD COLUMN request_hash char(64) NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE withdrawals ALTER COLUMN request_hash DROP DEFAULT;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_request_hash_format
  CHECK (request_hash ~ '^[a-f0-9]{64}$');

-- Transfer operations remain fail-closed until a currently authenticated bot
-- explicitly advertises a reviewed transfer implementation.
ALTER TABLE bot_accounts ADD COLUMN transfer_capable boolean NOT NULL DEFAULT false;

-- Store replay metadata for claim retries. Lease tokens are deterministically
-- re-derived by the API and are never persisted in plaintext.
ALTER TABLE inbound_bot_events ADD COLUMN response_body jsonb;

-- Audit rows carry the signing-key version so old entries remain verifiable
-- after a controlled HMAC key rotation. Rows created before this migration use
-- the legacy payload format, which did not include keyId in the HMAC input.
ALTER TABLE audit_log
  ADD COLUMN key_id varchar(64) NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE audit_log ALTER COLUMN key_id DROP DEFAULT;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_key_id_format
  CHECK (key_id ~ '^[A-Za-z0-9._-]{1,64}$');
ALTER TABLE audit_log ADD COLUMN sequence_no bigint;
-- The legacy audit table is append-only even to the migration owner. Disable
-- its guard only inside this atomic migration while deriving immutable order
-- from the signed predecessor chain; rollback restores the trigger on failure.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only;
WITH RECURSIVE ordered AS (
  SELECT id, entry_hash, 1::bigint AS sequence_no
  FROM audit_log
  WHERE previous_hash IS NULL
  UNION ALL
  SELECT child.id, child.entry_hash, parent.sequence_no + 1
  FROM ordered parent
  JOIN audit_log child ON child.previous_hash = parent.entry_hash
)
UPDATE audit_log SET sequence_no = ordered.sequence_no
FROM ordered WHERE audit_log.id = ordered.id;
ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only;
ALTER TABLE audit_log ALTER COLUMN sequence_no SET NOT NULL;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_sequence_positive CHECK (sequence_no > 0);
ALTER TABLE audit_log ADD CONSTRAINT audit_log_sequence_unique UNIQUE (sequence_no);
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entry_hash_format
  CHECK (entry_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE audit_log ADD CONSTRAINT audit_log_previous_hash_format
  CHECK (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX audit_log_one_successor_idx
  ON audit_log (previous_hash) WHERE previous_hash IS NOT NULL;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_previous_hash_exists
  FOREIGN KEY (previous_hash) REFERENCES audit_log(entry_hash)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION enforce_audit_chain_insert() RETURNS trigger AS $$
DECLARE
  expected_previous char(64);
BEGIN
  IF NEW.key_id = 'legacy-v1' THEN
    RAISE EXCEPTION 'legacy-v1 is reserved for pre-hardening audit entries';
  END IF;
  IF NEW.sequence_no <= 0 THEN
    RAISE EXCEPTION 'audit sequence must be positive';
  ELSIF NEW.sequence_no = 1 THEN
    PERFORM 1 FROM public.audit_log LIMIT 1;
    IF FOUND OR NEW.previous_hash IS NOT NULL THEN
      RAISE EXCEPTION 'first audit entry has an invalid predecessor';
    END IF;
  ELSE
    SELECT entry_hash INTO expected_previous
      FROM public.audit_log WHERE sequence_no = NEW.sequence_no - 1;
    IF NOT FOUND OR NEW.previous_hash IS DISTINCT FROM expected_previous THEN
      RAISE EXCEPTION 'audit predecessor does not match the prior sequence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE TRIGGER audit_log_chain_insert
  BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION enforce_audit_chain_insert();

ALTER TABLE admin_commands
  ADD COLUMN request_hash char(64) NOT NULL DEFAULT repeat('0', 64);
ALTER TABLE admin_commands ALTER COLUMN request_hash DROP DEFAULT;
ALTER TABLE admin_commands ADD CONSTRAINT admin_commands_request_hash_format
  CHECK (request_hash ~ '^[a-f0-9]{64}$');

CREATE INDEX custody_movements_from_user_idx
  ON custody_movements (from_user_id, created_at DESC);

-- Cluster roles are provisioned by the privileged one-time database bootstrap;
-- the migration owner is deliberately not a superuser or CREATEROLE member.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_api_runtime') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
      CREATE ROLE donut_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ELSE
      RAISE EXCEPTION 'donut_api_runtime must be provisioned by the database bootstrap';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_audit_reader') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
      CREATE ROLE donut_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ELSE
      RAISE EXCEPTION 'donut_audit_reader must be provisioned by the database bootstrap';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('donut_api_runtime', 'donut_audit_reader')
      AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
           OR r.rolinherit OR r.rolbypassrls)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
    WHERE r.rolname IN ('donut_api_runtime', 'donut_audit_reader')
  ) THEN
    RAISE EXCEPTION 'Donut application group role has unsafe attributes or memberships';
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM donut_api_runtime;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM donut_audit_reader;
GRANT USAGE ON SCHEMA public TO donut_api_runtime;
GRANT USAGE ON SCHEMA public TO donut_audit_reader;

DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO donut_api_runtime', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO donut_audit_reader', current_database());
END
$$;

GRANT SELECT ON
  users, auth_link_challenges, sessions, responsible_limits, bot_accounts,
  catalog_items, catalog_price_history, inventory_lots, custody_movements,
  deposit_intents, withdrawals, withdrawal_lines, bot_jobs, fairness_seeds,
  upgrader_rounds, upgrader_stakes, upgrader_awards, bot_inventory_snapshots,
  observed_bot_items, inbound_bot_events, audit_log, admin_commands
TO donut_api_runtime;

GRANT INSERT ON
  users, auth_link_challenges, sessions, responsible_limits, bot_accounts,
  catalog_items, catalog_price_history, inventory_lots, custody_movements,
  deposit_intents, withdrawals, withdrawal_lines, bot_jobs, fairness_seeds,
  upgrader_rounds, upgrader_stakes, upgrader_awards, bot_inventory_snapshots,
  observed_bot_items, inbound_bot_events, audit_log, admin_commands
TO donut_api_runtime;

GRANT UPDATE ON
  users, auth_link_challenges, sessions, responsible_limits, bot_accounts,
  catalog_items, inventory_lots, deposit_intents, withdrawals, bot_jobs,
  fairness_seeds, observed_bot_items
TO donut_api_runtime;

-- Maintenance may remove only expired authentication material. Custody,
-- gameplay, bot-event, and audit records remain non-deletable by the API role.
GRANT DELETE ON sessions, auth_link_challenges TO donut_api_runtime;

-- The checkpoint verifier cannot write application state even if every audit
-- verification key is present in its process.
GRANT SELECT ON audit_log TO donut_audit_reader;
