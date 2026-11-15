BEGIN;

-- Lava Rain is announced in Discord (2026-11-14): the owner's rain channel, pinging the rain role.
-- The community bot asks the site about the current drop (routes/community-bot.ts); the first ask
-- that finds a drop unannounced takes it to post, the post's place is recorded here, and the bot
-- edits that post when the drop pays out. Additive only.
--
--   discord_announced_at  when a bot took the drop to post; cleared if its post failed, so a later
--                         ask tries again (only while nothing is recorded as posted);
--   discord_channel_id,
--   discord_message_id    where the post is, once it exists.

ALTER TABLE lava_rain_events
  ADD COLUMN discord_announced_at timestamptz,
  ADD COLUMN discord_channel_id varchar(32),
  ADD COLUMN discord_message_id varchar(32);

-- Supersedes donut_schema_ready_v97.
CREATE FUNCTION donut_schema_ready_v98() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v98() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v98() TO donut_api_runtime;

COMMIT;
