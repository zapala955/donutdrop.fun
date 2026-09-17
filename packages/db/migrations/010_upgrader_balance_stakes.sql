BEGIN;

-- Staking cash in the upgrader.
--
-- Until now a round consumed a custody lot and, on a win, awarded one: item in, item out. The
-- upgrader also accepts a cash stake, which is the same wager with a different source of value —
-- the wallet is debited instead of a lot being consumed, and a win still awards a real item out
-- of reconciled house stock.
--
-- stake_value_minor keeps its meaning in both shapes: it is what the round wagered, and it is
-- what the multiplier bounds and the daily wager limit are measured against. stake_kind says
-- where that value came from, so a reader never has to infer it from the absence of
-- upgrader_stakes rows.
ALTER TABLE upgrader_rounds
  ADD COLUMN stake_kind varchar(8) NOT NULL DEFAULT 'item',
  ADD COLUMN stake_balance_minor bigint NOT NULL DEFAULT 0,
  -- The wallet balance the debit left behind. Recorded only for cash rounds, and only so the
  -- round is self-contained for audit the way case_rounds.balance_after_minor already is.
  ADD COLUMN balance_after_minor bigint;

ALTER TABLE upgrader_rounds
  ADD CONSTRAINT upgrader_rounds_stake_kind_check
    CHECK (stake_kind IN ('item', 'balance')),
  ADD CONSTRAINT upgrader_rounds_stake_balance_nonneg_check
    CHECK (stake_balance_minor >= 0),
  ADD CONSTRAINT upgrader_rounds_balance_after_nonneg_check
    CHECK (balance_after_minor IS NULL OR balance_after_minor >= 0),
  -- The two shapes are mutually exclusive and each is fully specified. An item round carries no
  -- cash figures at all; a cash round's wagered value IS the debit, so the two can never disagree.
  ADD CONSTRAINT upgrader_rounds_stake_shape_check
    CHECK (
      (stake_kind = 'item'
        AND stake_balance_minor = 0
        AND balance_after_minor IS NULL)
      OR
      (stake_kind = 'balance'
        AND stake_balance_minor = stake_value_minor
        AND balance_after_minor IS NOT NULL)
    );

-- A cash stake is a wallet debit, so it belongs in the same append-only ledger as a case open.
-- wallet_transactions_reference_idx already makes (kind, reference_id) unique, which means one
-- round can debit exactly once however many times the request is replayed.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN ('case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake'));

-- Cash rounds are the only ones without upgrader_stakes rows, and the history and audit queries
-- read them by user and recency like every other round.
CREATE INDEX upgrader_rounds_balance_stakes_idx
  ON upgrader_rounds (user_id, created_at DESC)
  WHERE stake_kind = 'balance';

-- Supersedes donut_schema_ready_v9. The readiness probe names the exact schema the running API
-- expects, so an API deployed against an older schema fails its readiness check instead of
-- serving requests against columns that are not there.
CREATE FUNCTION donut_schema_ready_v10() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v10() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v10() TO donut_api_runtime;

COMMIT;
