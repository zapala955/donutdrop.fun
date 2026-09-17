BEGIN;

-- Cash-only case opens award no inventory lot, so the column that points at one has to be
-- allowed to be empty. Every historical row keeps its lot reference; only new cash-settled rounds
-- leave it null, and payout_minor is what says the prize was paid instead.
--
-- The paired CHECK is what stops this from becoming a hole: a round must record either the lot it
-- handed over or the cash it paid. A row with neither would be a round whose prize went nowhere.
ALTER TABLE case_rounds ALTER COLUMN awarded_inventory_lot_id DROP NOT NULL;

ALTER TABLE case_rounds
  ADD CONSTRAINT case_rounds_prize_settled_check
    CHECK (awarded_inventory_lot_id IS NOT NULL OR payout_minor IS NOT NULL);

-- Supersedes donut_schema_ready_v12.
CREATE FUNCTION donut_schema_ready_v13() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v13() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v13() TO donut_api_runtime;

COMMIT;
