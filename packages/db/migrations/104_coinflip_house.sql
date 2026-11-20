BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Coinflip against the house
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The owner, 2026-11-20: "just make coinflip a normal coinflip game". One player calls heads or
-- tails; the coin is read from their committed fairness seed (services/api-gateway/src/lib/coinflip.ts
-- houseFlip) and a matching call pays 1.8x. One request per flip, settled in one transaction, like
-- Dice and Limbo. It uses the coinflip ledger kinds ('coinflip_stake', 'coinflip_win') and the
-- 'coinflip' wager source, which every list already allows, so nothing else widens. The board of
-- player-against-player games (coinflip_games) is untouched: open games still lapse and refund.

CREATE TABLE coinflip_bets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  side varchar(5) NOT NULL CHECK (side IN ('heads', 'tails')),
  result varchar(5) NOT NULL CHECK (result IN ('heads', 'tails')),
  win boolean NOT NULL,
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  server_seed_reveal char(64) NOT NULL,
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- A seed flips one coin.
  UNIQUE (fairness_seed_id),
  -- A win is a call that matched the coin, and only a win pays.
  CHECK (win = (side = result)),
  CHECK (win = (payout_minor > 0))
);
CREATE INDEX coinflip_bets_user_idx ON coinflip_bets (user_id, created_at DESC);
CREATE INDEX coinflip_bets_feed_idx ON coinflip_bets (created_at DESC);

GRANT SELECT, INSERT ON TABLE coinflip_bets TO donut_api_runtime;

-- Supersedes donut_schema_ready_v103.
CREATE FUNCTION donut_schema_ready_v104() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v104() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v104() TO donut_api_runtime;

COMMIT;
