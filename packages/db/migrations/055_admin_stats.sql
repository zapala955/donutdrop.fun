BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The admin dashboard reads the ledger by time
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The console's dashboard sums wallet_transactions over a window -- today by the hour, or the
-- last 7, 30 or 90 days by the day -- to report what was wagered, what the house kept, what it
-- paid back in rakeback, referrals and the rest, and the net of it all. Every index on the ledger
-- so far starts with the player (their history) or the kind and reference (idempotency), so a
-- window across all players was a scan of the whole table. This one makes it a range read.
--
-- Additive only: no table, constraint or row changes.

CREATE INDEX wallet_transactions_created_idx ON wallet_transactions (created_at);

-- Supersedes donut_schema_ready_v54.
CREATE FUNCTION donut_schema_ready_v55() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v55() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v55() TO donut_api_runtime;

COMMIT;
