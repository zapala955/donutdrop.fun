BEGIN;

-- Bot heartbeats, inventory snapshots, and empty job polls arrive frequently.
-- Keep a bounded replay/diagnostic window for only that non-custody telemetry,
-- while always retaining the latest snapshot and the latest mismatching
-- snapshot for every bot. Identity proofs, deposit confirmations, job results,
-- non-empty job claims, and deposit authorization decisions remain append-only
-- without retention deletion. The API role still has no DELETE privilege on
-- either table; it can only invoke the fixed-policy function below.
CREATE INDEX inbound_bot_events_retention_idx
  ON inbound_bot_events (processed_at, event_id);
CREATE INDEX bot_inventory_snapshots_retention_idx
  ON bot_inventory_snapshots (created_at, id);

CREATE FUNCTION guard_inbound_bot_event_retention() RETURNS trigger AS $$
DECLARE
  table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)
    INTO table_owner
    FROM pg_catalog.pg_class AS c
   WHERE c.oid = TG_RELID;

  IF TG_OP = 'DELETE'
     AND current_user = table_owner
     AND pg_catalog.current_setting('donut.retention_prune', true) = 'inbound-v1'
     AND OLD.processed_at < pg_catalog.statement_timestamp() - interval '30 days'
     AND (
       OLD.event_type IN ('heartbeat', 'inventory_snapshot')
       OR (
         OLD.event_type = 'job_claim'
         AND OLD.response_body = '{"job": null}'::jsonb
       )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.bot_inventory_snapshots AS candidate
        WHERE candidate.event_id = OLD.event_id
          AND (
            NOT EXISTS (
              SELECT 1
                FROM public.bot_inventory_snapshots AS newer
               WHERE newer.bot_id = candidate.bot_id
                 AND (newer.created_at, newer.id) > (candidate.created_at, candidate.id)
            )
            OR (
              NOT candidate.matched
              AND NOT EXISTS (
                SELECT 1
                  FROM public.bot_inventory_snapshots AS newer_mismatch
                 WHERE newer_mismatch.bot_id = candidate.bot_id
                   AND NOT newer_mismatch.matched
                   AND (newer_mismatch.created_at, newer_mismatch.id) >
                       (candidate.created_at, candidate.id)
              )
            )
          )
     )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% is append-only outside the controlled retention policy', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

DROP TRIGGER inbound_bot_events_append_only ON inbound_bot_events;
CREATE TRIGGER inbound_bot_events_append_only
  BEFORE UPDATE OR DELETE ON inbound_bot_events
  FOR EACH ROW EXECUTE FUNCTION guard_inbound_bot_event_retention();

CREATE FUNCTION guard_bot_inventory_snapshot_retention() RETURNS trigger AS $$
DECLARE
  table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)
    INTO table_owner
    FROM pg_catalog.pg_class AS c
   WHERE c.oid = TG_RELID;

  IF TG_OP = 'DELETE'
     AND current_user = table_owner
     AND pg_catalog.current_setting('donut.retention_prune', true) = 'snapshot-v1'
     AND OLD.created_at < pg_catalog.statement_timestamp() - interval '30 days'
     AND EXISTS (
       SELECT 1
         FROM public.bot_inventory_snapshots AS newer
        WHERE newer.bot_id = OLD.bot_id
          AND (newer.created_at, newer.id) > (OLD.created_at, OLD.id)
     )
     AND (
       OLD.matched
       OR EXISTS (
         SELECT 1
           FROM public.bot_inventory_snapshots AS newer_mismatch
          WHERE newer_mismatch.bot_id = OLD.bot_id
            AND NOT newer_mismatch.matched
            AND (newer_mismatch.created_at, newer_mismatch.id) >
                (OLD.created_at, OLD.id)
       )
     )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% is append-only outside the controlled retention policy', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

CREATE TRIGGER bot_inventory_snapshots_append_only
  BEFORE UPDATE OR DELETE ON bot_inventory_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_bot_inventory_snapshot_retention();

