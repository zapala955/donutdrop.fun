BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Mines
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One game per row, played across several requests: start, then reveal tiles one at a time until
-- the player cashes out or turns TNT. The TNT is placed at the start from the player's committed
-- fairness seed (see services/api-gateway/src/lib/mines.ts) and kept in the row; the API never
-- sends it, or the seed, to a browser until the game is over.
--
-- Every change to an existing table below WIDENS a constraint. Widening cannot fail against
-- existing rows; narrowing is how migration 030 took production down.

-- ── the ledger kinds ───────────────────────────────────────────────────────
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake',
      'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break',
      'upgrade_win', 'case_win', 'quest_reward', 'streak_reward', 'faction_payout',
      'battle_stake', 'battle_win', 'battle_refund', 'creator_royalty',
      'referral_revshare', 'referral_bonus',
      'rakeback_claim', 'race_payout',
      'duel_stake', 'duel_win', 'duel_refund',
      'slither_stake', 'slither_cashout', 'slither_refund',
      'jackpot_win', 'rain_claim', 'tip_sent', 'tip_received',
      'sidebet_stake', 'sidebet_win', 'sidebet_refund',
      'pay_login_deposit', 'cash_deposit',
      'cash_withdrawal', 'cash_withdrawal_refund',
      'roulette_stake', 'roulette_win',
      'signup_bonus',
      'blackjack_stake', 'blackjack_double', 'blackjack_payout',
      'crash_stake', 'crash_payout',
      'mines_stake', 'mines_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines'));

-- ── the games ──────────────────────────────────────────────────────────────
CREATE TABLE mines_games (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  mine_count smallint NOT NULL CHECK (mine_count BETWEEN 1 AND 24),
  -- The TNT, 0-24 in reading order. Secret until the game settles.
  mine_tiles smallint[] NOT NULL,
  -- Safe tiles turned so far, in the order they were turned.
  revealed_tiles smallint[] NOT NULL DEFAULT '{}',
  -- The payout ceiling that applied when the game started.
  max_payout_minor bigint NOT NULL CHECK (max_payout_minor > 0),
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
  outcome varchar(10) CHECK (outcome IN ('cashout', 'mine')),
  -- The TNT tile turned, when that is how it ended.
  mine_hit smallint CHECK (mine_hit BETWEEN 0 AND 24),
  payout_minor bigint CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  -- Written at settlement and not before.
  server_seed_reveal char(64),
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (user_id, idempotency_key),
  CHECK (cardinality(mine_tiles) = mine_count),
  CHECK (cardinality(revealed_tiles) <= 25 - mine_count),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status = 'active'
         OR (outcome IS NOT NULL AND payout_minor IS NOT NULL AND server_seed_reveal IS NOT NULL)),
  CHECK (status = 'settled' OR (server_seed_reveal IS NULL AND outcome IS NULL AND payout_minor IS NULL)),
  CHECK (outcome IS DISTINCT FROM 'mine' OR (mine_hit IS NOT NULL AND payout_minor = 0))
);

-- One game in play per player, refused by the index rather than by a read in the handler: two
-- clicks half a second apart both pass a read.
CREATE UNIQUE INDEX mines_games_one_active_idx ON mines_games (user_id) WHERE status = 'active';
CREATE INDEX mines_games_user_idx ON mines_games (user_id, created_at DESC);
-- The live feed reads settled games newest-first.
CREATE INDEX mines_games_feed_idx ON mines_games (settled_at DESC) WHERE status = 'settled';

GRANT SELECT, INSERT, UPDATE ON TABLE mines_games TO donut_api_runtime;

-- Supersedes donut_schema_ready_v50.
CREATE FUNCTION donut_schema_ready_v51() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v51() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v51() TO donut_api_runtime;

COMMIT;
