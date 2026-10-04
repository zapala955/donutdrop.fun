BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Anti-drain: payout holds, and the case-battle seat fixes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every change below is additive. Nothing is dropped, narrowed or rewritten, and no existing row is
-- touched: new columns are nullable, and the one new constraint is satisfied by every existing row
-- because they all start with both of its columns NULL.

-- ── payout holds ───────────────────────────────────────────────────────────
-- A player with a hold can still play and still ask for a withdrawal; the withdrawal just waits in
-- the operator queue (status pending_approval) instead of being sent to the bot. `by` is NULL when
-- the system placed the hold, which is what the anti-drain monitor does.
ALTER TABLE users
  ADD COLUMN payout_hold_reason varchar(300),
  ADD COLUMN payout_hold_at timestamptz,
  ADD COLUMN payout_hold_by uuid REFERENCES users(id),
  ADD CONSTRAINT users_payout_hold_is_complete
    CHECK ((payout_hold_reason IS NULL) = (payout_hold_at IS NULL));

CREATE INDEX users_payout_hold_idx ON users (payout_hold_at DESC)
  WHERE payout_hold_reason IS NOT NULL;

-- Why a withdrawal is waiting for a human, in words: "net cash-out 340M is over the 100M allowance".
-- Written when the request is routed to review and again when an operator pulls it back from the
-- queue, so the queue can show the reason next to the amount.
ALTER TABLE cash_withdrawals ADD COLUMN review_reason varchar(300);

-- ── case battles ───────────────────────────────────────────────────────────
-- Leaving a lobby and cancelling one both DELETE the seat. The runtime role was never granted
-- DELETE on this table (migration 015 granted SELECT, INSERT and UPDATE), so in production both
-- failed with "permission denied" and a stake taken into a lobby could not be handed back by the
-- player. Seats are lobby furniture, not a record: the settled result lives in battle_results and
-- the ledger.
GRANT DELETE ON TABLE battle_players TO donut_api_runtime;

-- A seat's stake is debited under a reference and refunded under one derived from it. The
-- reference used to be derived from the battle and the SEAT NUMBER, so a seat that was left and
-- taken again collided with its own earlier ledger row (the ledger is unique on kind and
-- reference), and every later join into that seat failed. Anybody could break a lobby that way by
-- joining and leaving it. The reference is now minted per occupancy and stored here. Seats taken
-- before this migration have NULL and keep the old derivation.
ALTER TABLE battle_players ADD COLUMN stake_ref uuid;

-- Supersedes donut_schema_ready_v57.
CREATE FUNCTION donut_schema_ready_v58() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v58() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v58() TO donut_api_runtime;

COMMIT;
