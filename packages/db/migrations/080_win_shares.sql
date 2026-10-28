BEGIN;

-- Win cards. A player shares one of their own settled wins as a short link (/w/<id>) that previews
-- in Discord, X and the rest as a picture of that win, and brings whoever follows it in on the
-- player's invite code.
--
-- The round is copied here at the moment it is shared -- game, bet, payout, the player's name and
-- invite code -- so a link posted today reads the same next month, whatever becomes of the account
-- or the round tables in between. Only the API writes rows, and only for a round the database
-- itself says the player won; nothing on a card ever comes from the browser.
--
-- 079 is left free on purpose: it belongs to the email work, which ships separately.
CREATE TABLE win_shares (
  -- Eight characters from the referral-code alphabet: short enough to read off a screenshot.
  id varchar(8) PRIMARY KEY CHECK (id ~ '^[A-HJ-NP-Z2-9]{8}$'),
  user_id uuid NOT NULL REFERENCES users(id),
  game varchar(40) NOT NULL,
  round_id uuid NOT NULL,
  player_name varchar(32) NOT NULL,
  wager_minor bigint NOT NULL CHECK (wager_minor > 0),
  payout_minor bigint NOT NULL CHECK (payout_minor > wager_minor),
  -- Null when the player could not invite anybody when they shared (the programme was off, or
  -- their referrals were blocked): the link then opens the site without a code.
  referral_code varchar(16),
  -- Visitors the link sent to the site. Link previews are not counted.
  views integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Sharing the same round twice hands back the same link.
  UNIQUE (user_id, game, round_id)
);

GRANT SELECT, INSERT ON TABLE win_shares TO donut_api_runtime;
GRANT UPDATE (views) ON TABLE win_shares TO donut_api_runtime;

-- Supersedes donut_schema_ready_v78.
CREATE FUNCTION donut_schema_ready_v80() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v80() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v80() TO donut_api_runtime;

COMMIT;
