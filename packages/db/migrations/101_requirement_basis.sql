BEGIN;

-- The owner, 2026-11-15, after the Lava Rain hold was fixed to let go of lost rain money: "make sure
-- every wager req works correctly scan everything so theres so issue like this in the future".
--
-- The running figure (user_wager_requirements) had the same fault the rain hold had. It only ever
-- came down by wagering, so a player who lost most of a bonus still owed all of it, and their next
-- deposit stacked on top: a $10M invite bonus at 10x lost down to $270K still owed about $67M before
-- the player could withdraw a deposit of their own. Only an all-in to nothing was forgiven.
--
-- basis_minor is what the figure is FOR: the money credited (a deposit, a bonus) that has not been
-- wagered off yet. It works like the rain hold's held_minor (lib/wager-requirements.ts,
-- settleWagerRequirement): with nothing in play, a basis above the balance comes down to the balance
-- and what is owed comes down in proportion, so a requirement dies with the money it was for.

ALTER TABLE user_wager_requirements
  ADD COLUMN basis_minor bigint NOT NULL DEFAULT 0 CHECK (basis_minor >= 0);

-- What is owed today has no record of the credits behind it, so their basis is estimated from below:
-- what is owed divided by the largest multiplier any credit could have carried. 10x for an account
-- paid the $10M invite signup bonus (the only 10x credit there has ever been), 5x for every other
-- (the signup bonus was 5x until 2026-10-09; deposits never above 2x, quests and code drops 3x).
-- A smaller basis lets go later and less, so the estimate can never let money out early: an account
-- owes at most 5x (or 10x) what it has left, and every credit from now on is tracked exactly.
UPDATE user_wager_requirements q
   SET basis_minor = ceil(q.remaining_minor::numeric / CASE
         WHEN EXISTS (SELECT 1 FROM wallet_transactions t
                       WHERE t.user_id = q.user_id AND t.kind = 'signup_bonus' AND t.amount_minor >= 5000000)
           OR EXISTS (SELECT 1 FROM referrals f WHERE f.referee_id = q.user_id AND f.signup_bonus_minor > 0)
         THEN 10 ELSE 5 END)::bigint
 WHERE q.remaining_minor > 0;

-- Supersedes donut_schema_ready_v100.
CREATE FUNCTION donut_schema_ready_v101() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v101() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v101() TO donut_api_runtime;

COMMIT;
