BEGIN;

-- Code drops: one claim per network (2026-11-13). The owner, after two accounts on one connection
-- (Cpt_Ardian and .DashedWave65606: one PC, one browser each) took two of every drop's five claims
-- for eleven drops running: "make drops one claim per network, so a second account on the same
-- connection gets refused".
--
-- Each claim now records the keyed hash of the network it came from, the same hash user_networks
-- keeps (lib/referral-network.ts networkHash: an IPv4 address, or an IPv6 /64, HMAC'd under
-- IP_HASH_KEY; never the address). The index refuses a second claim on the same drop from the same
-- network however the requests race. Claims made before this have no hash and are left as they are.
-- Additive only.

ALTER TABLE discord_code_drop_claims ADD COLUMN network_hash bytea;

CREATE UNIQUE INDEX discord_code_drop_claims_network_idx
  ON discord_code_drop_claims (drop_id, network_hash)
  WHERE network_hash IS NOT NULL;

CREATE FUNCTION donut_schema_ready_v94() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v94() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v94() TO donut_api_runtime;

COMMIT;
