BEGIN;

-- One European roulette table for the whole site. There can only be one open round, which is the
-- database-level guarantee that two API processes cannot create different wheels for different
-- players. The seed hash is public while betting is open; the encrypted seed is revealed only
-- after the close time and permanently ties the result to that commitment.
CREATE TABLE roulette_rounds (
  id uuid PRIMARY KEY,
  status varchar(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled')),
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_ciphertext text NOT NULL,
  server_seed_reveal char(64) CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),
  rng_digest char(64) CHECK (rng_digest ~ '^[a-f0-9]{64}$'),
  result smallint CHECK (result BETWEEN 0 AND 36),
  opens_at timestamptz NOT NULL DEFAULT now(),
  closes_at timestamptz NOT NULL,
  settled_at timestamptz,
  total_staked_minor bigint NOT NULL DEFAULT 0 CHECK (total_staked_minor >= 0),
  total_payout_minor bigint NOT NULL DEFAULT 0 CHECK (total_payout_minor >= 0),
  bet_count integer NOT NULL DEFAULT 0 CHECK (bet_count >= 0),
  CHECK (closes_at > opens_at),
  CHECK (
    (status = 'open' AND settled_at IS NULL AND server_seed_reveal IS NULL
      AND rng_digest IS NULL AND result IS NULL)
    OR
    (status = 'settled' AND settled_at IS NOT NULL AND server_seed_reveal IS NOT NULL
      AND rng_digest IS NOT NULL AND result IS NOT NULL)
  )
);
CREATE UNIQUE INDEX roulette_one_open_round_idx ON roulette_rounds (status) WHERE status = 'open';
CREATE INDEX roulette_rounds_history_idx ON roulette_rounds (closes_at DESC) WHERE status = 'settled';

-- A player may cover several outcomes in one round. Idempotency is scoped to the player, so a
-- retried click replays exactly one debit while a deliberate second chip remains possible.
CREATE TABLE roulette_bets (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES roulette_rounds(id),
  user_id uuid NOT NULL REFERENCES users(id),
  selection varchar(24) NOT NULL CHECK (
    selection ~ '^straight:([0-9]|[12][0-9]|3[0-6])$'
    OR selection IN ('red', 'black', 'odd', 'even', 'low', 'high',
                     'dozen:1', 'dozen:2', 'dozen:3')
  ),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  payout_bps integer NOT NULL CHECK (payout_bps > 10000 AND payout_bps <= 10000000),
  payout_minor bigint CHECK (payout_minor >= 0),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (user_id, idempotency_key),
  CHECK ((payout_minor IS NULL) = (settled_at IS NULL))
);
CREATE INDEX roulette_bets_round_idx ON roulette_bets (round_id, created_at, id);
CREATE INDEX roulette_bets_user_idx ON roulette_bets (user_id, created_at DESC);

-- Roulette is a first-class wager: it appears in the wallet ledger and drives daily wagering,
-- VIP, races, faction wars, referral share, rakeback and the jackpot through recordWager.
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
      'roulette_stake', 'roulette_win'
    ));

ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette'));

GRANT SELECT, INSERT, UPDATE ON TABLE roulette_rounds, roulette_bets TO donut_api_runtime;

-- Supersedes donut_schema_ready_v38.
CREATE FUNCTION donut_schema_ready_v39() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v39() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v39() TO donut_api_runtime;

COMMIT;
