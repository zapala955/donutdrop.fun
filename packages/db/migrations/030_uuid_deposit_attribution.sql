BEGIN;

-- Deposits are attributed by Mojang UUID for Java players, not by the name in the chat receipt.
--
-- The receipt DonutSMP writes is system chat and carries only a rendered name, so the account
-- behind it was resolved with `normalized_username`. Names are reassignable, and a player who
-- renames keeps the old name on their row until their next login — so their own deposits stopped
-- reaching them, landing as `unlinked` until somebody looked. The same window could credit a
-- recycled name's payment to the previous holder.
--
-- The bot now resolves the payer against its player list, which carries the UUID the account is
-- actually keyed on, and the gateway matches `minecraft_identity` first.
--
-- BEDROCK IS DELIBERATELY UNCHANGED. A Floodgate player's identity on this site is
-- `bedrock:<name>` precisely because the payment receipt cannot see their Floodgate UUID; storing
-- the one from the player list would give a single Bedrock player two identities and therefore two
-- accounts. See packages/../lib/minecraft-username.ts, which spells that rule out. Bedrock keeps
-- the weaker name guarantee it always had.
ALTER TABLE cash_payment_receipts
  -- The Java account UUID the bot saw in its player list, when it saw one. Null for a Bedrock
  -- payer, and null when the payer had already left the list by the time the receipt arrived.
  ADD COLUMN payer_uuid uuid,
  -- Which key actually found the account. Recorded rather than inferred: "credited by name" is a
  -- materially weaker claim than "credited by UUID", and an auditor reading this table six months
  -- from now should not have to guess which one happened.
  ADD COLUMN attributed_by varchar(16)
    CHECK (attributed_by IS NULL OR attributed_by IN ('uuid', 'username'));

-- A credited receipt has to say how it found its owner. Anything not credited may leave it null.
ALTER TABLE cash_payment_receipts
  ADD CONSTRAINT cash_payment_receipts_attribution_check
    CHECK (status <> 'credited' OR attributed_by IS NOT NULL);

-- Finding every payment a given Java account has ever made, without going through its name.
CREATE INDEX cash_payment_receipts_payer_uuid_idx
  ON cash_payment_receipts (payer_uuid, created_at DESC)
  WHERE payer_uuid IS NOT NULL;

-- Supersedes donut_schema_ready_v29. The readiness probe names the exact schema the running API
-- expects, so traffic cannot reach the deposit path before the two columns exist.
CREATE FUNCTION donut_schema_ready_v30() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v30() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v30() TO donut_api_runtime;

COMMIT;
