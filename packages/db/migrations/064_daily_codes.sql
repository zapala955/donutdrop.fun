BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Daily codes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A member opts in with /daily on. Once a day the community bot sends them a personal one-use code
-- in a DM, and they redeem it (/redeem, or by replying to the DM with it) for a random prize from
-- nothing up to a ceiling set in the dashboard. The bot issues and delivers codes; the gateway
-- decides the prize and pays it, so the bot never touches a wallet.
--
-- Everything here is additive: two new tables, two new columns with defaults, one ledger kind added
-- to the allowed list (a widening, so every existing row still satisfies it).

-- ── who wants a code, and when they last got one ───────────────────────────
CREATE TABLE discord_daily_subscribers (
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  discord_user_id varchar(32) NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  subscribed_at timestamptz NOT NULL DEFAULT now(),
  -- The UTC day of the last code sent. The bot claims it with a guarded UPDATE BEFORE it sends, so
  -- two ticks racing each other send one code a day, and a crash never sends two.
  last_sent_on date,
  -- Consecutive DMs that could not be delivered. Three in a row unsubscribes the member: a code to
  -- somebody whose DMs are closed is a code nobody will ever read.
  failures smallint NOT NULL DEFAULT 0 CHECK (failures >= 0),
  PRIMARY KEY (guild_id, discord_user_id)
);
CREATE INDEX discord_daily_subscribers_due_idx
  ON discord_daily_subscribers (guild_id, last_sent_on);

-- ── the codes ──────────────────────────────────────────────────────────────
-- One code per member per UTC day, personal to that Discord account, valid once and for a day. The
-- prize is decided at redemption and stored with it, so the row is the whole record of what was won.
CREATE TABLE discord_daily_codes (
  id uuid PRIMARY KEY,
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  discord_user_id varchar(32) NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  -- Eight characters from an alphabet without 0, 1, I or O, so a code read off a screen is typeable.
  code varchar(8) NOT NULL UNIQUE CHECK (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  issued_on date NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  -- Who was paid, and what, written together with redeemed_at or not at all. A prize of 0 is a
  -- redemption too: the code is spent, nothing is credited.
  user_id uuid REFERENCES users(id),
  prize_minor bigint CHECK (prize_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, discord_user_id, issued_on),
  CHECK ((redeemed_at IS NULL) = (user_id IS NULL)),
  CHECK ((redeemed_at IS NULL) = (prize_minor IS NULL))
);
-- "How much was paid today" and "has this account redeemed today", both by time.
CREATE INDEX discord_daily_codes_redeemed_idx
  ON discord_daily_codes (redeemed_at) WHERE redeemed_at IS NOT NULL;
CREATE INDEX discord_daily_codes_user_idx
  ON discord_daily_codes (user_id, redeemed_at) WHERE user_id IS NOT NULL;

-- ── the dashboard's two switches for the sender ────────────────────────────
-- Off until an operator turns it on, so deploying this sends nobody anything.
ALTER TABLE discord_guild_settings
  ADD COLUMN daily_codes_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN daily_codes_hour smallint NOT NULL DEFAULT 16
    CONSTRAINT discord_guild_daily_codes_hour_range CHECK (daily_codes_hour BETWEEN 0 AND 23);

-- ── the ledger ─────────────────────────────────────────────────────────────
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
      'daily_code_reward'
    ));

-- ── grants ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE discord_daily_subscribers TO donut_api_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE discord_daily_codes TO donut_api_runtime;

-- The bot may run under its own narrower role (infra/postgres/community-bot-role.sql). Where that
-- role exists it owns exactly the tables the bot uses, so these two are added to it; where it does
-- not, the bot uses the API's role and the grants above already cover it. The bot never reads
-- `users`: it asks the gateway to redeem.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_community_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      discord_daily_subscribers, discord_daily_codes TO donut_community_runtime;
  END IF;
END
$grants$;

-- Supersedes donut_schema_ready_v63.
CREATE FUNCTION donut_schema_ready_v64() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v64() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v64() TO donut_api_runtime;

COMMIT;
