BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Same-network invites: void the invite, block nobody
-- ═══════════════════════════════════════════════════════════════════════════
--
-- From 066 an invite between two accounts that had used the same network was voided AND both
-- accounts were blocked from the referral programme, which also stopped them earning from every
-- genuine player they had invited. From here only that one invite is voided; both accounts go on
-- inviting and earning as before (services/api-gateway/src/lib/referral-network.ts).
--
-- This lifts the blocks the check set, found by the reason it wrote. A block an administrator set by
-- hand carries the reason they typed and stays. The voided invites stay voided, and the
-- 'referral.same_network' audit entries stay as the record of each one; whatever a lifted account
-- had banked from its other invites becomes claimable again.
--
-- Rewrites one pair of columns on users and nothing else. users is not append-only.

UPDATE users
   SET referral_blocked_at = NULL,
       referral_block_reason = NULL,
       updated_at = now()
 WHERE referral_blocked_at IS NOT NULL
   AND referral_block_reason = 'Automatic: the invited account shares a network with its inviter';

-- Supersedes donut_schema_ready_v73.
CREATE FUNCTION donut_schema_ready_v74() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v74() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v74() TO donut_api_runtime;

COMMIT;
