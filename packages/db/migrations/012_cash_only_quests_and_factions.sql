BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Cash-only platform: auto-converted wins, quests and streaks, faction war.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT CHANGED AND WHY IT IS SAFE
-- -------------------------------
-- Players no longer hold inventory. Cases and the upgrader still roll a catalog ITEM — that is
-- what carries the rarity, the name and the art the reveal animation needs — but the prize is
-- settled immediately as cash and no lot is ever handed to the player.
--
-- The item tables are deliberately NOT dropped. Deposits, withdrawals, house stock and custody
-- movements still reference them, the audit history of every past round points at them, and the
-- append-only triggers mean that history cannot be rewritten anyway. Dropping them would destroy
-- the record of how the platform got here to save nothing.
--
-- CONVERSION RATE
-- ---------------
-- Wins convert at the item's FULL unit value, not at ITEM_SELL_RATE_BPS. The upgrader quotes a
-- target value and prices the win chance from it; paying out 90% of that figure would be a second
-- edge hidden underneath the published one. The house edge stays the whole take.
ALTER TABLE upgrader_rounds
  ADD COLUMN payout_minor bigint,
  ADD COLUMN payout_balance_after_minor bigint;
ALTER TABLE upgrader_rounds
  ADD CONSTRAINT upgrader_rounds_payout_nonneg_check
    CHECK (payout_minor IS NULL OR payout_minor >= 0),
  ADD CONSTRAINT upgrader_rounds_payout_balance_check
    CHECK (payout_balance_after_minor IS NULL OR payout_balance_after_minor >= 0),
  -- A payout only exists on a win, and a win that paid records both figures or neither.
  ADD CONSTRAINT upgrader_rounds_payout_shape_check
    CHECK (
      (payout_minor IS NULL AND payout_balance_after_minor IS NULL)
      OR (payout_minor IS NOT NULL AND payout_balance_after_minor IS NOT NULL AND outcome = 'win')
    );

ALTER TABLE case_rounds
  ADD COLUMN payout_minor bigint,
  ADD COLUMN payout_balance_after_minor bigint;
ALTER TABLE case_rounds
  ADD CONSTRAINT case_rounds_payout_nonneg_check
    CHECK (payout_minor IS NULL OR payout_minor >= 0),
  ADD CONSTRAINT case_rounds_payout_balance_check
    CHECK (payout_balance_after_minor IS NULL OR payout_balance_after_minor >= 0),
  ADD CONSTRAINT case_rounds_payout_shape_check
    CHECK (
      (payout_minor IS NULL AND payout_balance_after_minor IS NULL)
      OR (payout_minor IS NOT NULL AND payout_balance_after_minor IS NOT NULL)
    );

