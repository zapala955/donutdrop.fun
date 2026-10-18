BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Slots (Ore Rush and the Ocean Monument)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per paid spin, on either machine. The spin and every free spin it leads to are decided from the player's
-- committed fairness seed and paid in the request that stakes it (see
-- services/api-gateway/src/lib/slots.ts), so a row is written once, settled, and never updated.
--
-- Every change to an existing table below WIDENS a constraint, by one value. Each list is the
-- latest one in force (069's; 070 and 071 changed none of them) plus Slots.

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
      'slots_stake', 'slots_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots'));

-- ── the spins ──────────────────────────────────────────────────────────────
CREATE TABLE slots_spins (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  -- Which machine the round was played on: its strips are what the stops index into.
  machine text NOT NULL DEFAULT 'ore-rush' CHECK (machine IN ('ore-rush', 'monument')),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- Five strip indices per spin, the paid spin first, then each free spin in order. Everything
  -- else about the round (the symbols, the lines, each spin's pay) is rebuilt from these.
  stops smallint[] NOT NULL,
  free_spins smallint NOT NULL CHECK (free_spins BETWEEN 0 AND 100),
  -- The round's pay over the stake, floored, in basis points: 0 for a losing spin.
  multiplier_bps integer NOT NULL CHECK (multiplier_bps BETWEEN 0 AND 10000000),
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  -- The round reached the 1,000x ceiling and stopped there.
  capped boolean NOT NULL DEFAULT false,
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  server_seed_reveal char(64) NOT NULL,
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- A seed decides one round.
  UNIQUE (fairness_seed_id),
  CHECK (cardinality(stops) = 5 * (1 + free_spins)),
  CHECK (payout_minor <= stake_minor * 1000)
);

CREATE INDEX slots_spins_user_idx ON slots_spins (user_id, created_at DESC);
-- The live feed reads spins newest-first.
CREATE INDEX slots_spins_feed_idx ON slots_spins (created_at DESC);

GRANT SELECT, INSERT ON TABLE slots_spins TO donut_api_runtime;

-- Supersedes donut_schema_ready_v71.
CREATE FUNCTION donut_schema_ready_v72() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v72() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v72() TO donut_api_runtime;

COMMIT;
