BEGIN;

-- Login by payment. The player proves control of a DonutSMP account by paying the bot an exact
-- amount that the site chose, instead of typing a code in chat.
--
-- The amount is the one-time secret, so it must survive DonutSMP's chat rendering intact.
-- Payment messages abbreviate at a thousand ("1234" renders as "1.2K"), which is lossy and
-- unusable as a nonce, so pay_amount is constrained to the range that renders exactly.
ALTER TABLE auth_link_challenges
  ADD COLUMN method varchar(16) NOT NULL DEFAULT 'chat_code'
    CHECK (method IN ('chat_code', 'payment')),
  ADD COLUMN pay_amount integer
    CHECK (pay_amount IS NULL OR pay_amount BETWEEN 1 AND 999),
  -- The bot's exact balance when the challenge was issued, read from the DonutSMP API. The
  -- payment message is unsigned system chat and can be imitated; a real balance increase is what
  -- separates a payment that happened from one that was merely described.
  ADD COLUMN bot_balance_before bigint
    CHECK (bot_balance_before IS NULL OR bot_balance_before >= 0),
  ADD COLUMN observed_payment_at timestamptz;

ALTER TABLE auth_link_challenges
  ADD CONSTRAINT auth_link_challenges_method_fields_check CHECK (
    (method = 'chat_code' AND pay_amount IS NULL AND bot_balance_before IS NULL)
    OR (method = 'payment' AND pay_amount IS NOT NULL AND bot_balance_before IS NOT NULL)
  );

-- Two live challenges sharing an amount would make an incoming payment ambiguous, and crediting
-- the wrong account is exactly the failure this design must not have. Expired rows still occupy
-- their amount until the issuing route clears them, which keeps the guarantee independent of
-- clock skew rather than depending on a non-immutable now() in an index predicate.
CREATE UNIQUE INDEX auth_link_challenges_active_pay_amount_idx
  ON auth_link_challenges (pay_amount)
  WHERE method = 'payment' AND completed_at IS NULL AND confirmed_at IS NULL;

CREATE INDEX auth_link_challenges_pay_lookup_idx
  ON auth_link_challenges (normalized_username, pay_amount)
  WHERE method = 'payment' AND completed_at IS NULL;

-- Supersedes donut_schema_ready_v8. The readiness probe names the exact schema the running API
-- expects, so an API deployed against an older schema fails its readiness check instead of
-- serving requests against columns that are not there.
CREATE FUNCTION donut_schema_ready_v9() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v9() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v9() TO donut_api_runtime;

COMMIT;
