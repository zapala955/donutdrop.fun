BEGIN;

-- Bots for different players (the owner, 2026-11-20: "turn on different bots for different people,
-- like highrollers get another bot"). Every pool node now serves one group of players, and every
-- player belongs to one: a deposit is sent to, and a withdrawal paid by, the nodes of the player's
-- own group. A group with no node online falls back to 'everyone', so a group is never a way to
-- leave somebody without a bot.
--
--   bot_accounts.player_group  which players this node serves; 'everyone' unless an admin moves it.
--   users.bot_group            an admin's choice for one player, or NULL to decide it from what the
--                              player has wagered (highrollerWagerMinor makes a 'highroller').

ALTER TABLE bot_accounts
  ADD COLUMN player_group varchar(24) NOT NULL DEFAULT 'everyone'
    CHECK (player_group ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE users
  ADD COLUMN bot_group varchar(24)
    CHECK (bot_group IS NULL OR bot_group ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

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
