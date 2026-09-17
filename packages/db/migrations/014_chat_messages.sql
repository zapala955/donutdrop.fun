BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Chat
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Player-written messages. The display name is NOT stored on the row: it is joined from users at
-- read time, so a rename is reflected everywhere at once and one identity cannot be spoofed by
-- writing a different name into a message.
--
-- Not append-only, unlike the ledgers. A chat message is the one thing here an operator must be
-- able to take down — a slur, a scam link, a leaked address — and a table that cannot be edited
-- cannot be moderated. Deletion is soft so the record of what was said, and that it was removed,
-- survives; the read path filters on deleted_at rather than the row disappearing.
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  body varchar(240) NOT NULL CHECK (length(btrim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id),
  CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);

-- The only read pattern: the newest visible messages.
CREATE INDEX chat_messages_recent_idx
  ON chat_messages (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Slow mode is enforced by looking up a user's last message, so that lookup needs its own index.
CREATE INDEX chat_messages_author_recent_idx ON chat_messages (user_id, created_at DESC);

GRANT SELECT, INSERT ON TABLE chat_messages TO donut_api_runtime;
-- UPDATE, because soft deletion is an update. No DELETE: a message is retired, never erased.
GRANT UPDATE ON TABLE chat_messages TO donut_api_runtime;

-- Supersedes donut_schema_ready_v13.
CREATE FUNCTION donut_schema_ready_v14() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v14() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v14() TO donut_api_runtime;

COMMIT;
