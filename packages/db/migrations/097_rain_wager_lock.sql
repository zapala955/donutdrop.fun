BEGIN;

-- Lava Rain money is locked on its own (2026-11-14). The owner wants rains far bigger than before, and
-- a rain share that may be withdrawn after a light wager pays every alt that claims one. So a share
-- now carries its own requirement, at rainWagerMultiplier, held apart from the account's one running
-- figure (user_wager_requirements): until it is wagered off, only the rain money stays in the account.
-- A deposit, a win or a bonus already wagered can still leave; the rest of the balance is not held.
--
--   held_minor       how much of the balance is rain money that may not leave yet;
--   remaining_minor  what is still to wager before it may. At zero both are cleared.
--
-- Rows exist only for players who have claimed a share since; no row means nothing is held.

CREATE TABLE user_rain_locks (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  held_minor bigint NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
  remaining_minor bigint NOT NULL DEFAULT 0 CHECK (remaining_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON TABLE user_rain_locks TO donut_api_runtime;

-- Supersedes donut_schema_ready_v96.
CREATE FUNCTION donut_schema_ready_v97() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v97() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v97() TO donut_api_runtime;

COMMIT;
