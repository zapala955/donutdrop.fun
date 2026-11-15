BEGIN;

-- The owner, 2026-11-15: "i want there to be a rain every 5h, also start the first one now and i want
-- it to be 3b", and then "make sure the rain lasts 30 mins".
--
-- lava_rain_scheduled holds drops waiting to open: the API's rain clock opens the oldest one the
-- moment nothing is falling (routes/social.ts openScheduledRain), deleting the row in the same
-- transaction as the drop it opens, so each opens once. A drop opened from here starts the five-hour
-- clock like any other, so the automatic drops follow it.
--
-- Why a queue the API opens, rather than a drop written here: this migration runs while the previous
-- API is still serving, and that API knows nothing of the 20x hold or the entry rules. A drop it could
-- see would take claims under the old rules for the seconds until the new API is up. A queued row it
-- cannot see at all.

CREATE TABLE lava_rain_scheduled (
  id uuid PRIMARY KEY,
  pool_minor bigint NOT NULL CHECK (pool_minor > 0),
  -- Minutes the claim window stays open; null takes the configured window.
  claim_minutes integer CHECK (claim_minutes BETWEEN 1 AND 60),
  reason varchar(240),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, DELETE ON TABLE lava_rain_scheduled TO donut_api_runtime;

-- The launch drop: $3B, thirty minutes to claim, opened as soon as the new API is up. Only on a
-- database that has run Lava Rain before (the live one), never on a fresh one or a test run.
INSERT INTO lava_rain_scheduled (id, pool_minor, claim_minutes, reason)
SELECT gen_random_uuid(), 3000000000, 30, 'Launch of the new Lava Rain (the owner, 2026-11-15)'
 WHERE EXISTS (SELECT 1 FROM lava_rain_events);

-- A drop every five hours (Admin -> System -> Lava Rain, "automatic drop every N minutes"), set here so
-- the new code never runs a single tick at the old, shorter cadence with $300M-$1.5B pools. Written
-- in the first administrator's name, as the settings table requires one; on the same database only.
INSERT INTO runtime_settings (key, value, updated_by, updated_at)
SELECT 'lavaRainAutoEveryMinutes', to_jsonb(300), u.id, now()
  FROM users u
 WHERE u.role = 'admin' AND EXISTS (SELECT 1 FROM lava_rain_events)
 ORDER BY u.created_at
 LIMIT 1
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();

-- Every drop open for thirty minutes (Admin -> System -> Lava Rain, "claim window"), the same way.
INSERT INTO runtime_settings (key, value, updated_by, updated_at)
SELECT 'lavaRainClaimMinutes', to_jsonb(30), u.id, now()
  FROM users u
 WHERE u.role = 'admin' AND EXISTS (SELECT 1 FROM lava_rain_events)
 ORDER BY u.created_at
 LIMIT 1
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();

-- Supersedes donut_schema_ready_v98.
CREATE FUNCTION donut_schema_ready_v99() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v99() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v99() TO donut_api_runtime;

COMMIT;
