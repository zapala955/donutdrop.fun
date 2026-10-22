BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- One Discord, several site accounts
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Players with more than one Minecraft account can now link all of them to the same Discord (up to
-- DISCORD_MAX_ACCOUNTS, live in the admin panel) and pick between them when they log in with
-- Discord. Migration 016 made discord_user_id unique to keep a per-referee bonus from becoming a
-- faucet; that bonus no longer depends on Discord at all (the gate is the wager alone), and every
-- reward that does is already keyed on the Discord account itself in discord_rewards (one join
-- reward per Discord, one tag reward per Discord per day, one invite reward per invited Discord),
-- so a second account on the same Discord collects nothing the first did not.
--
-- What still needs ONE account per Discord is everything the bot does for a member: /tag pays an
-- account, /profile and /rewards describe one. That account is the MAIN one: the first linked, until
-- the member picks another with /accounts main in the server. At most one per Discord, enforced
-- below; every linked account that is not main is an alt.
--
-- Additive apart from the index swap: the unique index is replaced by a plain one of the same name
-- (the lookups by Discord id keep their index), and every account linked today becomes the main
-- account of its Discord, which it already is, being the only one.

DROP INDEX users_discord_user_id_idx;
CREATE INDEX users_discord_user_id_idx
  ON users (discord_user_id) WHERE discord_user_id IS NOT NULL;

ALTER TABLE users
  ADD COLUMN discord_main boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT users_discord_main_check CHECK (NOT discord_main OR discord_user_id IS NOT NULL);

UPDATE users SET discord_main = true WHERE discord_user_id IS NOT NULL;

CREATE UNIQUE INDEX users_discord_main_idx ON users (discord_user_id) WHERE discord_main;

-- A Discord sign-in now learns the Discord first and the account second: with several accounts on
-- it the player picks one after the callback. Migration 073 required both together; the account
-- may now follow, but never come without the Discord it was chosen from. (The constraint dropped is
-- 073's second unnamed CHECK, which Postgres names discord_login_states_check1.)
ALTER TABLE discord_login_states DROP CONSTRAINT discord_login_states_check1;
ALTER TABLE discord_login_states
  ADD CONSTRAINT discord_login_states_account_check
    CHECK (user_id IS NULL OR discord_user_id IS NOT NULL),
  -- The Discord name the picker greets the player with ("@name, which account?"). Cosmetic, and
  -- cleaned the same way as users.discord_username before it is stored.
  ADD COLUMN discord_username varchar(64);

-- No new grants: users already carries UPDATE from 002, discord_login_states from 073.

-- Supersedes donut_schema_ready_v74.
CREATE FUNCTION donut_schema_ready_v75() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v75() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v75() TO donut_api_runtime;

COMMIT;
