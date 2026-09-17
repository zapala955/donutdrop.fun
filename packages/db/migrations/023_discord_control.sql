BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Discord control plane — operator commands, one-time dashboard links, logs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR
-- ----------------
-- An operator runs slash commands in a private Discord guild and the platform answers: read a
-- player, read bot health, mint a link into the admin dashboard, or perform a moderation action.
-- Discord is a REMOTE CONTROL, never a source of truth — every figure it shows is read live from
-- these tables, and every action it takes lands in `audit_log` like any other administrative act.
--
-- THE SECURITY POSITION, STATED PLAINLY
-- -------------------------------------
-- `discord_admin_links` mints a token that, when redeemed, creates a FULLY AUTHENTICATED admin
-- session WITHOUT a TOTP challenge. That is a deliberate product decision and it has a cost worth
-- writing down next to the table rather than discovering later:
--
--   Everywhere else, an admin session requires the TOTP secret in ADMIN_TOTP_SECRETS_JSON, and
--   `authenticate()` re-checks the key fingerprint on every single request. That means possessing
--   the session cookie is not enough — an attacker also needs the authenticator. This table is the
--   one path that sidesteps it, so control of the operator's Discord account, of the bot token, or
--   of the guild is control of the platform.
--
-- Everything below is the compensating control for that decision:
--
--   * tokens are stored only as SHA-256 hashes, so a database leak cannot replay one;
--   * they expire in minutes, not hours (DISCORD_ADMIN_LINK_TTL_SECONDS, capped at 15 minutes);
--   * they are single-use, claimed by one atomic UPDATE that cannot race a second redemption;
--   * minting revokes every earlier unclaimed link for that operator, so at most one is ever live;
--   * the Discord user id is bound into the row, so a token minted for one operator cannot be
--     redeemed as another;
--   * issuance and redemption are both audited, with the redeeming IP hashed on the row.
--
-- The one thing this schema cannot do is make a Discord account as strong as an authenticator app.
-- If that becomes the concern, `require_totp` on `discord_admin_links` is the switch to flip: the
-- redemption path already reads it, and a link issued with it set leaves the session's MFA columns
-- null, which `authenticate()` rejects until the TOTP step completes.

-- ── one-time dashboard links ────────────────────────────────────────────────
CREATE TABLE discord_admin_links (
  id                uuid PRIMARY KEY,
  -- SHA-256 of the raw token. The raw value exists only in the URL handed to the operator and is
  -- never written down anywhere — not here, not in the command log, not in the audit details.
  token_hash        bytea NOT NULL UNIQUE,
  -- The Discord snowflake that asked. Bound into redemption so a leaked token is useless to a
  -- different operator even inside the same guild.
  discord_user_id   text NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  discord_guild_id  text CHECK (discord_guild_id IS NULL OR discord_guild_id ~ '^[0-9]{5,32}$'),
  -- The platform admin this link authenticates as. Resolved from the operator allowlist at mint
  -- time, so a later change to that allowlist cannot retroactively widen an outstanding token.
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- When set, redemption creates a session with NO MFA columns, which `authenticate()` refuses
  -- until the TOTP step runs. The escape hatch described in the header.
  require_totp      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  claimed_at        timestamptz,
  -- HMAC of the redeeming IP under IP_HASH_KEY, matching `sessions.ip_hash`. Stored so an
  -- unexpected redemption can be investigated without retaining a raw address.
  claimed_ip_hash   bytea,
  claimed_user_agent text,
  revoked_at        timestamptz,
  revoked_reason    text CHECK (revoked_reason IS NULL OR length(revoked_reason) <= 128),
  -- The session this link produced, kept so revoking a link can revoke what it created.
  session_id        uuid REFERENCES sessions(id) ON DELETE SET NULL,
  CONSTRAINT discord_admin_links_ttl_sane CHECK (expires_at > created_at),
  CONSTRAINT discord_admin_links_claim_coherent CHECK (
    (claimed_at IS NULL AND claimed_ip_hash IS NULL AND session_id IS NULL)
    OR (claimed_at IS NOT NULL AND claimed_ip_hash IS NOT NULL)
  )
);

-- The redemption lookup. Partial, because a claimed or revoked token is never looked up again.
CREATE INDEX discord_admin_links_live_idx
  ON discord_admin_links (token_hash)
  WHERE claimed_at IS NULL AND revoked_at IS NULL;
-- "Revoke every other live link for this operator", run on every mint.
CREATE INDEX discord_admin_links_operator_idx
  ON discord_admin_links (user_id, created_at DESC);
-- The retention sweeper's scan.
CREATE INDEX discord_admin_links_expiry_idx ON discord_admin_links (expires_at);

