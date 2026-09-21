BEGIN;

-- A clear is a boundary in the shared chat timeline, not a destructive erase. Player messages
-- remain soft-deleted for moderation review, while this append-only row also tells every browser
-- to discard older game cards and other already-rendered chat lines.
CREATE TABLE chat_clear_events (
  id uuid PRIMARY KEY,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  cleared_by uuid NOT NULL REFERENCES users(id),
  reason varchar(256) NOT NULL CHECK (length(btrim(reason)) >= 3)
);

CREATE INDEX chat_clear_events_recent_idx
  ON chat_clear_events (cleared_at DESC, id DESC);

-- Runtime may record and read reset boundaries, but cannot rewrite or erase their history.
GRANT SELECT, INSERT ON TABLE chat_clear_events TO donut_api_runtime;

-- Supersedes donut_schema_ready_v39. The API reads this table on every public chat poll, so it
-- must not become ready against a database where the migration has not landed.
CREATE FUNCTION donut_schema_ready_v40() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v40() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v40() TO donut_api_runtime;

COMMIT;
