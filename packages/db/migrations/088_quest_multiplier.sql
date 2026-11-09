BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Multiplier quests, and the first three quests on the board
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A third kind of quest: hit a multiplier on one bet of at least a minimum stake, in any game,
-- within the period (lib/quest-board.ts, bestMultiplierFor). Its target is the multiplier in
-- hundredths (2500 is 25x); the minimum stake is its own column, required for this kind only.
ALTER TABLE board_quests DROP CONSTRAINT board_quests_kind_check;
ALTER TABLE board_quests
  ADD CONSTRAINT board_quests_kind_check CHECK (kind IN ('deposit', 'wager', 'multiplier'));
ALTER TABLE board_quests ADD COLUMN min_stake_minor bigint CHECK (min_stake_minor IS NULL OR min_stake_minor > 0);
ALTER TABLE board_quests
  ADD CONSTRAINT board_quests_min_stake_check CHECK ((kind = 'multiplier') = (min_stake_minor IS NOT NULL));

-- The operator's first quests (2026-11-09). From here on they are edited, switched off or added to
-- in the console (Programs, Quest board), like any other.
INSERT INTO board_quests (id, name, description, kind, target_minor, reward_minor, sort_order, enabled, min_stake_minor)
VALUES
  (gen_random_uuid(), 'Wager $100M', 'Play any game.', 'wager', 100000000, 5000000, 1, true, NULL),
  (gen_random_uuid(), 'Deposit $50M', 'Deposit in game.', 'deposit', 50000000, 5000000, 2, true, NULL),
  (gen_random_uuid(), 'Hit a 25× multiplier', 'Win 25× or more on a single bet of $1M or more, in any game.',
   'multiplier', 2500, 20000000, 3, true, 1000000);

-- Supersedes donut_schema_ready_v87.
CREATE FUNCTION donut_schema_ready_v88() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v88() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v88() TO donut_api_runtime;

COMMIT;
