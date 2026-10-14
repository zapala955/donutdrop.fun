BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Media test mode
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Approved creators (and staff) can switch a session into test mode and play the house games with
-- play money, for recording clips. Test play runs on a separate account, the creator's "test
-- twin": its own users row, its own wallet, its own rounds. Every game then works exactly as it
-- does for anybody else -- same engines, same odds, same provably-fair seeds -- and the play money
-- can never meet the real economy, because it never sits in a real account.
--
-- The twin is recognised by `demo_of` (the creator it belongs to) and by its `demo:` identity,
-- which is what the staff predicate in lib/admin-stats.ts already keys on for the `dev:` and
-- `system:` accounts. Keeping both in step is what the CHECK below is for: a twin without the
-- identity prefix would be counted in the house figures and the anti-drain monitor.
--
-- Additive: two new columns on users, one on sessions, one new ledger kind; nothing existing
-- changes.

ALTER TABLE users ADD COLUMN demo_of uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users
  ADD CONSTRAINT users_demo_identity_check
    CHECK (demo_of IS NULL OR minecraft_identity LIKE 'demo:%');
-- One twin per creator. Partial, so the ordinary accounts (all NULL) do not crowd the index.
CREATE UNIQUE INDEX users_demo_of_idx ON users (demo_of) WHERE demo_of IS NOT NULL;

-- Per session rather than per account: a creator recording on one device and playing for real on
-- another is two sessions and two answers.
ALTER TABLE sessions ADD COLUMN demo_mode boolean NOT NULL DEFAULT false;

-- Play money is paid into the twin's wallet through the ledger like every other credit, so the
-- twin's history explains its balance. `demo_topup` exists only on twin accounts.
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
      'demo_topup'
    ));

-- Supersedes donut_schema_ready_v66 (066 is the same-network referral block, already applied when
-- this was first numbered 066 too).
CREATE FUNCTION donut_schema_ready_v67() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v67() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v67() TO donut_api_runtime;

COMMIT;
