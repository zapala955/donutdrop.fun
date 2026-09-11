BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  minecraft_identity varchar(80) NOT NULL UNIQUE,
  minecraft_username varchar(16) NOT NULL,
  normalized_username varchar(16) NOT NULL UNIQUE,
  role varchar(16) NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin')),
  status varchar(24) NOT NULL DEFAULT 'pending_compliance'
    CHECK (status IN ('pending_compliance', 'active', 'suspended', 'self_excluded', 'closed')),
  country_code char(2),
  date_of_birth date,
  terms_accepted_at timestamptz,
  age_verified_at timestamptz,
  kyc_status varchar(16) NOT NULL DEFAULT 'not_started'
    CHECK (kyc_status IN ('not_started', 'pending', 'verified', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE auth_link_challenges (
  id uuid PRIMARY KEY,
  requested_username varchar(16) NOT NULL,
  normalized_username varchar(16) NOT NULL,
  code_hash bytea NOT NULL UNIQUE,
  browser_token_hash bytea NOT NULL UNIQUE,
  confirmed_identity varchar(80),
  confirmed_username varchar(16),
  confirmed_at timestamptz,
  completed_at timestamptz,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_link_challenges_expiry_idx ON auth_link_challenges (expires_at)
  WHERE completed_at IS NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  csrf_hash bytea NOT NULL,
  ip_hash bytea NOT NULL,
  user_agent varchar(512),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE responsible_limits (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_wager_limit_minor bigint CHECK (daily_wager_limit_minor IS NULL OR daily_wager_limit_minor > 0),
  cooldown_until timestamptz,
  self_excluded_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bot_accounts (
  id uuid PRIMARY KEY,
  username varchar(16) NOT NULL UNIQUE,
  status varchar(24) NOT NULL DEFAULT 'offline'
    CHECK (status IN ('offline', 'online', 'degraded', 'quarantined')),
  server_host varchar(255) NOT NULL,
  last_heartbeat_at timestamptz,
  last_snapshot_at timestamptz,
  reconciliation_status varchar(24) NOT NULL DEFAULT 'unknown'
    CHECK (reconciliation_status IN ('unknown', 'matched', 'mismatch')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_items (
  id uuid PRIMARY KEY,
  fingerprint char(64) NOT NULL UNIQUE CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  minecraft_name varchar(128) NOT NULL,
  display_name varchar(128) NOT NULL,
  image_url varchar(2048),
  unit_value_minor bigint NOT NULL CHECK (unit_value_minor > 0),
  enabled boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_enabled_value_idx ON catalog_items (unit_value_minor, id) WHERE enabled;

CREATE TABLE catalog_price_history (
  id uuid PRIMARY KEY,
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  old_unit_value_minor bigint,
  new_unit_value_minor bigint NOT NULL CHECK (new_unit_value_minor > 0),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  reason varchar(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_lots (
  id uuid PRIMARY KEY,
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  owner_user_id uuid REFERENCES users(id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  state varchar(24) NOT NULL DEFAULT 'available'
    CHECK (state IN ('available', 'withdrawal_pending', 'quarantined', 'withdrawn', 'consumed')),
  source_type varchar(24) NOT NULL
    CHECK (source_type IN ('deposit', 'house', 'upgrade_win', 'upgrade_stake', 'withdrawal_return', 'admin')),
  source_ref uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_owner_available_idx ON inventory_lots (owner_user_id, catalog_item_id)
  WHERE state = 'available';
CREATE INDEX inventory_house_available_idx ON inventory_lots (catalog_item_id, bot_id)
  WHERE owner_user_id IS NULL AND state = 'available';

CREATE TABLE custody_movements (
  id uuid PRIMARY KEY,
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  from_user_id uuid REFERENCES users(id),
  to_user_id uuid REFERENCES users(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  reason varchar(32) NOT NULL
    CHECK (reason IN ('deposit', 'upgrade_stake', 'upgrade_win', 'withdrawal', 'withdrawal_return', 'admin')),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custody_movements_user_idx ON custody_movements (to_user_id, created_at DESC);

CREATE TABLE deposit_intents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  deposit_code varchar(20) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled', 'manual_review')),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE withdrawals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  status varchar(24) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'manual_review')),
  idempotency_key varchar(128) NOT NULL,
  delivery_code_hash bytea NOT NULL,
  delivery_code_ciphertext text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  error_code varchar(64),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE withdrawal_lines (
  withdrawal_id uuid NOT NULL REFERENCES withdrawals(id),
  inventory_lot_id uuid NOT NULL REFERENCES inventory_lots(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (withdrawal_id, inventory_lot_id)
);

CREATE TABLE bot_jobs (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  kind varchar(32) NOT NULL CHECK (kind IN ('withdrawal', 'inventory_resync')),
  reference_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'completed', 'failed', 'dead_letter')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token_hash bytea,
  lease_expires_at timestamptz,
  last_error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, reference_id)
);
CREATE INDEX bot_jobs_claim_idx ON bot_jobs (bot_id, available_at, created_at)
  WHERE status IN ('queued', 'leased');

CREATE TABLE fairness_seeds (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  server_seed_ciphertext text NOT NULL,
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  nonce integer NOT NULL DEFAULT 0 CHECK (nonce >= 0),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fairness_one_active_per_user_idx ON fairness_seeds (user_id) WHERE used_at IS NULL;

CREATE TABLE upgrader_rounds (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  target_catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  target_inventory_lot_id uuid REFERENCES inventory_lots(id) DEFERRABLE INITIALLY DEFERRED,
  target_quantity integer NOT NULL CHECK (target_quantity > 0),
  stake_value_minor bigint NOT NULL CHECK (stake_value_minor > 0),
  target_value_minor bigint NOT NULL CHECK (target_value_minor > 0),
  house_edge_bps integer NOT NULL CHECK (house_edge_bps BETWEEN 0 AND 9999),
  chance_ppm integer NOT NULL CHECK (chance_ppm BETWEEN 0 AND 1000000),
  roll_ppm integer NOT NULL CHECK (roll_ppm BETWEEN 0 AND 999999),
  outcome varchar(8) NOT NULL CHECK (outcome IN ('win', 'lose')),
  server_seed_hash char(64) NOT NULL,
  server_seed_reveal char(64) NOT NULL,
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  rng_digest char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX upgrader_rounds_user_history_idx ON upgrader_rounds (user_id, created_at DESC);
CREATE INDEX upgrader_rounds_public_wins_idx ON upgrader_rounds (created_at DESC) WHERE outcome = 'win';

CREATE TABLE upgrader_stakes (
  round_id uuid NOT NULL REFERENCES upgrader_rounds(id),
  source_inventory_lot_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_value_minor bigint NOT NULL CHECK (unit_value_minor > 0),
  PRIMARY KEY (round_id, source_inventory_lot_id)
);

CREATE TABLE upgrader_awards (
  round_id uuid NOT NULL REFERENCES upgrader_rounds(id),
  source_inventory_lot_id uuid NOT NULL,
  awarded_inventory_lot_id uuid NOT NULL REFERENCES inventory_lots(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_value_minor bigint NOT NULL CHECK (unit_value_minor > 0),
  PRIMARY KEY (round_id, awarded_inventory_lot_id)
);

CREATE TABLE bot_inventory_snapshots (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  event_id uuid NOT NULL UNIQUE,
  totals jsonb NOT NULL,
  matched boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_snapshots_recent_idx ON bot_inventory_snapshots (bot_id, created_at DESC);

CREATE TABLE observed_bot_items (
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  minecraft_name varchar(128) NOT NULL,
  display_name varchar(256) NOT NULL,
  metadata integer NOT NULL,
  last_quantity integer NOT NULL CHECK (last_quantity >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, fingerprint)
);

CREATE TABLE inbound_bot_events (
  event_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  event_type varchar(32) NOT NULL,
  body_hash char(64) NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  action varchar(80) NOT NULL,
  target_type varchar(40) NOT NULL,
  target_id varchar(128) NOT NULL,
  details jsonb NOT NULL,
  previous_hash char(64),
  entry_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

CREATE TABLE admin_commands (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  command_type varchar(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER custody_movements_append_only
  BEFORE UPDATE OR DELETE ON custody_movements FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER upgrader_rounds_append_only
  BEFORE UPDATE OR DELETE ON upgrader_rounds FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER upgrader_stakes_append_only
  BEFORE UPDATE OR DELETE ON upgrader_stakes FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER upgrader_awards_append_only
  BEFORE UPDATE OR DELETE ON upgrader_awards FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER catalog_price_history_append_only
  BEFORE UPDATE OR DELETE ON catalog_price_history FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER admin_commands_append_only
  BEFORE UPDATE OR DELETE ON admin_commands FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER inbound_bot_events_append_only
  BEFORE UPDATE OR DELETE ON inbound_bot_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();

INSERT INTO schema_migrations (version) VALUES ('001_initial');
COMMIT;
