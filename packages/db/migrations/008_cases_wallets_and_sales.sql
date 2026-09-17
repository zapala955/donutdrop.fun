BEGIN;

-- The on-site wallet is an integer ledger denominated in the same fixed valuation units as
-- catalog items. The mutable balance is only a cached total; every change is also written to the
-- append-only wallet_transactions table in the same serializable transaction.
CREATE TABLE user_wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id uuid PRIMARY KEY,
  slug varchar(64) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name varchar(128) NOT NULL,
  description varchar(512) NOT NULL DEFAULT '',
  image_url varchar(2048),
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  enabled boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_enabled_price_idx ON cases (price_minor, id) WHERE enabled;

CREATE TABLE case_items (
  case_id uuid NOT NULL REFERENCES cases(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  weight integer NOT NULL CHECK (weight BETWEEN 1 AND 1000000000),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 2304),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, catalog_item_id)
);
CREATE INDEX case_items_enabled_idx ON case_items (case_id, catalog_item_id) WHERE enabled;

CREATE TABLE case_rounds (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  case_id uuid NOT NULL REFERENCES cases(id),
  awarded_catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  awarded_inventory_lot_id uuid NOT NULL REFERENCES inventory_lots(id)
    DEFERRABLE INITIALLY DEFERRED,
  awarded_quantity integer NOT NULL CHECK (awarded_quantity > 0),
  awarded_weight integer NOT NULL CHECK (awarded_weight > 0),
  pool_snapshot jsonb NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  total_weight bigint NOT NULL CHECK (total_weight > 0),
  roll_weight bigint NOT NULL CHECK (roll_weight >= 0 AND roll_weight < total_weight),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_reveal char(64) NOT NULL CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  rng_digest char(64) NOT NULL CHECK (rng_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX case_rounds_user_history_idx ON case_rounds (user_id, created_at DESC);
CREATE INDEX case_rounds_public_drops_idx ON case_rounds (created_at DESC);

CREATE TABLE inventory_sales (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  source_inventory_lot_id uuid NOT NULL,
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_value_minor bigint NOT NULL CHECK (unit_value_minor > 0),
  sell_rate_bps integer NOT NULL CHECK (sell_rate_bps BETWEEN 1 AND 10000),
  proceeds_minor bigint NOT NULL CHECK (proceeds_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX inventory_sales_user_history_idx ON inventory_sales (user_id, created_at DESC);

CREATE TABLE wallet_transactions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  kind varchar(32) NOT NULL CHECK (kind IN ('case_open', 'item_sale', 'admin_adjustment')),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_transactions_user_history_idx
  ON wallet_transactions (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX wallet_transactions_reference_idx
  ON wallet_transactions (kind, reference_id);

-- Case awards and item sales remain custody movements: the bot that physically holds a lot never
-- changes, only its ledger owner does.
ALTER TABLE inventory_lots DROP CONSTRAINT inventory_lots_source_type_check;
ALTER TABLE inventory_lots ADD CONSTRAINT inventory_lots_source_type_check
  CHECK (source_type IN (
    'deposit', 'house', 'upgrade_win', 'upgrade_stake', 'withdrawal_return', 'admin',
    'case_win', 'item_sale'
  ));

ALTER TABLE custody_movements DROP CONSTRAINT custody_movements_reason_check;
ALTER TABLE custody_movements ADD CONSTRAINT custody_movements_reason_check
  CHECK (reason IN (
    'deposit', 'upgrade_stake', 'upgrade_win', 'withdrawal', 'withdrawal_return', 'admin',
    'case_win', 'item_sale'
  ));

CREATE TRIGGER case_rounds_append_only
  BEFORE UPDATE OR DELETE ON case_rounds FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER inventory_sales_append_only
  BEFORE UPDATE OR DELETE ON inventory_sales FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER wallet_transactions_append_only
  BEFORE UPDATE OR DELETE ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION reject_mutation();

REVOKE ALL ON TABLE
  user_wallets, cases, case_items, case_rounds, inventory_sales, wallet_transactions
FROM PUBLIC;
REVOKE ALL ON TABLE
  user_wallets, cases, case_items, case_rounds, inventory_sales, wallet_transactions
FROM donut_api_runtime;

GRANT SELECT, INSERT ON TABLE
  user_wallets, cases, case_items, case_rounds, inventory_sales, wallet_transactions
TO donut_api_runtime;
GRANT UPDATE ON TABLE user_wallets, cases, case_items TO donut_api_runtime;

CREATE FUNCTION donut_schema_ready_v8() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v8() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v8() TO donut_api_runtime;

COMMIT;
