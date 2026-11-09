BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The quest board: quests that reset every three days
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A quest is a target and a reward: "deposit $10M, get $1M". Every quest resets on the same clock,
-- every three days at 00:00 UTC (lib/quest-board.ts), and a player can claim each one once per
-- period. Nothing is counted while a period runs: a player's progress is read from the ledger and
-- the wager log, which already hold every deposit, withdrawal and wager with its time, so the bar
-- can never disagree with the wallet history behind it.
--
--   deposit  the period's deposits net of its withdrawals. Depositing and withdrawing the same
--            money over and over moves nothing.
--   wager    the period's wagers.
--
-- The operator writes the quests in the admin console. This migration adds none.
CREATE TABLE board_quests (
  id uuid PRIMARY KEY,
  name varchar(80) NOT NULL CHECK (length(btrim(name)) > 0),
  description varchar(240) NOT NULL DEFAULT '',
  kind varchar(16) NOT NULL CHECK (kind IN ('deposit', 'wager')),
  target_minor bigint NOT NULL CHECK (target_minor > 0),
  reward_minor bigint NOT NULL CHECK (reward_minor > 0),
  sort_order integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One claim per player per quest per period. The primary key is the guard against paying twice:
-- a second claim, however it arrives, finds the row and is refused. The reward is frozen on the
-- row, so a later edit of the quest cannot change what a past claim was worth. The ledger entry is
-- 'quest_reward' with this row's id as its reference.
CREATE TABLE board_quest_claims (
  id uuid NOT NULL UNIQUE,
  quest_id uuid NOT NULL REFERENCES board_quests(id),
  user_id uuid NOT NULL REFERENCES users(id),
  period_start timestamptz NOT NULL,
  progress_minor bigint NOT NULL CHECK (progress_minor > 0),
  reward_minor bigint NOT NULL CHECK (reward_minor > 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quest_id, user_id, period_start)
);
CREATE INDEX board_quest_claims_user_idx ON board_quest_claims (user_id, period_start DESC);
CREATE INDEX board_quest_claims_period_idx ON board_quest_claims (period_start, quest_id);

-- ── the old quests come down ────────────────────────────────────────────────────────────────────
-- The daily quests are switched off, as the console's own switch would; their rows and every
-- claim stay, and the console can switch any of them back on. (The weekly quests have their own
-- switch in the console's settings; the page no longer shows them.)
UPDATE quest_definitions SET enabled = false, updated_at = now() WHERE enabled;

-- ── grants ─────────────────────────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON TABLE board_quests TO donut_api_runtime;
GRANT SELECT, INSERT ON TABLE board_quest_claims TO donut_api_runtime;

-- Supersedes donut_schema_ready_v86.
CREATE FUNCTION donut_schema_ready_v87() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v87() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v87() TO donut_api_runtime;

COMMIT;
