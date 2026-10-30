BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Weekly quests (lib/weekly-quests.ts): two quests a week, each with its own prize pot.
--
--   deposit_race   the players who deposited the most this week, counted as what they put in
--                  and also played, share the pot by rank (50/30/20 by default).
--   recruit        a player who brought in enough new friends this week (each a new account on
--                  their invite link that deposited and played a set amount) shares the pot
--                  equally with everyone else who did.
--
-- A round is one quest over one UTC week, Monday to Monday. It is created when it is first read
-- or swept, and it carries its own pot, split and thresholds: what a player was shown while the
-- week ran is what decides it, whatever the settings say when it settles. Nothing is counted into
-- a table while the week runs; scores are read from the ledger, the wager log and the referrals,
-- which already hold every deposit, withdrawal, wager and invite. The sweeper settles a round
-- once its grace period after the week has passed, and pays through the ledger.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE weekly_quest_rounds (
  id uuid PRIMARY KEY,
  quest varchar(16) NOT NULL CHECK (quest IN ('deposit_race', 'recruit')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- When the sweeper may settle it: the end of the week plus a grace period, so a friend invited
  -- on Sunday night still has time to deposit and play.
  settles_at timestamptz NOT NULL,
  pot_minor bigint NOT NULL CHECK (pot_minor > 0),
  -- deposit_race: basis points per rank, highest first, summing to at most 10000.
  -- recruit: an empty array; the pot is split equally among everybody who finished it.
  payout_curve jsonb NOT NULL,
  -- deposit_race: the least a player must have deposited and played to place.
  -- recruit: what each friend must have deposited (net of withdrawals).
  min_deposit_minor bigint NOT NULL CHECK (min_deposit_minor > 0),
  -- recruit: what each friend must have wagered. deposit_race: 0.
  min_wager_minor bigint NOT NULL CHECK (min_wager_minor >= 0),
  -- recruit: friends needed. deposit_race: places paid (the length of the curve).
  target_count integer NOT NULL CHECK (target_count > 0),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quest, starts_at),
  CHECK (ends_at > starts_at),
  CHECK (settles_at >= ends_at),
  CHECK (jsonb_typeof(payout_curve) = 'array')
);
CREATE INDEX weekly_quest_rounds_open_idx ON weekly_quest_rounds (settles_at) WHERE settled_at IS NULL;

CREATE TABLE weekly_quest_payouts (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES weekly_quest_rounds(id),
  user_id uuid NOT NULL REFERENCES users(id),
  -- deposit_race: the place. recruit: 1 for every finisher.
  rank integer NOT NULL CHECK (rank > 0),
  -- deposit_race: the counted deposit. recruit: the friends who qualified.
  score bigint NOT NULL CHECK (score > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One payout per player per round.
  UNIQUE (round_id, user_id)
);
CREATE INDEX weekly_quest_payouts_user_idx ON weekly_quest_payouts (user_id, created_at DESC);
CREATE TRIGGER weekly_quest_payouts_append_only
  BEFORE UPDATE OR DELETE ON weekly_quest_payouts FOR EACH ROW EXECUTE FUNCTION reject_mutation();

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
      'weekly_quest_reward'
    ));

-- ── grants ─────────────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE weekly_quest_rounds TO donut_api_runtime;
GRANT SELECT, INSERT ON TABLE weekly_quest_payouts TO donut_api_runtime;

-- Supersedes donut_schema_ready_v83.
CREATE FUNCTION donut_schema_ready_v84() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v84() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v84() TO donut_api_runtime;

COMMIT;
