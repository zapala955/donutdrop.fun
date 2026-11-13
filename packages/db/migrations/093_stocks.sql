BEGIN;

-- Stocks (2026-11-13). One shared price chart that ticks every 100ms, and positions on it: long or
-- short, at up to 1000x leverage. The owner: "its basically like a chart that goes up and down yk
-- like crypto or stocks and ppl can long or short it with a leverage of up to 1000x", with a 10%
-- edge and the same kind of payout cap as the other games.
--
-- The chart is cut into epochs. Each epoch's server seed is committed (its SHA-256) before the
-- epoch starts and revealed once it ends; every price in it follows from that seed (lib/stocks.ts),
-- so nobody -- the house included -- can steer it once the hash is out. Additive only, apart from
-- the four source/kind lists, which gain the new game exactly as migration 090 did for Limbo.

ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake', 'vault_yield', 'piggy_open',
      'piggy_claim', 'piggy_break', 'upgrade_win', 'case_win', 'quest_reward', 'streak_reward',
      'faction_payout', 'battle_stake', 'battle_win', 'battle_refund', 'creator_royalty',
      'referral_revshare', 'referral_bonus', 'rakeback_claim', 'race_payout', 'duel_stake',
      'duel_win', 'duel_refund', 'slither_stake', 'slither_cashout', 'slither_refund',
      'jackpot_win', 'rain_claim', 'tip_sent', 'tip_received', 'sidebet_stake', 'sidebet_win',
      'sidebet_refund', 'pay_login_deposit', 'cash_deposit', 'cash_withdrawal',
      'cash_withdrawal_refund', 'roulette_stake', 'roulette_win', 'signup_bonus',
      'blackjack_stake', 'blackjack_double', 'blackjack_payout', 'crash_stake', 'crash_payout',
      'mines_stake', 'mines_payout', 'plinko_stake', 'plinko_payout', 'coinflip_stake',
      'coinflip_win', 'coinflip_refund', 'dice_stake', 'dice_payout', 'discord_join_reward',
      'discord_tag_reward', 'discord_invite_reward', 'mines_duel_stake', 'mines_duel_win',
      'mines_duel_refund', 'daily_code_reward', 'demo_topup', 'tower_stake', 'tower_payout',
      'chicken_stake', 'chicken_payout', 'slots_stake', 'slots_payout', 'fishing_stake',
      'fishing_payout', 'ice_fishing_stake', 'ice_fishing_payout', 'derby_stake', 'derby_payout',
      'bounty_reward', 'staking_stake', 'staking_release', 'staking_reward',
      'weekly_quest_reward', 'feedback_reward',
      'limbo_stake', 'limbo_payout',
      'stocks_stake', 'stocks_payout'
    ));

ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby', 'limbo', 'stocks'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby', 'limbo', 'stocks'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby', 'limbo', 'stocks'));

-- One stretch of the chart: `ticks` prices, `tick_ms` apart, from `starts_at`. Epochs follow each
-- other without gaps; the next one is written (and its hash published) before this one ends.
CREATE TABLE stocks_epochs (
  id uuid PRIMARY KEY,
  seq bigint NOT NULL UNIQUE CHECK (seq >= 0),
  starts_at timestamptz NOT NULL UNIQUE,
  tick_ms integer NOT NULL CHECK (tick_ms BETWEEN 50 AND 10000),
  ticks integer NOT NULL CHECK (ticks BETWEEN 10 AND 1000000),
  step_ppm integer NOT NULL CHECK (step_ppm BETWEEN 1 AND 10000),
  -- The price is 1000 · (1 + step)^level (lib/stocks.ts); the epoch starts at this level.
  start_level integer NOT NULL,
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_ciphertext text NOT NULL,
  server_seed_reveal char(64) CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stocks_positions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  side varchar(5) NOT NULL CHECK (side IN ('long', 'short')),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  leverage integer NOT NULL CHECK (leverage BETWEEN 1 AND 10000),
  -- The fee as a share of the stake, in parts per million (lib/stocks.ts), and the grid step the
  -- position was opened on: its maths are fixed when it opens, whatever the chart does later.
  fee_ppm integer NOT NULL CHECK (fee_ppm BETWEEN 0 AND 999999),
  step_ppm integer NOT NULL CHECK (step_ppm BETWEEN 1 AND 10000),
  max_payout_minor bigint NOT NULL CHECK (max_payout_minor > stake_minor),
  -- Every decision is made on grid levels: the open, the liquidation level (exactly where the loss
  -- equals the stake) and the cap level (null when unreachable). The prices beside them are the
  -- same points written out, for display and records.
  open_level integer NOT NULL,
  liquidation_level integer NOT NULL,
  cap_level integer,
  open_price numeric(30, 10) NOT NULL CHECK (open_price > 0),
  entry_price numeric(30, 10) NOT NULL CHECK (entry_price > 0),
  liquidation_price numeric(30, 10) NOT NULL CHECK (liquidation_price > 0),
  cap_price numeric(30, 10) CHECK (cap_price > 0),
  opened_epoch bigint NOT NULL,
  opened_tick integer NOT NULL CHECK (opened_tick >= 0),
  status varchar(12) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'liquidated', 'capped')),
  close_level integer,
  close_price numeric(30, 10) CHECK (close_price > 0),
  closed_epoch bigint,
  closed_tick integer CHECK (closed_tick >= 0),
  payout_minor bigint CHECK (payout_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (user_id, idempotency_key),
  CHECK ((status = 'open') = (settled_at IS NULL)),
  CHECK ((status = 'open') = (payout_minor IS NULL)),
  CHECK (status <> 'liquidated' OR payout_minor = 0),
  CHECK (payout_minor IS NULL OR payout_minor <= max_payout_minor),
  CHECK ((side = 'long') = (liquidation_level < open_level)),
  CHECK ((status = 'open') = (close_level IS NULL))
);
CREATE INDEX stocks_positions_open_idx ON stocks_positions (opened_epoch, opened_tick) WHERE status = 'open';
CREATE INDEX stocks_positions_user_idx ON stocks_positions (user_id, created_at DESC);
CREATE INDEX stocks_positions_feed_idx ON stocks_positions (settled_at DESC) WHERE settled_at IS NOT NULL;

-- How far the liquidation sweep has got: every tick up to (epoch, tick) has been checked against
-- every position that was open at it. A close only has to check the ticks after this itself.
CREATE TABLE stocks_sweep (
  id smallint PRIMARY KEY CHECK (id = 1),
  epoch bigint NOT NULL,
  tick integer NOT NULL CHECK (tick >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON TABLE stocks_epochs TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE stocks_positions TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE stocks_sweep TO donut_api_runtime;

CREATE FUNCTION donut_schema_ready_v93() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v93() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v93() TO donut_api_runtime;

COMMIT;
