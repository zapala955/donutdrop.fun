BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The tag reward needs the tag worn for 24 hours straight
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first tag reward is paid the moment somebody wears the server's tag. Every one after it
-- needs the tag worn without a break for 24 hours, counted from the later of the last reward and
-- the moment it was last put back on (services/api-gateway/src/lib/discord-rewards.ts).
--
-- Only the community bot can see a Discord profile, so it reports what it sees: on every /tag,
-- whenever it notices a watched member's tag change, and on a sweep of everybody who has claimed
-- before. This table keeps the result, one row per Discord account.
--
-- Additive: one new table; nothing existing is touched.

CREATE TABLE discord_tag_wear (
  discord_user_id varchar(32) PRIMARY KEY CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  -- Since when the tag has been on without a break; null while it is off.
  wearing_since timestamptz,
  -- When the bot last looked. A sighting long after the one before it starts a fresh streak,
  -- because nothing was watching in between.
  observed_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON TABLE discord_tag_wear TO donut_api_runtime;

-- Supersedes donut_schema_ready_v70.
CREATE FUNCTION donut_schema_ready_v71() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v71() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v71() TO donut_api_runtime;

COMMIT;
