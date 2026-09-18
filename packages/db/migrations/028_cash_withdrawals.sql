BEGIN;

-- Cash withdrawals: the bot pays a player in game with DonutSMP's own /pay command.
--
-- This is not the item `withdrawals` table beside it and does not share its machinery. That one
-- moves physical custody and stays closed until an atomic item-transfer adapter exists; this one
-- moves a number, which /pay already does atomically on the server's side.
--
-- The wallet is debited when the request is accepted, not when the bot pays. A balance that still
-- shows money the player has already asked to have sent is a balance they can spend twice, and the
-- second spend is the one the house funds. The refund path exists for exactly the cases where the
-- payout provably did not happen: a rejection, or a bot that could not send the command at all.
CREATE TABLE cash_withdrawals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  -- Captured at request time rather than joined at payout time. A rename between the two would
  -- otherwise send the money to whoever holds the name when the bot gets around to it.
  payee_username varchar(16) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status varchar(24) NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'pending_approval', 'queued', 'processing', 'paid', 'rejected', 'failed', 'manual_review'
    )),
  idempotency_key varchar(128) NOT NULL,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  error_code varchar(64),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- Approval is recorded together or not at all, so an approved row can always name its approver.
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

-- One live payout per player. Two requests racing each other both debit, and exactly one gets a
-- row; the loser's transaction rolls back and takes its debit with it. This is what makes a
-- double payout impossible rather than merely unlikely.
CREATE UNIQUE INDEX cash_withdrawals_one_live_idx
  ON cash_withdrawals (user_id)
  WHERE status IN ('pending_approval', 'queued', 'processing');

CREATE INDEX cash_withdrawals_queue_idx
  ON cash_withdrawals (status, created_at)
  WHERE status IN ('pending_approval', 'manual_review');

CREATE INDEX cash_withdrawals_user_history_idx
  ON cash_withdrawals (user_id, created_at DESC);

-- The bot learns about a payout the same way it learns about every other instruction: a leased
-- job. Reusing bot_jobs rather than polling a second table keeps one lease, one attempt counter
-- and one dead-letter path for everything the bot is ever told to do.
ALTER TABLE bot_jobs DROP CONSTRAINT bot_jobs_kind_check;
ALTER TABLE bot_jobs
  ADD CONSTRAINT bot_jobs_kind_check
    CHECK (kind IN ('withdrawal', 'inventory_resync', 'cash_payout'));

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
      'cash_withdrawal', 'cash_withdrawal_refund'
    ));

REVOKE ALL ON TABLE cash_withdrawals FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE cash_withdrawals TO donut_api_runtime;

-- Supersedes donut_schema_ready_v27.
CREATE FUNCTION donut_schema_ready_v28() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v28() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v28() TO donut_api_runtime;

COMMIT;
