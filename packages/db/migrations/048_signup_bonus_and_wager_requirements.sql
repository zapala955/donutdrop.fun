BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- A signup bonus, and the wager requirement that stops it being free cash
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A new account is credited SIGNUP_BONUS_MINOR once. Signing up costs nothing -- the login nonce
-- is credited straight back -- and a Bedrock account is a free Microsoft account, so a bonus that
-- could be withdrawn at once would be a cash machine for anybody willing to make alts.
--
-- So money only leaves an account (cash withdrawal, tip, item withdrawal) once the player has
-- wagered what they owe: the bonus times SIGNUP_BONUS_WAGER_MULTIPLIER, plus every deposit times
-- DEPOSIT_WAGER_MULTIPLIER. Every settled wager counts down the outstanding amount.

-- ── the ledger kind ────────────────────────────────────────────────────────
-- Widening a CHECK cannot fail against existing rows. The (kind, reference_id) unique index on
-- wallet_transactions, with the user's id as the reference, is what makes a second signup bonus
-- for the same account impossible rather than merely unreached.
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
      'signup_bonus'
    ));

-- ── the outstanding requirement ────────────────────────────────────────────
-- One running figure per player rather than a list of individual requirements: the question every
-- reader asks is "may this player move money out yet", and a single row answers it without a scan.
-- Rows exist only for players who have owed something; no row means nothing is owed. Nothing is
-- back-filled, so the rule starts with the deposits and signups that happen after this migration.
CREATE TABLE user_wager_requirements (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  remaining_minor bigint NOT NULL DEFAULT 0 CHECK (remaining_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON TABLE user_wager_requirements TO donut_api_runtime;

-- Supersedes donut_schema_ready_v47.
CREATE FUNCTION donut_schema_ready_v48() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v48() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v48() TO donut_api_runtime;

COMMIT;
