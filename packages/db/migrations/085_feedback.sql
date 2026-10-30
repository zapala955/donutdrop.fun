BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Player feedback (routes/feedback.ts): a short note on what to add or fix, and one survey answer,
-- "do you like the 3D games?". The first note an account sends is rewarded once (1M by default),
-- through the ledger as 'feedback_reward' with a wager requirement; later notes are welcome and
-- paid nothing. Staff read every note and the survey's tally in the admin panel.
--
-- The survey is counted by each player's latest answer, so a player who sends three notes is one
-- vote, and a player who changes their mind is counted as they think now.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE player_feedback (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  likes_3d boolean NOT NULL,
  message varchar(1000) NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  -- What this note was paid: the reward for the account's first one, 0 for every other.
  reward_minor bigint NOT NULL DEFAULT 0 CHECK (reward_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One reward per account, ever: a second note is welcome, a second million is not.
CREATE UNIQUE INDEX player_feedback_rewarded_idx ON player_feedback (user_id) WHERE reward_minor > 0;
CREATE INDEX player_feedback_user_idx ON player_feedback (user_id, created_at DESC);
CREATE INDEX player_feedback_created_idx ON player_feedback (created_at DESC);
CREATE TRIGGER player_feedback_append_only
  BEFORE UPDATE OR DELETE ON player_feedback FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ── the ledger ─────────────────────────────────────────────────────────────────────────────────
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
      'weekly_quest_reward', 'feedback_reward'
    ));

-- ── grants ─────────────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT ON TABLE player_feedback TO donut_api_runtime;

-- Supersedes donut_schema_ready_v84.
CREATE FUNCTION donut_schema_ready_v85() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v85() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v85() TO donut_api_runtime;

COMMIT;
