-- ═══════════════════════════════════════════════════════════════════════════
-- An optional least-privilege database role for the community bot
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF ANYTHING AUTOMATIC
--
-- `init-runtime-role.sh` runs once, on first cluster init, and stamps
-- `.donut-security-bootstrap-v1` so it never runs again. A role added there would not appear on a
-- database that already exists -- which is every production database. Migrations cannot do it
-- either: they run as `donut_migrator`, which is NOCREATEROLE, deliberately.
--
-- So creating a role on a live cluster is a superuser action, and a superuser action is something
-- an operator does on purpose rather than something a deploy does quietly.
--
-- WITHOUT THIS SCRIPT the community bot connects with `api_database_url`, which is the API's own
-- role. That works, and it means the bot can read every table the API can -- including balances.
-- It is a Discord process in a server anybody can join, so that is worth narrowing when somebody
-- has ten minutes for it. It is not a reason to delay running the bot.
--
-- ── running it ─────────────────────────────────────────────────────────────
--
--   1. Pick a password (32+ characters) and put it in a file:
--        openssl rand -hex 32 | sudo tee /opt/donutdrop/shared/secrets/community-db-password
--   2. Run this script as the superuser, passing that password:
--        docker compose -f infra/docker/compose.yml exec -T postgres \
--          psql -v ON_ERROR_STOP=1 -U postgres -d donut_upgrader \
--               -v community_password="$(cat /opt/donutdrop/shared/secrets/community-db-password)" \
--               -f - < infra/postgres/community-bot-role.sql
--   3. Write the connection string the bot should use:
--        postgres://donut_community_login:<password>@postgres:5432/donut_upgrader
--      into /opt/donutdrop/shared/secrets/community-database-url, then set
--        COMMUNITY_DATABASE_URL_FILE=/opt/donutdrop/shared/secrets/community-database-url
--      in the deploy env and redeploy.
--
-- Safe to re-run: every statement is idempotent, and re-running it rotates the password.

\set ON_ERROR_STOP on

BEGIN;

SELECT 'CREATE ROLE donut_community_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_community_runtime') \gexec

SELECT 'CREATE ROLE donut_community_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_community_login') \gexec

SELECT format(
  'ALTER ROLE donut_community_login WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'community_password'
) \gexec

ALTER ROLE donut_community_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT donut_community_runtime TO donut_community_login;

-- Through current_database() rather than a hardcoded name: the database is `donut_upgrader` in
-- production and `donutdrop` in some local stacks, and a wrong literal here fails at the one
-- moment somebody is running this by hand on a live cluster.
DO $grant$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO donut_community_runtime', current_database());
END $grant$;
GRANT USAGE ON SCHEMA public TO donut_community_runtime;

-- Exactly the nine tables the bot owns. Listed one by one rather than granted on the schema: a
-- wildcard here would silently pick up every table a future migration adds, which is the opposite
-- of the point.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  discord_guild_settings, discord_tickets, discord_mod_actions, discord_giveaways,
  discord_giveaway_entries, discord_suggestions, discord_suggestion_votes,
  discord_role_menus, discord_role_menu_options
  TO donut_community_runtime;

/* `users` is NOT granted, not even SELECT.
 *
 * The bot reads a profile through the signed API call, which returns the handful of public fields
 * and refuses the rest. A SELECT grant here would make that restraint decorative -- the process
 * could simply read the balance column itself. */

ALTER ROLE donut_community_login SET statement_timeout = '8s';
ALTER ROLE donut_community_login SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE donut_community_login SET search_path = public;

COMMIT;
