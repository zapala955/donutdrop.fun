BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The house pool ("be the house")
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Players move balance into a pool and share, pro rata, a slice of the house's game result for
-- each UTC day: profit is credited to their wallet, a loss comes out of what they staked. The
-- slice is a fixed share of the result scaled by how full the pool is against its cap, so the
-- return on each staked unit does not depend on how many others staked (lib/staking.ts).
--
-- A stake earns from the first WHOLE day after it was made, and keeps sharing results while it
-- cools down after an unstake request, so nobody can step in for a good day they already watched
-- happen or step out of a bad one they saw coming.
--
-- Everything here is additive: three new tables and three ledger kinds added to the allowed list.

-- ── stakes ─────────────────────────────────────────────────────────────────
CREATE TABLE staking_lots (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  original_minor bigint NOT NULL CHECK (original_minor > 0),
  -- What is left after the losing days. Never above what was staked: profit is paid out, not kept.
  principal_minor bigint NOT NULL CHECK (principal_minor >= 0),
  staked_at timestamptz NOT NULL DEFAULT now(),
  -- The first UTC day this stake shares in: the day after it was made.
  earning_from date NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unstaking', 'closed')),
  unstake_requested_at timestamptz,
  unlocks_at timestamptz,
  closed_at timestamptz,
  released_minor bigint CHECK (released_minor >= 0),
  CHECK (principal_minor <= original_minor),
  CHECK ((unstake_requested_at IS NULL) = (unlocks_at IS NULL)),
  CHECK (status <> 'active' OR unlocks_at IS NULL),
  CHECK (status = 'active' OR unlocks_at IS NOT NULL),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((closed_at IS NULL) = (released_minor IS NULL))
);
CREATE INDEX staking_lots_user_idx ON staking_lots (user_id, staked_at DESC);
CREATE INDEX staking_lots_open_idx ON staking_lots (status, unlocks_at) WHERE status <> 'closed';

-- ── settled days ───────────────────────────────────────────────────────────
-- One row per UTC day, written once, in the same transaction that pays or charges every stake.
CREATE TABLE staking_days (
  day date PRIMARY KEY,
  -- The house's net result on its games that day (stakes minus payouts), staff and test twins out.
  ggr_minor bigint NOT NULL,
  -- What was staked and eligible for the whole day.
  eligible_minor bigint NOT NULL CHECK (eligible_minor >= 0),
  -- The pool's share of the result that day, in basis points, after scaling by the cap.
  share_bps integer NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  pool_result_minor bigint NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staking_lot_days (
  id uuid PRIMARY KEY,
  day date NOT NULL REFERENCES staking_days(day),
  lot_id uuid NOT NULL REFERENCES staking_lots(id),
  user_id uuid NOT NULL REFERENCES users(id),
  principal_before_minor bigint NOT NULL CHECK (principal_before_minor > 0),
  -- Positive: credited to the wallet as 'staking_reward'. Negative: taken off the principal.
  result_minor bigint NOT NULL,
  UNIQUE (day, lot_id),
  CHECK (result_minor >= -principal_before_minor)
);
CREATE INDEX staking_lot_days_user_idx ON staking_lot_days (user_id, day DESC);

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
      'bounty_reward', 'staking_stake', 'staking_release', 'staking_reward'
    ));

-- ── grants ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE staking_lots TO donut_api_runtime;
GRANT SELECT, INSERT ON TABLE staking_days TO donut_api_runtime;
GRANT SELECT, INSERT ON TABLE staking_lot_days TO donut_api_runtime;

-- Supersedes donut_schema_ready_v81.
CREATE FUNCTION donut_schema_ready_v82() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v82() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v82() TO donut_api_runtime;

COMMIT;
