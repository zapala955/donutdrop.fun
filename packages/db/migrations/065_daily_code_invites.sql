BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Daily code invitations
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An owner can send every member one first message about daily codes (`/daily-invite send`), and the
-- welcome DM carries the same offer. This table is what makes "one message, ever" true for both: a
-- member is recorded here BEFORE the message goes out, so a restart half way through a broadcast
-- resumes where it stopped, a second run skips everybody who has had it, and nobody is ever invited
-- twice.
--
-- Additive: one new table and one new function; nothing existing changes.

CREATE TABLE discord_daily_invites (
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  discord_user_id varchar(32) NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  -- 'claimed' is written first and means "about to be sent": if the bot dies between the claim and
  -- the send the member is simply not invited, which is better than a second message. 'sent' and
  -- 'closed' (their DMs are closed) are the two ways it ends.
  outcome varchar(8) NOT NULL DEFAULT 'claimed' CHECK (outcome IN ('claimed', 'sent', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE discord_daily_invites TO donut_api_runtime;

-- The bot may run under its own narrower role (infra/postgres/community-bot-role.sql); where that
-- role exists it needs this table too, and where it does not the grant above already covers it.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_community_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE discord_daily_invites TO donut_community_runtime;
  END IF;
END
$grants$;

-- Supersedes donut_schema_ready_v64.
CREATE FUNCTION donut_schema_ready_v65() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v65() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v65() TO donut_api_runtime;

COMMIT;
