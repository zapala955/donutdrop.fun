BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Plinko
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One bet per row, decided and settled in the request that places it: the stake is taken, the
-- path is drawn from the player's committed fairness seed (see services/api-gateway/src/lib/plinko.ts)
-- and the slot's payout is credited, all in one transaction. A row is written once and never
-- updated, so the runtime role gets no UPDATE on it.
--
-- Every change to an existing table below WIDENS a constraint. Widening cannot fail against
-- existing rows; narrowing is how migration 030 took production down.

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
      'plinko_stake', 'plinko_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko'));

-- ── the bets ───────────────────────────────────────────────────────────────
CREATE TABLE plinko_bets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  row_count smallint NOT NULL CHECK (row_count BETWEEN 8 AND 16),
  risk varchar(6) NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  -- One 0 (left) or 1 (right) per row, from the top.
  path smallint[] NOT NULL,
  slot smallint NOT NULL,
  multiplier_bps integer NOT NULL CHECK (multiplier_bps > 0),
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  server_seed_reveal char(64) NOT NULL,
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- A seed draws one path.
  UNIQUE (fairness_seed_id),
  CHECK (cardinality(path) = row_count),
  CHECK (slot BETWEEN 0 AND row_count)
);

CREATE INDEX plinko_bets_user_idx ON plinko_bets (user_id, created_at DESC);
-- The live feed reads bets newest-first.
CREATE INDEX plinko_bets_feed_idx ON plinko_bets (created_at DESC);

GRANT SELECT, INSERT ON TABLE plinko_bets TO donut_api_runtime;

-- Supersedes donut_schema_ready_v51.
CREATE FUNCTION donut_schema_ready_v52() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v52() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v52() TO donut_api_runtime;

COMMIT;
