BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- One open cash withdrawal per player, whatever stage it is at
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The index from 028 counted a withdrawal as open only while it was pending approval, queued or
-- processing. Two later stages slipped through it: `awaiting_vault` (waiting for the vault to fund
-- the teller -- the payout queue, now that a bot short of money makes withdrawals wait) and
-- `manual_review` (an operator deciding). A player could stack new withdrawals behind either, and
-- when a parked one was put back on its way (a late vault receipt, an operator's retry) the move
-- to `queued` collided with the newer one in this very index and failed the event that carried it.
--
-- Every stage that still owes the player is open now: a player finishes one withdrawal before
-- starting the next. Checked against production before shipping: no player holds two.

DROP INDEX cash_withdrawals_one_live_idx;

CREATE UNIQUE INDEX cash_withdrawals_one_live_idx
  ON cash_withdrawals (user_id)
  WHERE status IN ('pending_approval', 'queued', 'processing', 'awaiting_vault', 'manual_review');

-- The payout queue is read in arrival order. (cash_withdrawals_queue_idx, from 028, is the
-- operator's review list; this is the players' place in line.)
CREATE INDEX cash_withdrawals_payout_order_idx
  ON cash_withdrawals (created_at, id)
  WHERE status IN ('queued', 'awaiting_vault', 'processing');

-- Supersedes donut_schema_ready_v52.
CREATE FUNCTION donut_schema_ready_v53() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v53() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v53() TO donut_api_runtime;

COMMIT;
