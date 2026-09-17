BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- VIP levels
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player's VIP level is a pure function of one number: lifetime wagered volume. The level is
-- therefore NOT stored — it is derived in the API from this total against a fixed thirty-row
-- ladder. Storing the level as well would create two sources of truth for the same fact, and the
-- one that drifts is always the cached one.
--
-- The running total lives on a row rather than being aggregated from the round history. This is
-- read and written inside the settlement of every case open and every upgrader pull; an aggregate
-- over all history costs a scan that grows forever, and the level it feeds decides a rate that
-- multiplies every subsequent wager.
--
-- bigint holds this comfortably. The top of the ladder is 76,000,000,000 and the column's ceiling
-- is 9,223,372,036,854,775,807 — roughly a hundred million times the highest threshold — so the
-- total cannot overflow before the platform runs out of other problems.
CREATE TABLE user_wager_totals (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wagered_minor bigint NOT NULL DEFAULT 0 CHECK (wagered_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- VIP rakeback accrues into the existing rakeback ledger as a fifth tier, so it is claimed,
-- audited and displayed by machinery that already exists.
--
-- It has NO cooldown, like 'instant'. A level-based reward that makes a player wait to collect is
-- a level-based reward that reads as a punishment for levelling up.
--
-- WHAT MAKES IT DIFFERENT FROM THE OTHER FOUR, and the reason this comment is here rather than in
-- a route: the four original tiers pay a percentage of the house MARGIN. The VIP tier pays a
-- percentage of the WAGER. They share a table and a claim path but not a base, and anybody
-- changing one should not assume the other works the same way.
ALTER TABLE rakeback_accruals DROP CONSTRAINT rakeback_accruals_tier_check;
ALTER TABLE rakeback_accruals
  ADD CONSTRAINT rakeback_accruals_tier_check
    CHECK (tier IN ('instant', 'daily', 'weekly', 'monthly', 'vip'));

ALTER TABLE rakeback_claims DROP CONSTRAINT rakeback_claims_tier_check;
ALTER TABLE rakeback_claims
  ADD CONSTRAINT rakeback_claims_tier_check
    CHECK (tier IN ('instant', 'daily', 'weekly', 'monthly', 'vip'));

GRANT SELECT, INSERT ON TABLE user_wager_totals TO donut_api_runtime;
-- UPDATE, because the running total moves on every wager.
GRANT UPDATE ON TABLE user_wager_totals TO donut_api_runtime;

-- Supersedes donut_schema_ready_v18.
CREATE FUNCTION donut_schema_ready_v19() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v19() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v19() TO donut_api_runtime;

COMMIT;
