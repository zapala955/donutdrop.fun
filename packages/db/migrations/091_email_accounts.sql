BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Email on accounts (2026-11-10)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player can link an email address to their account, sign in with a one-time code sent to it,
-- and, once one is linked, move their account to a different Minecraft account (proved the way a
-- sign-up is: by paying the bot from it). Additive only: new nullable columns, new tables, and one
-- new nullable column on auth_link_challenges. No existing row is rewritten.

-- ── the address, on the account ────────────────────────────────────────────
-- Stored only once verified, lower-cased, one account per address.
ALTER TABLE users
  ADD COLUMN email varchar(254),
  ADD COLUMN email_verified_at timestamptz,
  -- When the account last moved to a different Minecraft account.
  ADD COLUMN minecraft_relinked_at timestamptz;

ALTER TABLE users
  ADD CONSTRAINT users_email_verified CHECK ((email IS NULL) = (email_verified_at IS NULL)),
  ADD CONSTRAINT users_email_shape CHECK (
    email IS NULL OR (email = lower(btrim(email)) AND email LIKE '_%@_%._%')
  );

CREATE UNIQUE INDEX users_email_idx ON users (email) WHERE email IS NOT NULL;

-- ── one-time codes ─────────────────────────────────────────────────────────
-- link     proves a new address (sent to it)
-- login    signs in to the account an address belongs to
-- confirm  proves the current address before a change: a new address, removing it, or moving the
--          account to another Minecraft account
-- Only an HMAC of the code is kept. Five attempts and ten minutes per code.
CREATE TABLE email_codes (
  id uuid PRIMARY KEY,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('link', 'login', 'confirm')),
  user_id uuid REFERENCES users(id),
  email varchar(254) NOT NULL CHECK (email = lower(btrim(email))),
  code_hash bytea NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  ip_hash bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_codes_email_idx ON email_codes (email, purpose, created_at DESC);
CREATE INDEX email_codes_user_idx ON email_codes (user_id, purpose, created_at DESC);

-- ── every email the site sends ─────────────────────────────────────────────
-- The provider's plan caps sends per day; the site counts these over the last 24 hours and stops
-- before the cap. The address itself is not kept here, only what the email was for.
CREATE TABLE email_sends (
  id uuid PRIMARY KEY,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('link', 'login', 'confirm', 'notice')),
  user_id uuid REFERENCES users(id),
  status varchar(8) NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX email_sends_recent_idx ON email_sends (created_at DESC);

-- ── moving an account to another Minecraft account ─────────────────────────
-- The payment challenge that proves the new account is an ordinary pay-login challenge marked with
-- the account it is for. A marked challenge can only complete a move, never a sign-in.
ALTER TABLE auth_link_challenges ADD COLUMN relink_user_id uuid REFERENCES users(id);

-- Every move, kept. Also what stops a Minecraft account an account has moved away from collecting a
-- second sign-up bonus by signing up afresh.
CREATE TABLE minecraft_relinks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  old_identity varchar(80) NOT NULL,
  old_username varchar(16) NOT NULL,
  new_identity varchar(80) NOT NULL,
  new_username varchar(16) NOT NULL,
  challenge_id uuid NOT NULL UNIQUE REFERENCES auth_link_challenges(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX minecraft_relinks_user_idx ON minecraft_relinks (user_id, created_at DESC);
CREATE INDEX minecraft_relinks_old_identity_idx ON minecraft_relinks (old_identity);

GRANT SELECT, INSERT, UPDATE ON TABLE email_codes TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE email_sends TO donut_api_runtime;
GRANT SELECT, INSERT ON TABLE minecraft_relinks TO donut_api_runtime;

-- Supersedes donut_schema_ready_v90.
CREATE FUNCTION donut_schema_ready_v91() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v91() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v91() TO donut_api_runtime;

COMMIT;