-- ── the command log ─────────────────────────────────────────────────────────
--
-- Every invocation, including the ones that were refused. A log that records only successful
-- commands cannot answer the question anybody actually asks after an incident, which is who tried.
--
-- This is operational logging and is deliberately NOT the audit log: `audit_log` is a hash-chained
-- record of things that changed money or state, and filling it with `/stats` lookups would bury
-- the entries that matter. Commands that DO change something write to both.
CREATE TABLE discord_command_invocations (
  id                uuid PRIMARY KEY,
  discord_user_id   text NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  discord_guild_id  text CHECK (discord_guild_id IS NULL OR discord_guild_id ~ '^[0-9]{5,32}$'),
  discord_channel_id text CHECK (discord_channel_id IS NULL OR discord_channel_id ~ '^[0-9]{5,32}$'),
  command           text NOT NULL CHECK (command ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- Redacted at the call site before it arrives. Free-text arguments are truncated and anything
  -- resembling a secret is dropped rather than stored.
  arguments         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL when the caller was not a recognised operator, which is exactly the case worth reviewing.
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome           text NOT NULL CHECK (outcome IN ('ok', 'denied', 'rate_limited', 'error')),
  error_code        text CHECK (error_code IS NULL OR length(error_code) <= 64),
  latency_ms        integer CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 600000),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discord_command_invocations_recent_idx
  ON discord_command_invocations (created_at DESC);
CREATE INDEX discord_command_invocations_actor_idx
  ON discord_command_invocations (discord_user_id, created_at DESC);
-- Finding refusals quickly is the point of keeping them.
CREATE INDEX discord_command_invocations_denied_idx
  ON discord_command_invocations (created_at DESC)
  WHERE outcome <> 'ok';

-- ── two-step confirmation for destructive commands ──────────────────────────
--
-- A moderation command typed into a chat box is one autocomplete away from being the wrong player
-- and one stray Enter away from being executed. Destructive commands therefore return a summary
-- and a nonce; nothing happens until that exact nonce comes back.
--
-- The nonce is stored hashed and consumed atomically, so it is also a CSRF token in spirit: a
-- component id forged by somebody else in the guild will not match a row.
CREATE TABLE discord_action_confirmations (
  id              uuid PRIMARY KEY,
  nonce_hash      bytea NOT NULL UNIQUE,
  discord_user_id text NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  actor_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action          text NOT NULL CHECK (action ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- The exact, already-validated parameters. Re-validated on consumption anyway: a row is data,
  -- and data that has been sitting in a table is not a reason to skip a check.
  payload         jsonb NOT NULL,
  -- Shown back to the operator so they confirm what they are about to do, not merely that they
  -- pressed a button.
  summary         text NOT NULL CHECK (length(summary) BETWEEN 1 AND 512),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  CONSTRAINT discord_action_confirmations_ttl_sane CHECK (expires_at > created_at)
);

CREATE INDEX discord_action_confirmations_live_idx
  ON discord_action_confirmations (nonce_hash)
  WHERE consumed_at IS NULL;
CREATE INDEX discord_action_confirmations_expiry_idx
  ON discord_action_confirmations (expires_at);

-- ── per-operator command rate limiting ──────────────────────────────────────
--
-- Kept in Postgres rather than in the bot's memory on purpose: the limit has to survive a bot
-- restart, or the way past it is to crash the bot. One row per operator per window.
CREATE TABLE discord_command_budgets (
  discord_user_id text NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  window_started_at timestamptz NOT NULL,
  spent           integer NOT NULL DEFAULT 0 CHECK (spent >= 0),
  PRIMARY KEY (discord_user_id, window_started_at)
);

CREATE INDEX discord_command_budgets_window_idx ON discord_command_budgets (window_started_at);

-- ── least privilege ─────────────────────────────────────────────────────────
--
-- The runtime mints links and marks them claimed; it may never DELETE one, because a deleted link
-- is a redemption nobody can prove happened. The sweeper prunes expired rows under its own role.
GRANT SELECT, INSERT, UPDATE ON TABLE discord_admin_links TO donut_api_runtime;
-- The command log is evidence. Insert only: no UPDATE, no DELETE, same posture as `wager_events`.
GRANT SELECT, INSERT ON TABLE discord_command_invocations TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE discord_action_confirmations TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE discord_command_budgets TO donut_api_runtime;
-- Expired links, spent confirmations and stale budget windows are prunable; the log is not.
GRANT DELETE ON TABLE discord_admin_links, discord_action_confirmations, discord_command_budgets
  TO donut_api_runtime;

COMMIT;
