BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- A player may choose their own invite code.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Codes have been random eight-character draws since 016. A referral link gets pasted into public
-- chat, so a code somebody picked and can say out loud is worth more than one they have to copy
-- exactly — and a code nobody can read back from a screenshot is a link that does not get shared.
--
-- ── WHY THIS NEEDED A MIGRATION AT ALL ──
--
-- `referral_codes` was deliberately denied UPDATE in 016, with the note that "a code is issued once
-- and an earning is recorded once". The earning half of that is still right and is untouched. The
-- code half was protecting something real: `referrals.code` is a FOREIGN KEY to `referral_codes
-- (code)`, so changing a code with the default NO ACTION rule is refused outright while any
-- referral references it, and forcing it through would strand the relationship rows that record who
-- invited whom.
--
-- The fix is not to drop the constraint. It is to say what should happen: the referral is to the
-- PERSON, not to the string they were holding at the time, so a renamed code carries its history
-- with it. ON UPDATE CASCADE states exactly that and lets the database enforce it, rather than
-- leaving it to application code to remember to rewrite both tables in the right order.
--
-- ON DELETE stays NO ACTION. A code that has referred somebody must not be deletable, because that
-- would erase the relationship rather than rename it, and nothing in the API offers to delete one.
ALTER TABLE referrals DROP CONSTRAINT referrals_code_fkey;
ALTER TABLE referrals
  ADD CONSTRAINT referrals_code_fkey
    FOREIGN KEY (code) REFERENCES referral_codes(code) ON UPDATE CASCADE;

-- Only the code column, and only UPDATE. The runtime role still cannot delete a code row, and
-- still cannot move one to a different user_id: user_id is the primary key and is not granted here,
-- so a code cannot be transferred between accounts by any statement the API is able to issue.
GRANT UPDATE (code) ON TABLE referral_codes TO donut_api_runtime;

-- The uniqueness that makes a code an identity is already there: `code` is UNIQUE, and the CHECK
-- pins the alphabet to ^[A-Z0-9]{6,16}$. A rename races against another rename the same way an
-- insert races against an insert, and the unique index is what decides it — the API turns the
-- resulting violation into a 409 rather than holding a lock across a round trip to the player.

-- Supersedes donut_schema_ready_v33. The readiness probe names the exact schema the running API
-- expects, so a gateway that can rename a code cannot take traffic against a database whose
-- foreign key would refuse the cascade.
CREATE FUNCTION donut_schema_ready_v34() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v34() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v34() TO donut_api_runtime;

COMMIT;
