BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Crash
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One shared round at a time: a betting window, then a multiplier that climbs from 1.00x until it
-- busts. See services/api-gateway/src/lib/crash.ts for the curve, the edge and the fairness proof.
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
      'crash_stake', 'crash_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash'));

-- ── the rounds ─────────────────────────────────────────────────────────────
-- crash_point_x100 and crashes_at are written when the round is created, because every cash-out
-- has to be judged against them the instant it arrives. The API never sends either to a browser
-- before crashes_at has passed; the committed seed hash is what makes them binding.
CREATE TABLE crash_rounds (
  id uuid PRIMARY KEY,
  status varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled')),
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_ciphertext text NOT NULL,
  server_seed_reveal char(64) CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),
  house_edge_bps integer NOT NULL CHECK (house_edge_bps BETWEEN 0 AND 9999),
  crash_point_x100 integer NOT NULL CHECK (crash_point_x100 BETWEEN 100 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Betting closes and the curve starts at the same instant.
  started_at timestamptz NOT NULL,
  crashes_at timestamptz NOT NULL,
  settled_at timestamptz,
  total_staked_minor bigint NOT NULL DEFAULT 0 CHECK (total_staked_minor >= 0),
  total_payout_minor bigint NOT NULL DEFAULT 0 CHECK (total_payout_minor >= 0),
  bet_count integer NOT NULL DEFAULT 0 CHECK (bet_count >= 0),
  CHECK (started_at > created_at),
  CHECK (crashes_at >= started_at),
  CHECK (
    (status = 'open' AND settled_at IS NULL AND server_seed_reveal IS NULL)
    OR
    (status = 'settled' AND settled_at IS NOT NULL AND server_seed_reveal IS NOT NULL)
  )
);
-- One open round, enforced by the database rather than by the scheduler's good behaviour.
CREATE UNIQUE INDEX crash_one_open_round_idx ON crash_rounds (status) WHERE status = 'open';
CREATE INDEX crash_rounds_history_idx ON crash_rounds (crashes_at DESC) WHERE status = 'settled';

-- ── the bets ───────────────────────────────────────────────────────────────
-- One bet per player per round: a bet and its cash-out are one decision, and the unique key makes
-- a double click a replay rather than a second stake.
CREATE TABLE crash_bets (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES crash_rounds(id),
  user_id uuid NOT NULL REFERENCES users(id),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- The player's own target, if they set one.
  auto_cashout_x100 integer CHECK (auto_cashout_x100 BETWEEN 101 AND 100000),
  -- The ceiling this stake may ride to: the curve's top, or where the payout reaches the maximum.
  limit_x100 integer NOT NULL CHECK (limit_x100 BETWEEN 101 AND 100000),
  status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cashed_out', 'lost')),
  cashout_x100 integer CHECK (cashout_x100 BETWEEN 100 AND 100000),
  cashed_out_by varchar(8) CHECK (cashed_out_by IN ('player', 'auto')),
  payout_minor bigint CHECK (payout_minor >= 0),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (user_id, idempotency_key),
  UNIQUE (round_id, user_id),
  CHECK ((status = 'active') = (settled_at IS NULL)),
  CHECK (status <> 'active' OR (cashout_x100 IS NULL AND payout_minor IS NULL AND cashed_out_by IS NULL)),
  CHECK (status <> 'cashed_out'
         OR (cashout_x100 IS NOT NULL AND payout_minor IS NOT NULL AND cashed_out_by IS NOT NULL)),
  CHECK (status <> 'lost' OR (cashout_x100 IS NULL AND payout_minor = 0 AND cashed_out_by IS NULL))
);
CREATE INDEX crash_bets_round_idx ON crash_bets (round_id, created_at, id);
CREATE INDEX crash_bets_active_idx ON crash_bets (round_id) WHERE status = 'active';
CREATE INDEX crash_bets_user_idx ON crash_bets (user_id, created_at DESC);

-- The live feed reads both games newest-first by the moment each was decided.
CREATE INDEX crash_bets_feed_idx ON crash_bets (settled_at DESC) WHERE status <> 'active';
CREATE INDEX blackjack_hands_feed_idx ON blackjack_hands (settled_at DESC) WHERE status = 'settled';

GRANT SELECT, INSERT, UPDATE ON TABLE crash_rounds TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE crash_bets TO donut_api_runtime;

-- Supersedes donut_schema_ready_v49.
CREATE FUNCTION donut_schema_ready_v50() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v50() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v50() TO donut_api_runtime;

COMMIT;
