BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- An invite code binds when the account is created, or not at all.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Until now a code was redeemed through POST /v1/referrals/attach, which any logged-in account
-- without a referrer could call. That included accounts that had been playing for months: paste a
-- friend's code, and a player the site had already acquired and paid nothing for became a referral
-- somebody could earn a bonus on.
--
-- The rule wanted is "only somebody who has not signed up yet can use a code". The honest way to
-- enforce that is not to add a check to the attach endpoint asking how new an account feels — any
-- such rule is a threshold argument, and every threshold has an edge somebody sits on. It is to
-- move the redemption to the one moment the question has an unambiguous answer: the transaction
-- that creates the account.
--
-- So the code rides on the login challenge, and the completion path attaches it only when the user
-- row was INSERTed rather than updated. `/v1/referrals/attach` is deleted in the same commit. After
-- this there is no statement in the API that can attach a referrer to an account that already
-- existed — not a guarded one, none.
--
-- Nullable, because almost every login carries no code and a login is not a referral.
ALTER TABLE auth_link_challenges
  ADD COLUMN referral_code varchar(16)
    CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z0-9]{6,16}$');

-- Deliberately NOT a foreign key to referral_codes.
--
-- A challenge records what the browser asked for, and that is worth keeping even when the answer
-- turns out to be no. A key here would refuse the whole login — with the player's payment already
-- made — because they mistyped an invite code, which is a spectacular failure for a field the
-- signup form calls optional. The completion path looks the code up and ignores it if it resolves
-- to nothing.

-- Supersedes donut_schema_ready_v34. The readiness probe names the exact schema the running API
-- expects, so a gateway that writes a referral code onto a challenge cannot take traffic against a
-- database with no column to put it in.
CREATE FUNCTION donut_schema_ready_v35() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v35() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v35() TO donut_api_runtime;

COMMIT;
