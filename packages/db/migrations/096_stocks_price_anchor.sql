BEGIN;

-- Stocks: the price as shown gets a split (2026-11-14). The chart is a martingale on a fine grid, and
-- a martingale that moves this much drifts down in the typical case: it went from 1,000 to 0.81 in its
-- first day. Shown as is, it reads as broken, and in a few weeks a price would round to zero in the
-- numeric(30, 10) price columns and every new position would fail their CHECK (price > 0).
--
-- Each epoch now carries the level its prices are shown from (lib/stocks.ts nextAnchorLevel): the
-- last epoch's, unless it would start outside 10..100,000, when it moves by whole powers of ten back
-- near 1,000. Display and records only: every decision is made on levels, which do not change.
-- The epochs already made keep 0; the next one moves the anchor. Additive only.

ALTER TABLE stocks_epochs
  ADD COLUMN anchor_level integer NOT NULL DEFAULT 0;

-- Supersedes donut_schema_ready_v95.
CREATE FUNCTION donut_schema_ready_v96() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v96() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v96() TO donut_api_runtime;

COMMIT;
