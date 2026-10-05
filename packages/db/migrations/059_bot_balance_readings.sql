BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- What each bot really holds, as its own /bal reported it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DonutSMP switched its stats API off, and with it the only outside source for a bot's real
-- balance. The bots now ask the server themselves with /bal and send the answer on their
-- heartbeat. DonutSMP abbreviates large figures ("1.97M") and truncates them, so a reading is an
-- interval: the account holds at least `low` and less than `low + step` (step 1 for an exact
-- figure). The figure as shown is kept beside it for the console.
--
-- Nullable, and added without defaults: a bot that has not read its balance yet simply has no
-- reading. Adding nullable columns cannot fail against existing rows.

ALTER TABLE bot_accounts
  ADD COLUMN observed_balance_low_minor bigint CHECK (observed_balance_low_minor >= 0),
  ADD COLUMN observed_balance_step_minor bigint CHECK (observed_balance_step_minor >= 1),
  ADD COLUMN observed_balance_display varchar(32),
  ADD COLUMN observed_balance_at timestamptz;

-- UPDATE on bot_accounts is already granted to the runtime role; the new columns ride on it.

-- Supersedes donut_schema_ready_v58.
CREATE FUNCTION donut_schema_ready_v59() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v59() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v59() TO donut_api_runtime;

COMMIT;
