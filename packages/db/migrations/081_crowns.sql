BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Crowns and bounties
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A crown is the best multiplier a single round has paid on one house game inside a rolling
-- window (30 days by default), at or above a minimum stake. It changes hands when a round beats it
-- and it falls when its own round leaves the window. Every reign is one row, current or ended, so
-- the bell can tell a player that their crown was taken without anything being stored for the bell
-- itself (lib/crowns.ts).
--
-- A bounty is a prize for the FIRST round, after it opens, that reaches a multiplier on one game
-- at a minimum stake. It is paid once, through the ledger, as 'bounty_reward'.
--
-- Everything here is additive: three new tables and one ledger kind added to the allowed list (a
-- widening, so every existing row still satisfies it).

-- ── reigns ─────────────────────────────────────────────────────────────────
CREATE TABLE crown_reigns (
  id uuid PRIMARY KEY,
  game varchar(16) NOT NULL
    CHECK (game IN ('case', 'upgrader', 'crash', 'mines', 'tower', 'chicken', 'plinko', 'slots',
                    'dice')),
  user_id uuid NOT NULL REFERENCES users(id),
  -- The round that holds it, by the id in its own game's table. Not unique: a round that fell out
  -- of the window can come back into it when the window is widened live, and reign again.
  round_id uuid NOT NULL,
  -- payout / stake in hundredths: 41250 is 412.50x. An integer, so two reigns compare exactly.
  multiplier_x100 bigint NOT NULL CHECK (multiplier_x100 > 100),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  payout_minor bigint NOT NULL CHECK (payout_minor > stake_minor),
  -- When the round settled. The window is measured from here, not from when the crown was taken.
  hit_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason varchar(8) CHECK (ended_reason IN ('beaten', 'expired')),
  -- The reign that took it. Deferred, because the old reign has to end before the new one may
  -- start (one current reign per game) and the new one does not exist yet at that moment.
  ended_by uuid REFERENCES crown_reigns(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL)),
  CHECK (ended_by IS NULL OR ended_reason = 'beaten')
);
-- One current crown per game.
CREATE UNIQUE INDEX crown_reigns_current_idx ON crown_reigns (game) WHERE ended_at IS NULL;
-- "Your crown was taken": the bell reads a player's ended reigns, newest first.
CREATE INDEX crown_reigns_lost_idx ON crown_reigns (user_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;

-- ── how far the sweeper has read each game's rounds ───────────────────────
CREATE TABLE crown_scan_state (
  game varchar(16) PRIMARY KEY,
  scanned_until timestamptz NOT NULL
);

-- ── bounties ───────────────────────────────────────────────────────────────
CREATE TABLE crown_bounties (
  id uuid PRIMARY KEY,
  game varchar(16) NOT NULL
    CHECK (game IN ('case', 'upgrader', 'crash', 'mines', 'tower', 'chicken', 'plinko', 'slots',
                    'dice')),
  min_multiplier_x100 bigint NOT NULL CHECK (min_multiplier_x100 > 100),
  min_stake_minor bigint NOT NULL CHECK (min_stake_minor > 0),
  prize_minor bigint NOT NULL CHECK (prize_minor > 0),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  status varchar(10) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'won', 'expired', 'cancelled')),
  -- How far the sweeper has looked for a winner, so a week-long bounty is not re-read from the
  -- start every half minute.
  scanned_until timestamptz,
  winner_user_id uuid REFERENCES users(id),
  winning_round_id uuid,
  winning_multiplier_x100 bigint,
  won_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at),
  -- A winner, its round, its multiplier and its time are written together or not at all, and only
  -- a won bounty has them.
  CHECK ((status = 'won') = (winner_user_id IS NOT NULL)),
  CHECK ((winner_user_id IS NULL) = (winning_round_id IS NULL)),
  CHECK ((winner_user_id IS NULL) = (winning_multiplier_x100 IS NULL)),
  CHECK ((winner_user_id IS NULL) = (won_at IS NULL))
);
CREATE INDEX crown_bounties_open_idx ON crown_bounties (closes_at) WHERE status = 'open';
CREATE INDEX crown_bounties_winner_idx ON crown_bounties (winner_user_id, won_at DESC)
  WHERE winner_user_id IS NOT NULL;

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
      'bounty_reward'
    ));

-- ── grants ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE crown_reigns TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE crown_scan_state TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE crown_bounties TO donut_api_runtime;

-- Supersedes donut_schema_ready_v80.
CREATE FUNCTION donut_schema_ready_v81() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v81() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v81() TO donut_api_runtime;

COMMIT;
