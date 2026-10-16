BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The notification bell
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The bell lists what happened to a player's money that they did not do themselves: a deposit
-- arriving from the game, a withdrawal paid or refunded, a tip, an invite reaching its bar, a
-- staff adjustment (services/api-gateway/src/lib/notifications.ts). The list itself is read from
-- the ledger and the withdrawals table; nothing new is stored for it but how far each player has
-- read.
--
-- Additive: one column and one index; nothing existing is rewritten.

-- How far the player has read. Every account starts read up to now, so the first visit after this
-- migration does not light the bell for a month of old deposits. now() is evaluated once here, so
-- the column is added without rewriting the table.
ALTER TABLE users
  ADD COLUMN notifications_read_at timestamptz NOT NULL DEFAULT now();

-- The bell's one query: this player's notice-worthy ledger rows, newest first. A partial index,
-- because these kinds are a sliver of the ledger -- an active player writes thousands of stakes
-- and wins between two deposits, and the history index would walk every one of them to find the
-- deposit. The list must match NOTICE_KINDS in lib/notifications.ts exactly, or the query cannot
-- use it; a test holds the two together.
CREATE INDEX wallet_transactions_notice_idx
  ON wallet_transactions (user_id, created_at DESC)
  WHERE kind IN ('cash_deposit', 'pay_login_deposit', 'cash_withdrawal_refund', 'tip_received', 'referral_bonus', 'race_payout', 'faction_payout', 'jackpot_win', 'admin_adjustment', 'discord_join_reward', 'discord_tag_reward', 'discord_invite_reward', 'signup_bonus');

-- Supersedes donut_schema_ready_v69.
CREATE FUNCTION donut_schema_ready_v70() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v70() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v70() TO donut_api_runtime;

COMMIT;
