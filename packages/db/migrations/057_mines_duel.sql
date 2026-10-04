BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Mines Duel
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two players, one hidden 5x5 field, one pot. Both stake the same, both turn tiles on the SAME
-- layout at the same time without seeing each other's progress, and whoever turns more safe tiles
-- before the clock runs out (or locks in) takes the pot less the house rake. One TNT and a player's
-- score is zero. Equal scores are a draw: both stakes go back whole and nothing is paid or counted.
--
-- Like Coinflip, the house has no side. See services/api-gateway/src/lib/mines-duel.ts for the
-- rules and routes/mines-duel.ts for the money.
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
      'coinflip_stake', 'coinflip_win', 'coinflip_refund',
      'dice_stake', 'dice_payout',
      'discord_join_reward', 'discord_tag_reward', 'discord_invite_reward',
      'mines_duel_stake', 'mines_duel_win', 'mines_duel_refund'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel'));

-- ── the games ──────────────────────────────────────────────────────────────
CREATE TABLE mines_duel_games (
  id uuid PRIMARY KEY,
  -- Short and URL-safe, the same shape as a duel, battle or coinflip code.
  code varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,12}$'),

  host_user_id uuid NOT NULL REFERENCES users(id),
  -- Null until somebody takes the game. Nobody duels themselves: that would launder a stake into
  -- wagered volume and farm rakeback at zero risk.
  opponent_user_id uuid REFERENCES users(id),
  CONSTRAINT mines_duel_distinct_players
    CHECK (opponent_user_id IS NULL OR opponent_user_id <> host_user_id),

  -- The wager PER PLAYER. Both sides stake the same.
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- Snapshots, so a settings change prices the NEXT game and never one already on the board.
  rake_bps integer NOT NULL CHECK (rake_bps >= 0 AND rake_bps <= 1000),
  play_seconds smallint NOT NULL CHECK (play_seconds BETWEEN 15 AND 600),
  mine_count smallint NOT NULL CHECK (mine_count BETWEEN 1 AND 20),

  status varchar(10) NOT NULL CHECK (status IN ('open', 'playing', 'settled', 'cancelled')),

  -- Committed when the game opens, revealed when it settles.
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_ciphertext text NOT NULL,
  server_seed_reveal char(64) CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),
  host_client_seed varchar(64) NOT NULL CHECK (host_client_seed ~ '^[A-Za-z0-9_-]{1,64}$'),
  opponent_client_seed varchar(64) CHECK (opponent_client_seed ~ '^[A-Za-z0-9_-]{1,64}$'),

  -- The field: bit i set means tile i (0-24, reading order) is TNT. Written when an opponent takes
  -- the game, and sent to nobody until the game settles -- it is the whole secret.
  mine_mask integer CHECK (mine_mask >= 0 AND mine_mask < 33554432),

  -- Each player's tiles, in the order they turned them, and where they stand.
  host_picks smallint[] NOT NULL DEFAULT '{}',
  opponent_picks smallint[] NOT NULL DEFAULT '{}',
  host_state varchar(7) NOT NULL DEFAULT 'playing' CHECK (host_state IN ('playing', 'locked', 'busted')),
  opponent_state varchar(7) NOT NULL DEFAULT 'playing' CHECK (opponent_state IN ('playing', 'locked', 'busted')),
  host_score smallint CHECK (host_score BETWEEN 0 AND 25),
  opponent_score smallint CHECK (opponent_score BETWEEN 0 AND 25),
  host_finished_at timestamptz,
  opponent_finished_at timestamptz,

  outcome varchar(8) CHECK (outcome IN ('host', 'opponent', 'draw')),
  winner_user_id uuid REFERENCES users(id),
  -- pot = 2 * stake; rake = pot * rake_bps / 10000; payout = pot - rake. A draw pays and keeps
  -- nothing: its pot, rake and payout are all zero and the stakes go back as refunds.
  pot_minor bigint CHECK (pot_minor >= 0),
  rake_minor bigint CHECK (rake_minor >= 0),
  payout_minor bigint CHECK (payout_minor >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  -- An open game nobody takes must not hold its host's money forever; the sweeper refunds it.
  expires_at timestamptz NOT NULL,
  -- A game in play ends at its deadline whatever either player does: whoever is still turning tiles
  -- is locked in where they stand, and the sweeper settles it.
  started_at timestamptz,
  deadline_at timestamptz,
  settled_at timestamptz,

  -- A game in play or settled has an opponent, a field and a clock; one that is not has none of them.
  CONSTRAINT mines_duel_started_has_a_field CHECK (
    (status IN ('playing', 'settled')) = (
      opponent_user_id IS NOT NULL AND opponent_client_seed IS NOT NULL
      AND mine_mask IS NOT NULL AND started_at IS NOT NULL AND deadline_at IS NOT NULL
    )
  ),
  -- A settled game carries its whole answer, and only a settled game carries any of it. An open or
  -- running game therefore cannot leak the reveal or the result.
  CONSTRAINT mines_duel_settled_is_complete CHECK (
    (status = 'settled') = (
      outcome IS NOT NULL AND server_seed_reveal IS NOT NULL AND settled_at IS NOT NULL
      AND host_score IS NOT NULL AND opponent_score IS NOT NULL
      AND pot_minor IS NOT NULL AND rake_minor IS NOT NULL AND payout_minor IS NOT NULL
    )
  ),
  CONSTRAINT mines_duel_winner_matches_outcome
    CHECK ((outcome IN ('host', 'opponent')) = (winner_user_id IS NOT NULL)),
  CONSTRAINT mines_duel_winner_is_a_player
    CHECK (winner_user_id IS NULL OR winner_user_id = host_user_id
           OR winner_user_id = opponent_user_id),
  CONSTRAINT mines_duel_rake_adds_up
    CHECK (pot_minor IS NULL OR pot_minor = rake_minor + payout_minor)
);

-- The board: open games, biggest stake first.
CREATE INDEX mines_duel_open_idx ON mines_duel_games (stake_minor DESC, created_at DESC)
  WHERE status = 'open';
-- The sweeper's two scans: lapsed open games, and games whose clock has run out.
CREATE INDEX mines_duel_expiry_idx ON mines_duel_games (expires_at) WHERE status = 'open';
CREATE INDEX mines_duel_deadline_idx ON mines_duel_games (deadline_at) WHERE status = 'playing';
-- The recent-duels strip and the live feed.
CREATE INDEX mines_duel_settled_idx ON mines_duel_games (settled_at DESC) WHERE status = 'settled';
CREATE INDEX mines_duel_host_idx ON mines_duel_games (host_user_id, created_at DESC);
CREATE INDEX mines_duel_opponent_idx ON mines_duel_games (opponent_user_id, created_at DESC)
  WHERE opponent_user_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON TABLE mines_duel_games TO donut_api_runtime;

-- Supersedes donut_schema_ready_v56.
CREATE FUNCTION donut_schema_ready_v57() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v57() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v57() TO donut_api_runtime;

COMMIT;
