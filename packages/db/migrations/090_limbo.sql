BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Limbo
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pick a target multiplier; the server draws one from the player's committed fairness seed
-- (services/api-gateway/src/lib/limbo.ts), and the bet wins if the draw reaches the target. One
-- request per bet, settled in one transaction, like Dice. Two ledger kinds and one wager source,
-- each a widening of its list, so every existing row still satisfies it.

-- ── the ledger ─────────────────────────────────────────────────────────────
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
      'limbo_stake', 'limbo_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby', 'limbo'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby', 'limbo'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby', 'limbo'));

-- ── the bets ───────────────────────────────────────────────────────────────
CREATE TABLE limbo_bets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- The target and the draw, in hundredths of a multiplier: 2.00x is 200. The draw starts at 0.90x.
  target_x100 integer NOT NULL CHECK (target_x100 BETWEEN 101 AND 100000000),
  result_x100 integer NOT NULL CHECK (result_x100 BETWEEN 90 AND 100000000),
  win boolean NOT NULL,
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  server_seed_reveal char(64) NOT NULL,
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- A seed draws one bet.
  UNIQUE (fairness_seed_id),
  -- A win is a draw that reached the target, and only a win pays.
  CHECK (win = (result_x100 >= target_x100)),
  CHECK (win = (payout_minor > 0))
);
CREATE INDEX limbo_bets_user_idx ON limbo_bets (user_id, created_at DESC);
CREATE INDEX limbo_bets_feed_idx ON limbo_bets (created_at DESC);

GRANT SELECT, INSERT ON TABLE limbo_bets TO donut_api_runtime;

-- Supersedes donut_schema_ready_v89.
CREATE FUNCTION donut_schema_ready_v90() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v90() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v90() TO donut_api_runtime;

COMMIT;