-- ═══════════════════════════════════════════════════════════════════════════
-- Quests and daily streaks
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A quest is a counter with a target and a reward. Progress is recorded per UTC day so "today"
-- means the same thing for every player and cannot be shifted by a timezone header.
CREATE TABLE quest_definitions (
  code varchar(48) PRIMARY KEY CHECK (code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  name varchar(96) NOT NULL,
  description varchar(256) NOT NULL,
  -- What the counter counts. Every metric is incremented from a server-side event, never from a
  -- client claim, so a quest cannot be completed by asking nicely.
  metric varchar(32) NOT NULL
    CHECK (metric IN ('upgrader_rolls', 'upgrader_wins', 'cases_opened', 'wagered_minor',
                      'piggy_deposits', 'faction_contribution_minor')),
  target_value bigint NOT NULL CHECK (target_value > 0),
  reward_minor bigint NOT NULL CHECK (reward_minor > 0),
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quest_progress (
  user_id uuid NOT NULL REFERENCES users(id),
  quest_code varchar(48) NOT NULL REFERENCES quest_definitions(code),
  -- UTC day. One row per player per quest per day.
  quest_day date NOT NULL,
  progress_value bigint NOT NULL DEFAULT 0 CHECK (progress_value >= 0),
  -- Frozen when the quest is claimed, so a later change to the definition cannot alter what a
  -- historical claim was worth.
  claimed_at timestamptz,
  claimed_reward_minor bigint,
  balance_after_minor bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, quest_code, quest_day),
  CHECK (
    (claimed_at IS NULL AND claimed_reward_minor IS NULL AND balance_after_minor IS NULL)
    OR (claimed_at IS NOT NULL AND claimed_reward_minor IS NOT NULL AND balance_after_minor IS NOT NULL)
  ),
  CHECK (claimed_reward_minor IS NULL OR claimed_reward_minor > 0),
  CHECK (balance_after_minor IS NULL OR balance_after_minor >= 0)
);
CREATE INDEX quest_progress_day_idx ON quest_progress (user_id, quest_day DESC);

-- The streak is a property of the player, not of a day, so it is one row that moves forward.
CREATE TABLE user_streaks (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  current_streak integer NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
  longest_streak integer NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
  last_claim_day date,
  total_claims integer NOT NULL DEFAULT 0 CHECK (total_claims >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (longest_streak >= current_streak)
);

CREATE TABLE streak_claims (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  claim_day date NOT NULL,
  streak_length integer NOT NULL CHECK (streak_length > 0),
  reward_minor bigint NOT NULL CHECK (reward_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, claim_day)
);
CREATE TRIGGER streak_claims_append_only
  BEFORE UPDATE OR DELETE ON streak_claims FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ═══════════════════════════════════════════════════════════════════════════
-- Faction war
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A timed event with a fixed prize pool, three teams, and a contribution ledger. Contributions
-- are written by the same transaction that took the wager, so the leaderboard cannot drift from
-- what was actually played.
CREATE TABLE faction_events (
  id uuid PRIMARY KEY,
  slug varchar(64) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name varchar(128) NOT NULL,
  description varchar(512) NOT NULL DEFAULT '',
  prize_pool_minor bigint NOT NULL CHECK (prize_pool_minor > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX faction_events_window_idx ON faction_events (starts_at, ends_at);

CREATE TABLE factions (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES faction_events(id),
  code varchar(32) NOT NULL CHECK (code ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  name varchar(64) NOT NULL,
  -- Hex, and the application refuses anything in the purged violet wedge. Stored so the war room
  -- colours come from data rather than a hardcoded switch in the client.
  color char(7) NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  blurb varchar(256) NOT NULL DEFAULT '',
  UNIQUE (event_id, code)
);

CREATE TABLE faction_members (
  event_id uuid NOT NULL REFERENCES faction_events(id),
  user_id uuid NOT NULL REFERENCES users(id),
  faction_id uuid NOT NULL REFERENCES factions(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  -- One team per player per event. Switching sides mid-war would make every leaderboard a lie.
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX faction_members_faction_idx ON faction_members (faction_id);

CREATE TABLE faction_contributions (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES faction_events(id),
  faction_id uuid NOT NULL REFERENCES factions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  source varchar(24) NOT NULL CHECK (source IN ('upgrader', 'case', 'piggy_bank')),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One contribution per wager, however many times a request is replayed.
  UNIQUE (source, reference_id)
);
CREATE INDEX faction_contributions_board_idx
  ON faction_contributions (event_id, faction_id, created_at DESC);
CREATE INDEX faction_contributions_user_idx ON faction_contributions (event_id, user_id);
CREATE TRIGGER faction_contributions_append_only
  BEFORE UPDATE OR DELETE ON faction_contributions FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE faction_payouts (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES faction_events(id),
  user_id uuid NOT NULL REFERENCES users(id),
  faction_id uuid NOT NULL REFERENCES factions(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A player is paid once per event, whatever a retry does.
  UNIQUE (event_id, user_id)
);
CREATE TRIGGER faction_payouts_append_only
  BEFORE UPDATE OR DELETE ON faction_payouts FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Every one of these moves real balance, so every one lands in the one wallet ledger.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake',
      'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break',
      'upgrade_win', 'case_win', 'quest_reward', 'streak_reward', 'faction_payout'
    ));

GRANT SELECT, INSERT ON TABLE
  quest_definitions, quest_progress, user_streaks, streak_claims,
  faction_events, factions, faction_members, faction_contributions, faction_payouts
  TO donut_api_runtime;
GRANT UPDATE ON TABLE quest_progress, user_streaks TO donut_api_runtime;
-- No UPDATE on upgrader_rounds or case_rounds: both carry an append-only trigger that rejects
-- every UPDATE and DELETE. The payout is known before the row is written, so it goes in on the
-- INSERT. Granting UPDATE here would advertise a capability the database refuses to honour.

-- Supersedes donut_schema_ready_v11. The readiness probe names the exact schema the running API
-- expects, so an API deployed against an older schema fails its readiness check instead of
-- serving requests against columns that are not there.
CREATE FUNCTION donut_schema_ready_v12() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v12() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v12() TO donut_api_runtime;

COMMIT;
