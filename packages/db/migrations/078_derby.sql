BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Mob Derby
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per race: the stake is taken on one of six farm mobs, the winner (and the track the page
-- draws) drawn from the player's committed fairness seed, and a winning pick paid at its racer's
-- fixed odds, all in one request (see services/api-gateway/src/lib/derby.ts). Nothing is left open.
--
-- Every change to an existing table below WIDENS a constraint. Each list is the latest one in force
-- on this branch (077's) plus the derby.

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
      'ice_fishing_stake', 'ice_fishing_payout',
      'derby_stake', 'derby_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing', 'ice_fishing',
                      'derby'));

-- ── the races ──────────────────────────────────────────────────────────────
CREATE TABLE derby_races (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- The racer backed, and the racer that won: the fairness hash's first byte, 0..255.
  pick text NOT NULL CHECK (pick IN ('pig', 'cow', 'sheep', 'chicken', 'mooshroom', 'black_sheep')),
  winner text NOT NULL CHECK (winner IN ('pig', 'cow', 'sheep', 'chicken', 'mooshroom', 'black_sheep')),
  roll smallint NOT NULL CHECK (roll BETWEEN 0 AND 255),
  -- How the field runs on the way there, for the page to draw: the hash's next sixteen bytes.
  track_seed char(32) NOT NULL CHECK (track_seed ~ '^[a-f0-9]{32}$'),
  multiplier_x100 integer NOT NULL CHECK (multiplier_x100 BETWEEN 0 AND 1920),
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  server_seed_reveal char(64) NOT NULL,
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- A seed decides one race.
  UNIQUE (fairness_seed_id),
  -- A winning pick pays its odds, a losing one nothing; the pay is the stake times the multiplier.
  CHECK ((pick = winner) = (multiplier_x100 > 0)),
  CHECK (payout_minor = stake_minor * multiplier_x100 / 100)
);

CREATE INDEX derby_races_user_idx ON derby_races (user_id, created_at DESC);
-- The live feed and the day's biggest wins read races newest-first.
CREATE INDEX derby_races_feed_idx ON derby_races (created_at DESC);

GRANT SELECT, INSERT ON TABLE derby_races TO donut_api_runtime;

-- Supersedes donut_schema_ready_v77.
CREATE FUNCTION donut_schema_ready_v78() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v78() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v78() TO donut_api_runtime;

COMMIT;
