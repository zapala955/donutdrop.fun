BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Discord identity
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A Discord snowflake is a public identifier, not a secret, so it is stored in the clear like the
-- Minecraft identity beside it. What matters is that it is UNIQUE: the referral programme pays a
-- fixed bonus per verified referee, so one Discord account being reusable across many site
-- accounts would turn that bonus into a faucet. The partial unique index enforces one site
-- account per Discord account while still letting every unverified row hold NULL.
--
-- The id and the verification timestamp are written together and never apart: a row naming a
-- Discord account without saying when it was proven is a half-fact the payout gate would have to
-- guess about, so the constraint refuses it.
ALTER TABLE users
  ADD COLUMN discord_user_id varchar(32) CHECK (discord_user_id ~ '^[0-9]{5,32}$'),
  ADD COLUMN discord_username varchar(64),
  ADD COLUMN discord_verified_at timestamptz,
  ADD CONSTRAINT users_discord_verification_check
    CHECK (num_nonnulls(discord_user_id, discord_verified_at) IN (0, 2));

CREATE UNIQUE INDEX users_discord_user_id_idx
  ON users (discord_user_id) WHERE discord_user_id IS NOT NULL;

-- The OAuth round trip. Only the HASH of the state parameter is stored: the raw value travels in
-- a URL that lands in browser history and in Discord's own referer header, and a stolen state
-- that is replayable against the database is a session-fixation primitive. The row is consumed on
-- first use and expires on its own, so a leaked callback URL is worth nothing twice.
CREATE TABLE discord_oauth_states (
  state_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX discord_oauth_states_expiry_idx ON discord_oauth_states (expires_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- Referrals
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two engines run on one relationship.
--
--   1. A lifetime revenue share on the house's margin from everything the referee wagers. It
--      accrues per wager, inside the same transaction that took the wager.
--   2. A single fixed bonus, unlocked once the referee has BOTH verified a Discord account and
--      crossed a cumulative wager threshold. It pays once, ever, per referee.
--
-- The two do not interact: crossing the milestone does not stop the revenue share, and the
-- revenue share does not count toward the milestone.

-- The invite code is a row rather than a function of the user id. A code derived from the id is a
-- reversible handle on an internal identifier, and a code that cannot be rotated cannot be
-- retired when it is abused.
CREATE TABLE referral_codes (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code varchar(16) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,16}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per REFEREE, which is what makes the relationship permanent and single-valued: the
-- primary key is the referee, so nobody can be referred twice, and the bonus gate has exactly one
-- row to look at.
--
-- wagered_minor is maintained here rather than summed from the ledger on every wager. The
-- milestone check runs in the hot path of every case open, every upgrader pull and every battle
-- seat; a running total on a row already being locked costs one UPDATE, while an aggregate over
-- the whole wager history costs a scan that grows forever.
CREATE TABLE referrals (
  referee_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  referrer_id uuid NOT NULL REFERENCES users(id),
  code varchar(16) NOT NULL REFERENCES referral_codes(code),
  wagered_minor bigint NOT NULL DEFAULT 0 CHECK (wagered_minor >= 0),
  revshare_paid_minor bigint NOT NULL DEFAULT 0 CHECK (revshare_paid_minor >= 0),
  -- The milestone bonus, frozen at the configured amount the moment it unlocks, so that a later
  -- change to the programme cannot rewrite what an already-paid referral was worth.
  bonus_unlocked_at timestamptz,
  bonus_paid_minor bigint CHECK (bonus_paid_minor IS NULL OR bonus_paid_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Self-referral is the first thing anyone tries.
  CHECK (referee_id <> referrer_id),
  CHECK ((bonus_unlocked_at IS NULL) = (bonus_paid_minor IS NULL))
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_id, created_at DESC);

-- Every payment the programme has ever made, append-only, so the dashboard's totals are a sum of
-- facts rather than a counter somebody can nudge.
--
-- The unique index on (kind, reference_id) is the idempotency key, and it does real work in both
-- shapes: a revenue-share row references the round that produced it, so a retried settlement
-- cannot pay the referrer twice for one wager; a milestone row references the referee, so the
-- fixed bonus is structurally unpayable a second time even if the gate is somehow entered twice.
CREATE TABLE referral_earnings (
  id uuid PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES users(id),
  referee_id uuid NOT NULL REFERENCES users(id),
  kind varchar(16) NOT NULL CHECK (kind IN ('revshare', 'milestone')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  -- The wager this was carved from. NULL on a milestone row, which is not carved from anything.
  source varchar(16) CHECK (source IN ('upgrader', 'case', 'piggy_bank')),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'milestone') = (source IS NULL))
);
CREATE UNIQUE INDEX referral_earnings_reference_idx ON referral_earnings (kind, reference_id);
CREATE INDEX referral_earnings_referrer_idx ON referral_earnings (referrer_id, created_at DESC);

CREATE TRIGGER referral_earnings_append_only
  BEFORE UPDATE OR DELETE ON referral_earnings FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Referral money moves through the same wallet ledger as everything else, so it lands in a
-- player's history beside their wins instead of appearing from nowhere.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake',
      'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break',
      'upgrade_win', 'case_win', 'quest_reward', 'streak_reward', 'faction_payout',
      'battle_stake', 'battle_win', 'battle_refund', 'creator_royalty',
      'referral_revshare', 'referral_bonus'
    ));

GRANT SELECT, INSERT ON TABLE
  referral_codes, referrals, referral_earnings, discord_oauth_states
  TO donut_api_runtime;
-- UPDATE on referrals: the running wager total and the bonus gate both move on an existing row.
-- UPDATE on discord_oauth_states: consuming a state is an update, so a replay finds it spent.
-- The Discord columns need no new grant — users already carries UPDATE from 002.
-- Neither referral_codes nor referral_earnings gets UPDATE — a code is issued once and an earning
-- is a historical fact.
GRANT UPDATE ON TABLE referrals, discord_oauth_states TO donut_api_runtime;
-- Expired round trips are swept rather than accumulating forever. Nothing else here is erasable.
GRANT DELETE ON TABLE discord_oauth_states TO donut_api_runtime;

-- Supersedes donut_schema_ready_v15.
CREATE FUNCTION donut_schema_ready_v16() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v16() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v16() TO donut_api_runtime;

COMMIT;
