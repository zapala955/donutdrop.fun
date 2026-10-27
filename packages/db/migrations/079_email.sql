BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Email: a second way in, and the key to paying a different name
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player can link an email to their account (confirmed with a code sent to it) and then:
--   - sign in with a code sent to that email, as a second option beside the Minecraft sign-in;
--   - withdraw to a different Minecraft name, confirmed with a code sent to that email and bound to
--     that exact amount and name.
-- Until now the bot only ever paid the account's own verified name, so a stolen session could not
-- send money elsewhere. The email code is what stands in for that now, which is why an email can be
-- removed only with a code sent to it, and why a freshly linked email cannot confirm a payout to
-- another name for 24 hours (routes/email.ts).
--
-- One account per email: the unique index below. Only a confirmed email is ever stored; the
-- address and its confirmation time are written together or not at all.
--
-- Additive: two columns and one table; nothing existing is rewritten.

ALTER TABLE users
  ADD COLUMN email varchar(254),
  ADD COLUMN email_verified_at timestamptz,
  ADD CONSTRAINT users_email_verified_check CHECK (num_nonnulls(email, email_verified_at) IN (0, 2)),
  ADD CONSTRAINT users_email_shape_check
    CHECK (email IS NULL OR (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

CREATE UNIQUE INDEX users_email_idx ON users (email) WHERE email IS NOT NULL;

-- One row per code sent. Only an HMAC of the code is stored, it works once, for ten minutes, for
-- five tries. A sign-in code is also tied to the browser that asked for it (the token in an
-- httpOnly cookie), so a code read off somebody's screen signs nobody else in; a withdrawal code is
-- tied to the amount and the name it was sent for.
CREATE TABLE email_codes (
  id uuid PRIMARY KEY,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('link', 'login', 'remove', 'withdraw')),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email varchar(254) NOT NULL,
  code_hash char(64) NOT NULL,
  browser_token_hash char(64),
  payee_username varchar(16),
  amount_minor bigint CHECK (amount_minor > 0),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((purpose = 'login') = (browser_token_hash IS NOT NULL)),
  CHECK ((purpose = 'withdraw') = (payee_username IS NOT NULL AND amount_minor IS NOT NULL))
);
CREATE INDEX email_codes_user_idx ON email_codes (user_id, purpose, created_at DESC);
CREATE INDEX email_codes_email_idx ON email_codes (email, created_at DESC);
CREATE INDEX email_codes_browser_idx ON email_codes (browser_token_hash)
  WHERE browser_token_hash IS NOT NULL;
CREATE INDEX email_codes_expiry_idx ON email_codes (expires_at);

-- UPDATE: a try and a use move a row on. DELETE: codes are swept a day after they expire.
-- users needs no new grant: it already carries UPDATE from 002.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_codes TO donut_api_runtime;

-- Supersedes donut_schema_ready_v78.
CREATE FUNCTION donut_schema_ready_v79() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v79() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v79() TO donut_api_runtime;

COMMIT;
