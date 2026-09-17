BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Vault yield and the piggy bank: two ways to be paid for not gambling.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE CONSTRAINT THAT SHAPED THIS
-- -------------------------------
-- Item prices are fixed and shared. catalog_items.unit_value_minor is the price of an item, not
-- of a lot, and every game route asserts the client's quoted price against it before it will
-- act (assertExpectedPrice -> PRICE_CHANGED). Growing a single player's lot by raising that
-- column would reprice the item for everyone, for the house stock, and for every open quote.
--
-- So vault yield is NOT a change in what an item is worth. It is a separate cash entitlement
-- that accrues alongside the lot and is paid out of the wallet. The item keeps its fixed price
-- forever, the upgrader maths are untouched, and the yield is money the site owes the player for
-- holding — which is exactly what it is.
--
-- ACCRUAL IS LAZY AND DERIVED, NEVER WRITTEN BY A JOB
-- --------------------------------------------------
-- There is no cron ticking balances upward. Accrual is a pure function of four things: the lot's
-- baseline value, the whole days elapsed since its anchor, the daily rate, and the cap. Any
-- reader can recompute it and get the same answer, which means it cannot drift, cannot be
-- double-credited by a retried job, and cannot be lost if a worker misses a night.
ALTER TABLE inventory_lots
  -- When this lot started earning. Set when the lot is created and moved forward on every claim,
  -- so a claim never pays for a day twice.
  ADD COLUMN yield_anchor_at timestamptz NOT NULL DEFAULT now(),
  -- Total yield already paid out on this lot, against the cap. A lot that has been held to the
  -- cap and claimed is done earning; this is what makes that checkable.
  ADD COLUMN yield_claimed_minor bigint NOT NULL DEFAULT 0;

ALTER TABLE inventory_lots
  ADD CONSTRAINT inventory_lots_yield_claimed_nonneg_check
    CHECK (yield_claimed_minor >= 0);

-- Claims read every earning lot a player holds, and only lots they still own can earn.
CREATE INDEX inventory_lots_yield_idx
  ON inventory_lots (owner_user_id, yield_anchor_at)
  WHERE owner_user_id IS NOT NULL AND state = 'available';

-- Every payout is a row, so "how much has this lot ever earned" is answerable from the ledger
-- and not only from the running total on the lot.
CREATE TABLE vault_yield_claims (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  inventory_lot_id uuid NOT NULL REFERENCES inventory_lots(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  -- The lot value the accrual was computed from, recorded so an audit can replay the arithmetic
  -- even if the catalog price is revised later.
  baseline_value_minor bigint NOT NULL CHECK (baseline_value_minor > 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  elapsed_days integer NOT NULL CHECK (elapsed_days > 0),
  rate_bps_per_day integer NOT NULL CHECK (rate_bps_per_day > 0),
  cap_bps integer NOT NULL CHECK (cap_bps > 0),
  accrued_minor bigint NOT NULL CHECK (accrued_minor > 0),
  anchor_before timestamptz NOT NULL,
  anchor_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (anchor_after > anchor_before)
);
CREATE INDEX vault_yield_claims_user_history_idx
  ON vault_yield_claims (user_id, created_at DESC, id DESC);
CREATE INDEX vault_yield_claims_lot_idx ON vault_yield_claims (inventory_lot_id);

CREATE TRIGGER vault_yield_claims_append_only
  BEFORE UPDATE OR DELETE ON vault_yield_claims FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- The piggy bank: cash locked for a fixed term at a rate agreed up front.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The payout is computed and stored when the deposit is OPENED, not when it is claimed. A player
-- locking money away for two weeks is owed a number they can see before they commit, and a rate
-- the site cannot revise while their money is captive. Changing config later changes what NEW
-- deposits earn and nothing else.
CREATE TABLE piggy_bank_deposits (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  principal_minor bigint NOT NULL CHECK (principal_minor > 0),
  -- Terms, frozen at open.
  apr_bps integer NOT NULL CHECK (apr_bps > 0 AND apr_bps <= 100000),
  lock_days integer NOT NULL CHECK (lock_days >= 1),
  -- What claiming at or after unlocks_at pays out, principal included. Stored so the promise is
  -- a stored fact rather than a recomputation that a config edit could quietly change.
  matured_payout_minor bigint NOT NULL CHECK (matured_payout_minor > 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  unlocks_at timestamptz NOT NULL,
  -- Terminal state. A deposit is open until exactly one of these is set.
  claimed_at timestamptz,
  broken_at timestamptz,
  payout_minor bigint,
  balance_after_minor bigint,
  CHECK (unlocks_at > opened_at),
  CHECK (matured_payout_minor >= principal_minor),
  CHECK (payout_minor IS NULL OR payout_minor >= 0),
  CHECK (balance_after_minor IS NULL OR balance_after_minor >= 0),
  -- Claimed and broken are mutually exclusive, and either one settles the money.
  CHECK (NOT (claimed_at IS NOT NULL AND broken_at IS NOT NULL)),
  CHECK (
    (claimed_at IS NULL AND broken_at IS NULL AND payout_minor IS NULL AND balance_after_minor IS NULL)
    OR
    ((claimed_at IS NOT NULL OR broken_at IS NOT NULL) AND payout_minor IS NOT NULL AND balance_after_minor IS NOT NULL)
  ),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX piggy_bank_deposits_user_idx
  ON piggy_bank_deposits (user_id, opened_at DESC, id DESC);
CREATE INDEX piggy_bank_deposits_open_idx
  ON piggy_bank_deposits (user_id, unlocks_at)
  WHERE claimed_at IS NULL AND broken_at IS NULL;

-- Breaking early forfeits interest and returns principal, so it is recorded rather than inferred.
CREATE TABLE piggy_bank_events (
  id uuid PRIMARY KEY,
  deposit_id uuid NOT NULL REFERENCES piggy_bank_deposits(id),
  user_id uuid NOT NULL REFERENCES users(id),
  kind varchar(16) NOT NULL CHECK (kind IN ('open', 'claim', 'break')),
  amount_minor bigint NOT NULL,
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX piggy_bank_events_user_idx ON piggy_bank_events (user_id, created_at DESC, id DESC);
CREATE INDEX piggy_bank_events_deposit_idx ON piggy_bank_events (deposit_id);

CREATE TRIGGER piggy_bank_events_append_only
  BEFORE UPDATE OR DELETE ON piggy_bank_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Every movement of cash stays in the one wallet ledger. wallet_transactions_reference_idx makes
-- (kind, reference_id) unique, so each of these can happen exactly once per referenced row
-- however many times a request is replayed.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake',
      'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break'
    ));

GRANT SELECT, INSERT ON TABLE vault_yield_claims, piggy_bank_deposits, piggy_bank_events
  TO donut_api_runtime;
GRANT UPDATE ON TABLE piggy_bank_deposits TO donut_api_runtime;

-- Supersedes donut_schema_ready_v10. The readiness probe names the exact schema the running API
-- expects, so an API deployed against an older schema fails its readiness check instead of
-- serving requests against columns that are not there.
CREATE FUNCTION donut_schema_ready_v11() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v11() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v11() TO donut_api_runtime;

COMMIT;
