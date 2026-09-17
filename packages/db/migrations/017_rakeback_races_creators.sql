BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rakeback
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Four cash-back tiers that accrue on every wager and are claimed on four different clocks:
-- instant has no cooldown, then daily, weekly and monthly.
--
-- THE RATES ARE PERCENTAGES OF THE HOUSE MARGIN, NOT OF THE WAGER. This is the single most
-- important thing about this table and the reason it is stated here rather than in a route:
-- the platform's edge is 5%, so a "10% instant rakeback" priced off turnover would pay out two
-- hundred percent of what the wager earned the house and the game would be a money pump running
-- in the player's favour. Priced off the margin, the four tiers together return 20% of the edge
-- and the house keeps the other 80%. Every figure in the product copy means margin.
--
-- One row per user per tier. The running total is maintained on the row rather than summed from
-- the wager history, for the same reason the referral ledger does it: the accrual runs inside the
-- hot path of every case open and every upgrader pull, and an aggregate over all history costs a
-- scan that grows forever.
CREATE TABLE rakeback_accruals (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier varchar(8) NOT NULL CHECK (tier IN ('instant', 'daily', 'weekly', 'monthly')),
  -- Everything this tier has ever earned, and everything it has ever paid out. The claimable
  -- balance is the difference, which can never be negative because a claim writes both halves in
  -- one statement.
  accrued_minor bigint NOT NULL DEFAULT 0 CHECK (accrued_minor >= 0),
  claimed_minor bigint NOT NULL DEFAULT 0 CHECK (claimed_minor >= 0),
  last_claim_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tier),
  CHECK (claimed_minor <= accrued_minor)
);

-- Append-only, so the dashboard's lifetime figure is a sum of facts rather than a counter.
-- Unique on (user, tier, claimed_at) would still allow a double-submit inside the same
-- microsecond, so idempotency is enforced by the cooldown check under the row lock instead: a
-- tier with a cooldown cannot be claimed twice, and the instant tier cannot be claimed with a
-- zero balance, which a replay always has.
CREATE TABLE rakeback_claims (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  tier varchar(8) NOT NULL CHECK (tier IN ('instant', 'daily', 'weekly', 'monthly')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rakeback_claims_user_idx ON rakeback_claims (user_id, created_at DESC);
CREATE TRIGGER rakeback_claims_append_only
  BEFORE UPDATE OR DELETE ON rakeback_claims FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- Wagering races
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A timed leaderboard with a fixed prize pool, settled by rank. Structurally close to the faction
-- war, and deliberately so — but a race ranks individuals rather than teams, and a player is
-- entered by wagering rather than by choosing to join.
--
-- The payout curve is stored ON THE RACE rather than computed at settlement, so the split a
-- player was shown while competing is the split they are actually paid. A curve that lives in
-- application code can be edited mid-race and nobody would be able to prove it had been.
CREATE TABLE wager_races (
  id uuid PRIMARY KEY,
  slug varchar(64) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name varchar(96) NOT NULL,
  -- 'daily' and 'weekly' are the two cadences the product ships; the column is a label for
  -- grouping in the UI and does not drive the clock, which is starts_at/ends_at.
  cadence varchar(8) NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  prize_pool_minor bigint NOT NULL CHECK (prize_pool_minor > 0),
  -- An array of basis points, highest rank first: [3000, 2000, 1200, ...]. Validated in the API
  -- to sum to at most 10000, because a curve that sums above it would pay out more than the pool.
  payout_curve jsonb NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (jsonb_typeof(payout_curve) = 'array')
);
CREATE INDEX wager_races_live_idx ON wager_races (ends_at DESC) WHERE settled_at IS NULL;

-- One row per player per race. Created lazily on the player's first wager inside the window, so a
-- race costs nothing for anybody who does not play during it.
CREATE TABLE wager_race_entries (
  race_id uuid NOT NULL REFERENCES wager_races(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  wagered_minor bigint NOT NULL DEFAULT 0 CHECK (wagered_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (race_id, user_id)
);
-- The leaderboard read: the top N of one race, by volume. Ties break on who got there first.
CREATE INDEX wager_race_entries_board_idx
  ON wager_race_entries (race_id, wagered_minor DESC, updated_at);

CREATE TABLE wager_race_payouts (
  id uuid PRIMARY KEY,
  race_id uuid NOT NULL REFERENCES wager_races(id),
  user_id uuid NOT NULL REFERENCES users(id),
  rank integer NOT NULL CHECK (rank > 0),
  wagered_minor bigint NOT NULL CHECK (wagered_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One payout per player per race, and one player per rank.
  UNIQUE (race_id, user_id),
  UNIQUE (race_id, rank)
);
CREATE TRIGGER wager_race_payouts_append_only
  BEFORE UPDATE OR DELETE ON wager_race_payouts FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- Creator programme
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An application to run a vanity referral code at a boosted revenue share. It is an application
-- rather than a self-serve toggle because the boosted rate comes out of the house margin, and a
-- rate anybody can grant themselves is not a rate.
--
-- The requested code is reserved at review time, not at application time: holding a code for
-- every hopeful applicant would let somebody squat every short string on the site by filing
-- applications they never intend to complete.
CREATE TABLE creator_applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform varchar(16) NOT NULL CHECK (platform IN ('youtube', 'twitch', 'tiktok', 'kick', 'x')),
  -- Stored as supplied and never rendered as markup. Length-capped so a URL cannot be used as a
  -- free-text payload store.
  channel_url varchar(512) NOT NULL CHECK (length(btrim(channel_url)) > 0),
  audience_size integer NOT NULL CHECK (audience_size >= 0),
  requested_code varchar(16) NOT NULL CHECK (requested_code ~ '^[A-Z0-9]{3,16}$'),
  status varchar(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  -- Filled on approval. The boost is the creator's revenue share in basis points of the house
  -- margin, replacing the default programme rate for codes they own.
  granted_revshare_bps integer CHECK (granted_revshare_bps BETWEEN 0 AND 10000),
  reviewer_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note varchar(512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CHECK (granted_revshare_bps IS NULL OR status = 'approved')
);
-- One open application per account. A partial index rather than a plain unique constraint, so a
-- rejected applicant can apply again later without the old row blocking them.
CREATE UNIQUE INDEX creator_applications_one_open_idx
  ON creator_applications (user_id) WHERE status = 'pending';
CREATE INDEX creator_applications_queue_idx
  ON creator_applications (created_at) WHERE status = 'pending';

-- Rakeback and race money moves through the same wallet ledger as everything else, so it lands in
-- a player's history beside their wins instead of appearing from nowhere.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake',
      'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break',
      'upgrade_win', 'case_win', 'quest_reward', 'streak_reward', 'faction_payout',
      'battle_stake', 'battle_win', 'battle_refund', 'creator_royalty',
      'referral_revshare', 'referral_bonus',
      'rakeback_claim', 'race_payout'
    ));

GRANT SELECT, INSERT ON TABLE
  rakeback_accruals, rakeback_claims, wager_races, wager_race_entries, wager_race_payouts,
  creator_applications
TO donut_api_runtime;
-- UPDATE where a row genuinely moves: a running total, a race being settled, an application being
-- reviewed or withdrawn. The two append-only ledgers get none, and both carry a trigger that
-- refuses one regardless of what is granted.
GRANT UPDATE ON TABLE
  rakeback_accruals, wager_races, wager_race_entries, creator_applications
TO donut_api_runtime;

-- Supersedes donut_schema_ready_v16.
CREATE FUNCTION donut_schema_ready_v17() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v17() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v17() TO donut_api_runtime;

COMMIT;
