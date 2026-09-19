BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Remove the piggy bank.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The feature is gone from the API and the client. This drops the two tables behind it.
--
-- ── IT REFUSES TO STRAND MONEY ──
--
-- A deposit is open until it is claimed or broken, and an open deposit is principal that has
-- already left the player's wallet. Dropping the table while one exists does not delete a feature,
-- it deletes the record of a debt — and the routes that could have paid it are already gone, so
-- nothing would be left to notice.
--
-- So the migration checks first and raises. A migration that fails stops the deploy, which is loud
-- and recoverable; a migration that succeeds quietly here is neither. If this fires, settle the
-- open deposits before removing the feature: the money belongs to the players holding it.
--
-- PIGGY_BANK_ENABLED has defaulted to false in compose and in the VPS env template since it was
-- written, so on any deployment that never turned it on this check passes over an empty table.
DO $guard$
DECLARE
  open_count bigint;
  open_minor bigint;
BEGIN
  SELECT count(*), coalesce(sum(principal_minor), 0)
    INTO open_count, open_minor
    FROM piggy_bank_deposits
   WHERE claimed_at IS NULL AND broken_at IS NULL;

  IF open_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop the piggy bank: % open deposit(s) still hold % (minor units) of player money. Settle them before removing the feature.',
      open_count, open_minor;
  END IF;
END
$guard$;

-- ── WHAT IS DELIBERATELY LEFT ALONE ──
--
-- 1. wallet_transactions still accepts 'piggy_open', 'piggy_claim' and 'piggy_break'.
--
--    Those rows exist. The ledger is append-only and it is the authoritative record of every
--    movement of cash on this platform, so the history of a deposit survives the table that
--    described it — which is the reason dropping these tables loses no audit trail worth keeping.
--
--    Narrowing the CHECK to drop the three kinds would be validated against the existing rows and
--    would fail on exactly the databases that have any. That is not a hypothetical: migration 030
--    added a CHECK before backfilling the column it constrained and took production down, because
--    Postgres validates a new CHECK against every row already in the table. The kinds stay.
--
-- 2. quest_definitions.metric still offers 'piggy_deposits', and the contribution tables still
--    offer a 'piggy_bank' source, for the same reason and with the same failure mode.
--
--    Nothing writes either one and nothing ever did, but any definition that happens to use the
--    metric is now uncompletable, so it is switched off rather than left as a quest a player can
--    watch but never finish. A no-op on every database that has none.
UPDATE quest_definitions SET enabled = false WHERE metric = 'piggy_deposits' AND enabled;

-- Events first: they reference the deposits.
DROP TABLE piggy_bank_events;
DROP TABLE piggy_bank_deposits;

-- Supersedes donut_schema_ready_v31. The readiness probe names the exact schema the running API
-- expects, so a gateway still serving the piggy routes cannot take traffic against a database that
-- no longer has the tables under them.
CREATE FUNCTION donut_schema_ready_v32() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v32() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v32() TO donut_api_runtime;

COMMIT;
