BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rakeback becomes a single instant tier
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The daily, weekly and monthly clocks are retired. Only 'instant' (a share of the house margin,
-- claimable whenever there is a balance) and 'vip' (a share of the WAGER, claimed from the VIP
-- page) remain.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- THE BALANCES ARE MOVED, NOT DROPPED
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `accrued_minor - claimed_minor` on a retired tier is money a player has already earned and has
-- not yet been paid. Deleting those rows would take it off them silently, and a monthly tier by
-- definition holds up to thirty days of it. Each player's outstanding balance is added to their
-- instant tier instead, so the same money is claimable from the one button that remains.
--
-- This creates no money: it only relabels which tier owes it. `accrued_minor` is the only column
-- that moves, so the table's own `claimed_minor <= accrued_minor` invariant still holds.
DO $$
DECLARE
  moved_users bigint;
  moved_minor bigint;
BEGIN
  SELECT count(*), coalesce(sum(outstanding), 0) INTO moved_users, moved_minor
    FROM (
      SELECT user_id, sum(accrued_minor - claimed_minor) AS outstanding
        FROM rakeback_accruals
       WHERE tier IN ('daily', 'weekly', 'monthly')
       GROUP BY user_id
      HAVING sum(accrued_minor - claimed_minor) > 0
    ) AS pending;

  -- Printed rather than assumed. A deploy that silently moved somebody's balance is a deploy
  -- nobody can answer questions about afterwards.
  RAISE NOTICE 'Folding % of retired rakeback into the instant tier for % player(s)',
    moved_minor, moved_users;
END $$;

INSERT INTO rakeback_accruals (user_id, tier, accrued_minor, claimed_minor)
SELECT user_id, 'instant', sum(accrued_minor - claimed_minor), 0
  FROM rakeback_accruals
 WHERE tier IN ('daily', 'weekly', 'monthly')
 GROUP BY user_id
HAVING sum(accrued_minor - claimed_minor) > 0
ON CONFLICT (user_id, tier) DO UPDATE
  SET accrued_minor = rakeback_accruals.accrued_minor + EXCLUDED.accrued_minor,
      updated_at = now();

DELETE FROM rakeback_accruals WHERE tier IN ('daily', 'weekly', 'monthly');

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- THE TIER CHECK IS DELIBERATELY LEFT WIDE
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Narrowing it to ('instant', 'vip') is the tidy-looking move and it is the wrong one.
--
-- Migrations run to completion BEFORE the new API container is started, and the PREVIOUS build is
-- still serving traffic for those seconds. That build credits all four tiers on every wager. A
-- CHECK it violates would not fail quietly -- it would abort the settlement transaction of every
-- case open and every upgrader pull until the new container took over.
--
-- The cost of leaving it wide is that the old build may write a few seconds of daily/weekly/
-- monthly accrual after this ran, which the new build then ignores. That residue is seconds of
-- margin across all players. The cost of narrowing it is failed settlements on live rounds.
-- A later migration can narrow it once no build that writes those tiers can still be running.
--
-- `rakeback_claims` keeps its own wide CHECK permanently: those rows are history, they are
-- append-only by trigger, and a player's past daily claim really did happen.

-- Supersedes donut_schema_ready_v41. An API build that only knows the instant tier must not
-- become ready against a database still holding balances on the retired ones.
CREATE FUNCTION donut_schema_ready_v42() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v42() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v42() TO donut_api_runtime;

COMMIT;
