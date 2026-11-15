BEGIN;

-- Lava Rain: one claim per network (2026-11-15). The owner: "make sure ppl can only join once per
-- network", the rule code drops already keep (migration 094).
--
-- Each claim records the keyed hash of the network it came from, the same hash user_networks and the
-- code drops keep (lib/referral-network.ts networkHash: an IPv4 address, or an IPv6 /64, HMAC'd under
-- IP_HASH_KEY; never the address). The index refuses a second claim on the same drop from the same
-- network however the requests race. Claims made before this have no hash and are left as they are.
-- Additive only.

ALTER TABLE lava_rain_claims ADD COLUMN network_hash bytea;

CREATE UNIQUE INDEX lava_rain_claims_network_idx
  ON lava_rain_claims (event_id, network_hash)
  WHERE network_hash IS NOT NULL;

-- Supersedes donut_schema_ready_v99.
CREATE FUNCTION donut_schema_ready_v100() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v100() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v100() TO donut_api_runtime;

COMMIT;
