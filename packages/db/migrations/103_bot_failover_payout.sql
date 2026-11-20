BEGIN;

-- Bot failover payout.
--
-- When one of the platform's bot accounts has not been connected for three minutes while another
-- one still is, the gateway's failover watcher (services/api-gateway/src/lib/bot-failover.ts)
-- queues an `admin_payout` that empties the bot still online into a fixed owner account.
--
-- That payout is ordered by the system, not by an operator, so it has no actor. The column stays
-- NOT NULL for everything else: only a row whose idempotency key marks it as a failover payout may
-- leave it empty. This WIDENS the constraint, so it cannot fail against existing rows.
ALTER TABLE admin_payouts ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE admin_payouts
  ADD CONSTRAINT admin_payouts_actor_or_failover_check
    CHECK (actor_user_id IS NOT NULL OR idempotency_key LIKE 'failover:%');

-- Supersedes donut_schema_ready_v102.
CREATE FUNCTION donut_schema_ready_v103() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v103() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v103() TO donut_api_runtime;

COMMIT;
