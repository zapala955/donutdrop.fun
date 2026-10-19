BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Log in with Discord
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player whose Discord is already linked (the bot's /link code, or the referral verification)
-- can sign in with it instead of paying the bot again. Only accounts that ALREADY carry a
-- discord_user_id can be reached this way: the Discord round trip never creates or links an
-- account, it only finds one. Administrator accounts are refused, because their sessions need the
-- TOTP that only the Minecraft sign-in asks for. See services/api-gateway/src/routes/discord-login.ts.
--
-- One row is one sign-in attempt, in three steps:
--   start     the site mints a state (sent to Discord) and a browser token (kept in an httpOnly
--             cookie). Only their hashes are stored.
--   callback  Discord sends the browser back with the state. It is spent once, the code is
--             exchanged, and the linked account is written onto the row.
--   complete  the page that the callback lands on asks for the session with the cookie. Only the
--             browser that started the attempt holds it, so a callback link handed to somebody
--             else cannot sign them into the sender's account (login CSRF) or the reverse.
--
-- Additive: one new table; nothing existing is rewritten.

CREATE TABLE discord_login_states (
  state_hash char(64) PRIMARY KEY,
  browser_token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  callback_at timestamptz,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  discord_user_id varchar(32),
  completed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((user_id IS NULL) = (discord_user_id IS NULL))
);
CREATE INDEX discord_login_states_expiry_idx ON discord_login_states (expires_at);

-- UPDATE: the callback and the completion each move an existing row on.
-- DELETE: attempts are swept a day after they expire rather than kept forever.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE discord_login_states TO donut_api_runtime;

-- Supersedes donut_schema_ready_v72.
CREATE FUNCTION donut_schema_ready_v73() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v73() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v73() TO donut_api_runtime;

COMMIT;
