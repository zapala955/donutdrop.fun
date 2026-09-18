BEGIN;

-- A payment-login transfer is real player money received by the bot. Record it in the same
-- append-only wallet ledger as every other balance change; the challenge UUID is the natural
-- idempotency key through wallet_transactions_reference_idx.
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
      'pay_login_deposit'
    ));

-- Supersedes donut_schema_ready_v24. The readiness probe names the exact schema the running API
-- expects, so traffic cannot reach payment completion before the new ledger kind is available.
CREATE FUNCTION donut_schema_ready_v25() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v25() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v25() TO donut_api_runtime;

COMMIT;
