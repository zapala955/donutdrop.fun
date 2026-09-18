BEGIN;

-- The public deposit flow no longer creates a challenge. Each structurally verified DonutSMP
-- system-chat receipt is attributed to the uniquely linked Minecraft username exactly once.
CREATE TABLE cash_payment_receipts (
  event_id uuid PRIMARY KEY REFERENCES inbound_bot_events(event_id),
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  payer_username varchar(16) NOT NULL,
  displayed_amount varchar(32) NOT NULL,
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  user_id uuid REFERENCES users(id),
  status varchar(24) NOT NULL
    CHECK (status IN ('credited', 'login_payment', 'unlinked', 'manual_review')),
  wallet_balance_after_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'credited') = (user_id IS NOT NULL AND wallet_balance_after_minor IS NOT NULL)),
  CHECK (status NOT IN ('credited', 'login_payment') OR amount_minor IS NOT NULL)
);

CREATE INDEX cash_payment_receipts_user_idx
  ON cash_payment_receipts (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX cash_payment_receipts_review_idx
  ON cash_payment_receipts (created_at)
  WHERE status IN ('unlinked', 'manual_review');

-- No legacy challenge may remain live after the passive receipt flow launches. A receipt already
-- seen may represent money and therefore goes to review; a never-seen instruction simply expires.
UPDATE cash_deposit_challenges
   SET status = 'expired', updated_at = now()
 WHERE status = 'pending';
UPDATE cash_deposit_challenges
   SET status = 'manual_review', updated_at = now()
 WHERE status = 'observed';

-- Payment login now trusts the same strictly parsed DonutSMP system-chat receipt. The old balance
-- checkpoint is retained as a nullable legacy column so already-issued challenges remain valid.
ALTER TABLE auth_link_challenges DROP CONSTRAINT auth_link_challenges_method_fields_check;
ALTER TABLE auth_link_challenges
  ADD CONSTRAINT auth_link_challenges_method_fields_check CHECK (
    (method = 'chat_code' AND pay_amount IS NULL AND bot_balance_before IS NULL)
    OR (method = 'payment' AND pay_amount IS NOT NULL)
  );

REVOKE ALL ON TABLE cash_payment_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE cash_payment_receipts TO donut_api_runtime;

-- Supersedes donut_schema_ready_v26.
CREATE FUNCTION donut_schema_ready_v27() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v27() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v27() TO donut_api_runtime;

COMMIT;
