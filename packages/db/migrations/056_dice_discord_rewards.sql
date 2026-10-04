BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Dice, and the Discord rewards
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A game settled the way Plinko is: one bet per row, decided and paid in the request that
-- places it, from the player's committed fairness seed (services/api-gateway/src/lib/dice.ts).
-- A row is written once and never updated, so the runtime role gets no UPDATE on it.
--
-- And the Discord side of the community: a one-time code that links a Discord account to a site
-- account through the community bot (the OAuth link stays; this one works without it), and the
-- rewards that link unlocks -- joining the server, wearing its tag, inviting people into it.
--
-- Every change to an existing table below WIDENS a constraint or adds a nullable/defaulted column.
-- Widening cannot fail against existing rows; narrowing is how migration 030 took production down.

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
      'crash_stake', 'crash_payout',
      'mines_stake', 'mines_payout',
      'plinko_stake', 'plinko_payout',
      'coinflip_stake', 'coinflip_win', 'coinflip_refund',
      'dice_stake', 'dice_payout',
      'discord_join_reward', 'discord_tag_reward', 'discord_invite_reward'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice'));

-- ── dice ───────────────────────────────────────────────────────────────────
CREATE TABLE dice_bets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  direction varchar(5) NOT NULL CHECK (direction IN ('under', 'over')),
  -- The line and the roll in hundredths: 50.00 is 5000, the roll runs 0 to 9999.
  target smallint NOT NULL CHECK (target BETWEEN 1 AND 9999),
  chance smallint NOT NULL CHECK (chance BETWEEN 100 AND 8900),
  roll smallint NOT NULL CHECK (roll BETWEEN 0 AND 9999),
  multiplier_bps integer NOT NULL CHECK (multiplier_bps > 10000),
  win boolean NOT NULL,
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  server_seed_reveal char(64) NOT NULL,
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  -- A seed draws one roll.
  UNIQUE (fairness_seed_id),
  CHECK (win = (payout_minor > 0))
);
CREATE INDEX dice_bets_user_idx ON dice_bets (user_id, created_at DESC);
CREATE INDEX dice_bets_feed_idx ON dice_bets (created_at DESC);

GRANT SELECT, INSERT ON TABLE dice_bets TO donut_api_runtime;

-- ── linking through the community bot ─────────────────────────────────────
-- The site shows a signed-in player a short code; they type it into `/link` in the Discord server.
-- The session proves the account, Discord proves the snowflake on the interaction, and the code
-- ties the two. Only its hash is stored, it is single-use, and it lives ten minutes.
CREATE TABLE discord_link_codes (
  code_hash char(64) PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discord_link_codes_user_idx ON discord_link_codes (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE discord_link_codes TO donut_api_runtime;

-- ── the rewards ────────────────────────────────────────────────────────────
-- One row per payment, and the unique indexes below are the rules: a join reward once per site
-- account and once per Discord account, a tag reward once per account per UTC day, an invite
-- reward once per invited Discord account, ever.
CREATE TABLE discord_rewards (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  discord_user_id varchar(32) NOT NULL CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  kind varchar(8) NOT NULL CHECK (kind IN ('join', 'tag', 'invite')),
  -- The UTC day a tag reward is for.
  reward_day date,
  -- The member whose joining paid an invite reward.
  invitee_discord_id varchar(32) CHECK (invitee_discord_id ~ '^[0-9]{5,32}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'tag') = (reward_day IS NOT NULL)),
  CHECK ((kind = 'invite') = (invitee_discord_id IS NOT NULL))
);
CREATE UNIQUE INDEX discord_rewards_join_user_idx ON discord_rewards (user_id) WHERE kind = 'join';
CREATE UNIQUE INDEX discord_rewards_join_discord_idx
  ON discord_rewards (discord_user_id) WHERE kind = 'join';
CREATE UNIQUE INDEX discord_rewards_tag_idx
  ON discord_rewards (user_id, reward_day) WHERE kind = 'tag';
CREATE UNIQUE INDEX discord_rewards_tag_discord_idx
  ON discord_rewards (discord_user_id, reward_day) WHERE kind = 'tag';
CREATE UNIQUE INDEX discord_rewards_invite_idx
  ON discord_rewards (invitee_discord_id) WHERE kind = 'invite';
CREATE INDEX discord_rewards_user_idx ON discord_rewards (user_id, created_at DESC);

GRANT SELECT, INSERT ON TABLE discord_rewards TO donut_api_runtime;

-- ── giveaways for tag wearers ──────────────────────────────────────────────
ALTER TABLE discord_giveaways ADD COLUMN tag_required boolean NOT NULL DEFAULT false;

-- Supersedes donut_schema_ready_v55.
CREATE FUNCTION donut_schema_ready_v56() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v56() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v56() TO donut_api_runtime;

COMMIT;
