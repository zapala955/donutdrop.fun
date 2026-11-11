-- Code drops (2026-11-11): they replace the daily codes.
--
-- Every two hours the community bot posts ONE code in the code-drop channel, pinging the role that
-- asked for it. The first few players to redeem it on the site (five by default) get the prize
-- ($10M by default), which they must wager three times over before it can be withdrawn. Nothing
-- has to be wagered to claim one.
--
-- The site owns every figure: a drop is minted by the gateway (lib/code-drops.ts) when the bot asks
-- for the current one, with the prize, the claim limit and the wager multiplier copied onto its row
-- then, so changing the settings never changes a code already posted. The bot only posts it.
--
-- Additive only: two new tables. The daily-code tables (064, 065) are left as they are, with their
-- history.

BEGIN;

CREATE TABLE discord_code_drops (
  id uuid PRIMARY KEY,
  -- The start of the slot this drop belongs to (every two hours by default, counted from the Unix
  -- epoch, so the slots are the same whoever asks). One drop per slot: two asks at once mint one.
  slot_start timestamptz NOT NULL UNIQUE,
  -- Eight characters from an alphabet without 0, 1, I or O, as the daily codes were.
  code varchar(8) NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  prize_minor bigint NOT NULL CHECK (prize_minor > 0),
  max_claims smallint NOT NULL CHECK (max_claims BETWEEN 1 AND 1000),
  -- How many have claimed it. Raised by a guarded UPDATE (claims < max_claims) in the same
  -- transaction as the claim row and the payment, so the limit cannot be passed however many
  -- arrive at once.
  claims smallint NOT NULL DEFAULT 0,
  wager_multiplier smallint NOT NULL CHECK (wager_multiplier BETWEEN 0 AND 100),
  expires_at timestamptz NOT NULL,
  -- Set when the bot takes the drop to post it, BEFORE it posts, so two bot ticks post it once;
  -- cleared again if the post failed, so a later tick tries again.
  announced_at timestamptz,
  channel_id varchar(32) CHECK (channel_id ~ '^[0-9]{5,32}$'),
  message_id varchar(32) CHECK (message_id ~ '^[0-9]{5,32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (claims BETWEEN 0 AND max_claims),
  CHECK (expires_at > slot_start)
);

CREATE TABLE discord_code_drop_claims (
  id uuid PRIMARY KEY,
  drop_id uuid NOT NULL REFERENCES discord_code_drops(id),
  user_id uuid NOT NULL REFERENCES users(id),
  -- The Discord account linked to that site account when it claimed. One claim per drop for each,
  -- so a Discord carrying several site accounts (migration 075) claims once, not once per account.
  discord_user_id varchar(32) NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  prize_minor bigint NOT NULL CHECK (prize_minor > 0),
  wager_minor bigint NOT NULL CHECK (wager_minor >= 0),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drop_id, user_id),
  UNIQUE (drop_id, discord_user_id)
);
CREATE INDEX discord_code_drop_claims_user_idx ON discord_code_drop_claims (user_id, claimed_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE discord_code_drops TO donut_api_runtime;
GRANT SELECT, INSERT ON TABLE discord_code_drop_claims TO donut_api_runtime;

-- Supersedes donut_schema_ready_v91.
CREATE FUNCTION donut_schema_ready_v92() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v92() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v92() TO donut_api_runtime;

COMMIT;