CREATE FUNCTION donut_prune_bot_telemetry()
RETURNS TABLE (inbound_events_deleted bigint, inventory_snapshots_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- The fixed keys serialize telemetry pruning, including callers that invoke
  -- this function without the maintenance script's surrounding transaction.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(142857, 515151) THEN
    RAISE EXCEPTION 'bot telemetry retention is already running';
  END IF;

  inbound_events_deleted := 0;
  inventory_snapshots_deleted := 0;

  PERFORM pg_catalog.set_config('donut.retention_prune', 'snapshot-v1', true);
  WITH protected_snapshots AS (
    (
      SELECT DISTINCT ON (snapshot.bot_id) snapshot.id
        FROM public.bot_inventory_snapshots AS snapshot
       ORDER BY snapshot.bot_id, snapshot.created_at DESC, snapshot.id DESC
    )
    UNION
    (
      SELECT DISTINCT ON (snapshot.bot_id) snapshot.id
        FROM public.bot_inventory_snapshots AS snapshot
       WHERE NOT snapshot.matched
       ORDER BY snapshot.bot_id, snapshot.created_at DESC, snapshot.id DESC
    )
  ), deletion_batch AS (
    SELECT snapshot.id
      FROM public.bot_inventory_snapshots AS snapshot
     WHERE snapshot.created_at < pg_catalog.statement_timestamp() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM protected_snapshots AS protected WHERE protected.id = snapshot.id
       )
     ORDER BY snapshot.created_at, snapshot.id
     LIMIT 25000
     FOR UPDATE OF snapshot SKIP LOCKED
  )
  DELETE FROM public.bot_inventory_snapshots AS snapshot
   USING deletion_batch
   WHERE snapshot.id = deletion_batch.id;
  GET DIAGNOSTICS inventory_snapshots_deleted = ROW_COUNT;

  PERFORM pg_catalog.set_config('donut.retention_prune', 'inbound-v1', true);
  WITH protected_events AS (
    (
      SELECT DISTINCT ON (snapshot.bot_id) snapshot.event_id
        FROM public.bot_inventory_snapshots AS snapshot
       ORDER BY snapshot.bot_id, snapshot.created_at DESC, snapshot.id DESC
    )
    UNION
    (
      SELECT DISTINCT ON (snapshot.bot_id) snapshot.event_id
        FROM public.bot_inventory_snapshots AS snapshot
       WHERE NOT snapshot.matched
       ORDER BY snapshot.bot_id, snapshot.created_at DESC, snapshot.id DESC
    )
  ), deletion_batch AS (
    SELECT bot_event.event_id
      FROM public.inbound_bot_events AS bot_event
     WHERE bot_event.processed_at < pg_catalog.statement_timestamp() - interval '30 days'
       AND (
         bot_event.event_type IN ('heartbeat', 'inventory_snapshot')
         OR (
           bot_event.event_type = 'job_claim'
           AND bot_event.response_body = '{"job": null}'::jsonb
         )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM protected_events AS protected
          WHERE protected.event_id = bot_event.event_id
       )
     ORDER BY bot_event.processed_at, bot_event.event_id
     LIMIT 25000
     FOR UPDATE OF bot_event SKIP LOCKED
  )
  DELETE FROM public.inbound_bot_events AS bot_event
   USING deletion_batch
   WHERE bot_event.event_id = deletion_batch.event_id;
  GET DIAGNOSTICS inbound_events_deleted = ROW_COUNT;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION guard_inbound_bot_event_retention() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_bot_inventory_snapshot_retention() FROM PUBLIC;
REVOKE ALL ON FUNCTION donut_prune_bot_telemetry() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_prune_bot_telemetry() TO donut_api_runtime;

CREATE FUNCTION donut_schema_ready_v5() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v5() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v5() TO donut_api_runtime;

COMMIT;
