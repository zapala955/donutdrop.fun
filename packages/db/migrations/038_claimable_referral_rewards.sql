BEGIN;

-- Revenue share used to be credited to the referrer's wallet on every wager. Keep the historical
-- paid counter intact, but give future accruals a separate balance so the player can collect them
-- deliberately from the Rewards page.
ALTER TABLE referrals
  ADD COLUMN revshare_claimable_minor bigint NOT NULL DEFAULT 0
    CHECK (revshare_claimable_minor >= 0);

-- One append-only row per collection. The id doubles as the wallet transaction reference, tying
-- the claim receipt to the exact balance credit without accepting an idempotency key from the
-- browser.
CREATE TABLE referral_claims (
  id uuid PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_claims_referrer_idx
  ON referral_claims (referrer_id, created_at DESC);
CREATE TRIGGER referral_claims_append_only
  BEFORE UPDATE OR DELETE ON referral_claims FOR EACH ROW EXECUTE FUNCTION reject_mutation();

GRANT SELECT, INSERT ON TABLE referral_claims TO donut_api_runtime;

-- Supersedes donut_schema_ready_v37. The API must not serve the claim endpoint until the
-- claimable balance and its append-only receipt table both exist.
CREATE FUNCTION donut_schema_ready_v38() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v38() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v38() TO donut_api_runtime;

COMMIT;
