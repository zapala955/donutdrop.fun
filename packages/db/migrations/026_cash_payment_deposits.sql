BEGIN;

-- Cash deposits are DonutSMP /pay transfers. They are deliberately separate from
-- deposit_intents, which is the physical-item custody workflow. The bot's public receipt tells
-- us which linked player paid, while the DonutSMP API balance proves that the requested amount
-- actually reached the bot.
CREATE TABLE cash_deposit_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  bot_balance_before_minor bigint NOT NULL CHECK (bot_balance_before_minor >= 0),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status varchar(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'observed', 'credited', 'expired', 'manual_review')),
  displayed_amount varchar(32),
  observed_at timestamptz,
  credited_at timestamptz,
  balance_after_minor bigint CHECK (balance_after_minor IS NULL OR balance_after_minor >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK ((status IN ('observed', 'credited', 'manual_review')) = (observed_at IS NOT NULL)),
  CHECK ((status = 'credited') = (credited_at IS NOT NULL)),
  CHECK ((status = 'credited') = (balance_after_minor IS NOT NULL))
);

-- A user cannot reuse one server receipt for two challenges. One active challenge per bot also
-- makes the exact API balance delta attributable even though large chat receipts are abbreviated.
CREATE UNIQUE INDEX cash_deposit_challenges_active_user_idx
  ON cash_deposit_challenges (user_id)
  WHERE status IN ('pending', 'observed');
CREATE UNIQUE INDEX cash_deposit_challenges_active_bot_idx
  ON cash_deposit_challenges (bot_id)
  WHERE status IN ('pending', 'observed');
CREATE INDEX cash_deposit_challenges_user_history_idx
  ON cash_deposit_challenges (user_id, created_at DESC);

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
      'pay_login_deposit', 'cash_deposit'
    ));

REVOKE ALL ON TABLE cash_deposit_challenges FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE cash_deposit_challenges TO donut_api_runtime;

-- Supersedes donut_schema_ready_v25.
CREATE FUNCTION donut_schema_ready_v26() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v26() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v26() TO donut_api_runtime;

COMMIT;
