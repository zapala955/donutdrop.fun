BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Chicken
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One run per row, played across several requests: start, then step the chicken across the rails one
-- lane at a time, until the player cashes out, a minecart comes down the lane it steps into, or it
-- crosses all twenty. The lane with the minecart is fixed at the start from the player's committed
-- fairness seed (see services/api-gateway/src/lib/chicken.ts) and kept in the row; the API never
-- sends it, or the seed, to a browser until the run is over.
--
-- Every change to an existing table below WIDENS a constraint, by one value. Each list is the
-- latest one in force (068's, which carries 067's demo_topup) plus Chicken.

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
      'chicken_stake', 'chicken_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken'));

-- ── the runs ───────────────────────────────────────────────────────────────
CREATE TABLE chicken_games (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- A lane has a minecart 1 time in 6 (easy), 4 (medium), 3 (hard) or 2 (hardcore). Twenty lanes.
  mode varchar(8) NOT NULL CHECK (mode IN ('easy', 'medium', 'hard', 'hardcore')),
  -- The first lane (0-based) with a minecart on it; NULL when the whole road is clear.
  -- Secret until the run settles.
  cart_lane smallint CHECK (cart_lane BETWEEN 0 AND 19),
  -- Lanes crossed safely so far.
  crossed smallint NOT NULL DEFAULT 0 CHECK (crossed BETWEEN 0 AND 20),
  -- The payout ceiling that applied when the run started.
  max_payout_minor bigint NOT NULL CHECK (max_payout_minor > 0),
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
  outcome varchar(10) CHECK (outcome IN ('cashout', 'hit')),
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
  -- Nobody crosses the lane the minecart is on.
  CHECK (cart_lane IS NULL OR crossed <= cart_lane),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status = 'active'
         OR (outcome IS NOT NULL AND payout_minor IS NOT NULL AND server_seed_reveal IS NOT NULL)),
  CHECK (status = 'settled' OR (server_seed_reveal IS NULL AND outcome IS NULL AND payout_minor IS NULL)),
  -- A hit is the lane after the last one crossed, and pays nothing.
  CHECK (outcome IS DISTINCT FROM 'hit' OR (cart_lane = crossed AND payout_minor = 0)),
  -- A cash-out has crossed at least one lane.
  CHECK (outcome IS DISTINCT FROM 'cashout' OR crossed >= 1)
);

-- One run in play per player, refused by the index rather than by a read in the handler.
CREATE UNIQUE INDEX chicken_games_one_active_idx ON chicken_games (user_id) WHERE status = 'active';
CREATE INDEX chicken_games_user_idx ON chicken_games (user_id, created_at DESC);
-- The live feed and the day's biggest wins read settled runs newest-first.
CREATE INDEX chicken_games_feed_idx ON chicken_games (settled_at DESC) WHERE status = 'settled';

GRANT SELECT, INSERT, UPDATE ON TABLE chicken_games TO donut_api_runtime;

-- Supersedes donut_schema_ready_v68.
CREATE FUNCTION donut_schema_ready_v69() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v69() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v69() TO donut_api_runtime;

COMMIT;
