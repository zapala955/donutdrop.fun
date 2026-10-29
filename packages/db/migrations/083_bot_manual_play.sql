BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- A bot switched off for manual play
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The owner sometimes needs to log into a bot's Minecraft account by hand. The bot has to be out
-- of the way first -- DonutSMP lets one session per account in -- and has to STAY out until the
-- owner is done, rather than knocking every minute and kicking them.
--
-- parked_at set means: the bot finishes any payout it is part-way through, logs out, and does not
-- log in again (the connection route it asks before every login says so); no job is handed to it;
-- and players are not sent to it to deposit, because a payment made while the owner is in the
-- account shows up in the owner's chat, never in the bot's, and nobody would be credited for it.
-- Cleared, the bot logs back in within half a minute.
--
-- Additive and nullable: a bot nobody switched off behaves exactly as before.

ALTER TABLE bot_accounts
  ADD COLUMN parked_at timestamptz,
  ADD COLUMN parked_by uuid REFERENCES users(id);

-- Supersedes donut_schema_ready_v82.
CREATE FUNCTION donut_schema_ready_v83() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v83() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v83() TO donut_api_runtime;

COMMIT;
