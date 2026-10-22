BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Ice Fishing
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per game on the frozen lake, Mines on the ice: the stake is taken and the thin ice laid
-- from the player's committed fairness seed when the game starts (see
-- services/api-gateway/src/lib/ice-fishing.ts); the game is active while holes are drilled, and
-- settles once, pulled out (cashout) or through the ice (thin).
--
-- Numbered 077, not 075: 075 and 076 are taken by work on another branch (crowns, staking).
--
-- Every change to an existing table below WIDENS a constraint. Each list is the latest one in force
-- on this branch (074's) plus Ice Fishing; whichever of these lands last unites the lists.

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
      'mines_duel_stake', 'mines_duel_win', 'mines_duel_refund',
      'daily_code_reward',
      'demo_topup',
      'tower_stake', 'tower_payout',
      'chicken_stake', 'chicken_payout',
      'slots_stake', 'slots_payout',
      'fishing_stake', 'fishing_payout',
      'ice_fishing_stake', 'ice_fishing_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing'));

-- ── the games ──────────────────────────────────────────────────────────────
CREATE TABLE ice_fishing_games (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  thin_count smallint NOT NULL CHECK (thin_count BETWEEN 1 AND 24),
  -- The thin ice, holes 0-24 in reading order. Secret until the game settles.
  thin_holes smallint[] NOT NULL,
  -- Holes with a fish drilled so far, in the order they were drilled.
  drilled_holes smallint[] NOT NULL DEFAULT '{}',
  -- The payout ceiling that applied when the game started.
  max_payout_minor bigint NOT NULL CHECK (max_payout_minor > 0),
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
  outcome varchar(10) CHECK (outcome IN ('cashout', 'thin')),
  -- The thin-ice hole drilled, when that is how it ended.
  thin_hit smallint CHECK (thin_hit BETWEEN 0 AND 24),
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
  -- A seed lays one lake's ice.
  UNIQUE (fairness_seed_id),
  CHECK (cardinality(thin_holes) = thin_count),
  CHECK (cardinality(drilled_holes) <= 25 - thin_count),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status = 'active'
         OR (outcome IS NOT NULL AND payout_minor IS NOT NULL AND server_seed_reveal IS NOT NULL)),
  CHECK (status = 'settled' OR (server_seed_reveal IS NULL AND outcome IS NULL AND payout_minor IS NULL)),
  CHECK (outcome IS DISTINCT FROM 'thin' OR (thin_hit IS NOT NULL AND payout_minor = 0))
);

-- One game on the ice per player, refused by the index rather than by a read in the handler.
CREATE UNIQUE INDEX ice_fishing_games_one_active_idx ON ice_fishing_games (user_id) WHERE status = 'active';
CREATE INDEX ice_fishing_games_user_idx ON ice_fishing_games (user_id, created_at DESC);
-- The live feed and the day's biggest wins read settled games newest-first.
CREATE INDEX ice_fishing_games_feed_idx ON ice_fishing_games (settled_at DESC) WHERE status = 'settled';

GRANT SELECT, INSERT, UPDATE ON TABLE ice_fishing_games TO donut_api_runtime;

-- Supersedes donut_schema_ready_v74.
CREATE FUNCTION donut_schema_ready_v77() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v77() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v77() TO donut_api_runtime;

COMMIT;
