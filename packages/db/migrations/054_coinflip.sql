BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Coinflip
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Player against player. A host stakes on a side and opens the game; another player matches the
-- stake, takes the other side, and the coin is flipped and settled in the request that joins it.
-- The house holds no side and charges no edge on the result: it is paid a rake on the pot, like a
-- skill duel, snapshot onto the row at creation so an operator cannot change the fee under a game
-- already on the board. See services/api-gateway/src/lib/coinflip.ts for the flip itself.
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
      'mines_stake', 'mines_payout',
      'plinko_stake', 'plinko_payout',
      'coinflip_stake', 'coinflip_win', 'coinflip_refund'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip'));

-- ── the games ──────────────────────────────────────────────────────────────
CREATE TABLE coinflip_games (
  id uuid PRIMARY KEY,
  -- Short and URL-safe, the same shape as a duel or battle code.
  code varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,12}$'),

  host_user_id uuid NOT NULL REFERENCES users(id),
  host_side varchar(5) NOT NULL CHECK (host_side IN ('heads', 'tails')),
  -- Null until somebody takes the other side. Nobody flips against themselves: that would launder
  -- a stake into wagered volume and farm rakeback at zero risk.
  opponent_user_id uuid REFERENCES users(id),
  CONSTRAINT coinflip_distinct_players
    CHECK (opponent_user_id IS NULL OR opponent_user_id <> host_user_id),

  -- The wager PER PLAYER. Both sides stake the same.
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  rake_bps integer NOT NULL CHECK (rake_bps >= 0 AND rake_bps <= 1000),

  status varchar(10) NOT NULL CHECK (status IN ('open', 'settled', 'cancelled')),

  -- Committed when the game opens, revealed when the coin lands.
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_ciphertext text NOT NULL,
  server_seed_reveal char(64) CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),
  host_client_seed varchar(64) NOT NULL CHECK (host_client_seed ~ '^[A-Za-z0-9_-]{1,64}$'),
  opponent_client_seed varchar(64) CHECK (opponent_client_seed ~ '^[A-Za-z0-9_-]{1,64}$'),

  result varchar(5) CHECK (result IN ('heads', 'tails')),
  winner_user_id uuid REFERENCES users(id),
  -- pot = 2 * stake; rake = pot * rake_bps / 10000; payout = pot - rake.
  pot_minor bigint CHECK (pot_minor >= 0),
  rake_minor bigint CHECK (rake_minor >= 0),
  payout_minor bigint CHECK (payout_minor >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  -- An open game nobody takes must not hold its host's money forever; the sweeper refunds it.
  expires_at timestamptz NOT NULL,

  -- A settled game carries its whole answer, and only a settled game carries any of it. An open
  -- game therefore cannot leak the reveal or the result while it is still taking an opponent.
  CONSTRAINT coinflip_settled_is_complete CHECK (
    (status = 'settled') = (
      opponent_user_id IS NOT NULL AND opponent_client_seed IS NOT NULL
      AND result IS NOT NULL AND winner_user_id IS NOT NULL
      AND server_seed_reveal IS NOT NULL AND settled_at IS NOT NULL
      AND pot_minor IS NOT NULL AND rake_minor IS NOT NULL AND payout_minor IS NOT NULL
    )
  ),
  CONSTRAINT coinflip_open_holds_no_answer
    CHECK (status = 'settled' OR (server_seed_reveal IS NULL AND result IS NULL)),
  CONSTRAINT coinflip_rake_adds_up
    CHECK (pot_minor IS NULL OR pot_minor = rake_minor + payout_minor),
  CONSTRAINT coinflip_winner_is_a_player
    CHECK (winner_user_id IS NULL OR winner_user_id = host_user_id
           OR winner_user_id = opponent_user_id)
);

-- The board: open games, biggest stake first.
CREATE INDEX coinflip_games_open_idx ON coinflip_games (stake_minor DESC, created_at DESC)
  WHERE status = 'open';
-- The sweeper's scan for lapsed games.
CREATE INDEX coinflip_games_expiry_idx ON coinflip_games (expires_at) WHERE status = 'open';
-- The recent-flips strip and the live feed.
CREATE INDEX coinflip_games_settled_idx ON coinflip_games (settled_at DESC) WHERE status = 'settled';
CREATE INDEX coinflip_games_host_idx ON coinflip_games (host_user_id, created_at DESC);
CREATE INDEX coinflip_games_opponent_idx ON coinflip_games (opponent_user_id, created_at DESC)
  WHERE opponent_user_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON TABLE coinflip_games TO donut_api_runtime;

-- Supersedes donut_schema_ready_v53.
CREATE FUNCTION donut_schema_ready_v54() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v54() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v54() TO donut_api_runtime;

COMMIT;
