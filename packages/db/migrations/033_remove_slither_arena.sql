BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Remove the slither arena.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The mode is gone from the API and the client. This drops the two tables behind it.
--
-- ── TWO GUARDS, BECAUSE THERE ARE TWO WAYS MONEY IS IN FLIGHT ──
--
-- 1. A SESSION THAT IS STILL ALIVE.
--
--    `status = 'alive'` means a buy-in has been debited and the snake carrying it has neither
--    cashed out nor died. The value is real, it is owed, and the routes that could settle it are
--    deleted in the same commit as this migration. Dropping the table would not remove a feature,
--    it would remove the record of a debt with nothing left to notice.
--
-- 2. A SIDE-BET MARKET NOBODY CAN SETTLE.
--
--    This is the one that is easy to miss. Spectators stake on an arena session through
--    `side_bet_markets`, and the ONLY thing that ever settled a slither market was the arena
--    itself — `settleSideBetMarket(db, 'slither', ...)`, called from the kill and cashout paths
--    that no longer exist. Every open or locked slither market is therefore a pool of other
--    people's money with no remaining path to a payout.
--
--    The schema already has the right answer for this and it is not "drop it": 'void' is a real
--    outcome, defined as every stake returned whole with no rake, precisely for a match that
--    produced no answer. A match that can no longer be played is exactly that. But voiding moves
--    money — it credits wallets — and money movement belongs in the settlement code that knows how,
--    not in a DDL migration reimplementing it in SQL. So this refuses, and the markets get voided
--    through the path built for it first.
--
-- A migration that fails stops the deploy, which is loud and recoverable. A migration that succeeds
-- quietly here is neither.
--
-- SLITHER_ARENA_ENABLED has defaulted to false in compose and in the VPS template for its whole
-- life, so on a deployment that never switched it on both checks pass over empty tables.
DO $guard$
DECLARE
  live_count bigint;
  live_minor bigint;
  market_count bigint;
BEGIN
  SELECT count(*), coalesce(sum(entry_minor), 0)
    INTO live_count, live_minor
    FROM slither_sessions
   WHERE status = 'alive';

  IF live_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop the arena: % session(s) are still alive holding % (minor units) of player money. Let them finish, or void them, before removing the mode.',
      live_count, live_minor;
  END IF;

  SELECT count(*)
    INTO market_count
    FROM side_bet_markets
   WHERE kind = 'slither' AND status IN ('open', 'locked');

  IF market_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop the arena: % side-bet market(s) on arena sessions are still open or locked, and nothing can settle them now. Void them first so every stake is returned whole.',
      market_count;
  END IF;
END
$guard$;

-- ── WHAT IS DELIBERATELY LEFT ALONE ──
--
-- 1. wallet_transactions still accepts 'slither_cashout' and 'slither_refund'.
--
--    Those rows exist in players' histories. The ledger is append-only and it is the authoritative
--    record of every movement of cash here, so an extraction outlives the table that described the
--    session it came from — which is also why dropping these tables costs no audit trail worth
--    keeping.
--
--    Narrowing the CHECK to drop the two kinds would be validated against the existing rows and
--    would fail on exactly the databases that have any. Migration 030 already took production down
--    doing that, and migration 032 declined to repeat it for the piggy bank. Same answer here.
--
-- 2. side_bet_markets.kind still offers 'slither', and the contribution tables still offer a
--    'slither_arena' source, for the same reason and with the same failure mode. Settled and
--    voided markets on arena sessions keep their kind, and it has to stay legal for them to sit
--    in the table.
--
-- 3. side_bet_markets and side_bets survive entirely.
--
--    Every market they ever carried was an arena market, so in practice this feature is now inert:
--    nothing opens a market and nothing settles one. That is worth saying out loud rather than
--    discovering later. It is NOT dropped here, because the settled history is money history, and
--    because the 'duel' kind the schema already allows is where the feature goes if it comes back.

-- Kills reference sessions.
DROP TABLE slither_kills;
DROP TABLE slither_sessions;

-- Supersedes donut_schema_ready_v32. The readiness probe names the exact schema the running API
-- expects, so a gateway still serving the arena routes cannot take traffic against a database that
-- no longer has the tables under them.
CREATE FUNCTION donut_schema_ready_v33() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v33() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v33() TO donut_api_runtime;

COMMIT;
