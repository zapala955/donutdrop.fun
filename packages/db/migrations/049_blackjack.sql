BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Blackjack
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One hand per row, played across several requests: deal, then hit / stand / double. The whole
-- card sequence is fixed at the deal by the player's committed fairness seed (see lib/blackjack.ts),
-- so the row carries only where play has got to -- the cards dealt so far and the next position in
-- the sequence -- and the seed is revealed into it when the hand settles, never before: revealing
-- it early would show the player every card still to come.
--
-- Every change below WIDENS a constraint. Widening cannot fail against existing rows; narrowing is
-- how migration 030 took production down.

-- ── the ledger kinds ───────────────────────────────────────────────────────
-- The stake and a double are separate kinds because wallet_transactions is unique on
-- (kind, reference_id): both reference the hand, and one kind could hold only one of them.
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
      'blackjack_stake', 'blackjack_double', 'blackjack_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack'));

-- ── the hands ──────────────────────────────────────────────────────────────
CREATE TABLE blackjack_hands (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  doubled boolean NOT NULL DEFAULT false,
  status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
  player_cards smallint[] NOT NULL,
  dealer_cards smallint[] NOT NULL,
  -- The next position in the committed card sequence.
  next_card smallint NOT NULL CHECK (next_card BETWEEN 4 AND 63),
  outcome varchar(20)
    CHECK (outcome IN ('blackjack', 'win', 'push', 'tie', 'lose', 'bust', 'dealer_blackjack')),
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
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status = 'active'
         OR (outcome IS NOT NULL AND payout_minor IS NOT NULL AND server_seed_reveal IS NOT NULL)),
  CHECK (status = 'settled' OR server_seed_reveal IS NULL)
);

-- One hand in play per player. A second deal is refused by the index rather than by a read in the
-- handler, because two clicks half a second apart both pass a read.
CREATE UNIQUE INDEX blackjack_hands_one_active_idx ON blackjack_hands (user_id) WHERE status = 'active';
CREATE INDEX blackjack_hands_user_idx ON blackjack_hands (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE blackjack_hands TO donut_api_runtime;

-- Supersedes donut_schema_ready_v48.
CREATE FUNCTION donut_schema_ready_v49() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v49() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v49() TO donut_api_runtime;

COMMIT;
