BEGIN;

-- The admin console gains two powers: paying a player in game directly, and telling a bot to
-- reconnect. Both are operator-initiated, so both are recorded as their own thing rather than
-- being squeezed into a player-initiated flow that happens to look similar.
--
-- `admin_payouts` is deliberately NOT `cash_withdrawals`.
--
-- A cash withdrawal is a player spending their own balance: the wallet is debited when the request
-- is accepted, and the refund path exists to give that debit back when the payout provably did not
-- happen. An admin payout moves none of the player's money. It is the house sending in-game
-- currency out of the bot's own balance — a comp, a refund made good, an apology — and there is
-- nothing to debit and nothing to refund. Writing one as the other would either take money from
-- the player being compensated or leave a refund path pointing at a debit that never existed.
CREATE TABLE admin_payouts (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  -- Who ordered it. Not nullable: an unattributed payment out of the house balance is exactly the
  -- thing this table exists to make impossible.
  actor_user_id uuid NOT NULL REFERENCES users(id),
  -- Captured as text at request time, for the same reason cash_withdrawals does it: a rename
  -- between queueing and sending would otherwise pay whoever holds the name when the bot gets to
  -- it. The account link is kept alongside when there is one, but a payee need not have an account
  -- at all — paying a player who has never logged into the site is a legitimate operator action.
  payee_username varchar(16) NOT NULL,
  payee_user_id uuid REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status varchar(24) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'paid', 'failed', 'manual_review')),
  -- Required, and long enough to be a sentence. This is the audit trail a payment out of the house
  -- balance is explained by six months later.
  reason varchar(256) NOT NULL,
  -- Honoured, not merely demanded. The route requires an Idempotency-Key header and this is where
  -- it lands, so a retried request — a double-click, a dropped response, a proxy replay — collides
  -- here and is answered with the payout it already made instead of making a second one. Scoped to
  -- the operator because two admins have no reason to share a key space.
  idempotency_key varchar(128) NOT NULL,
  error_code varchar(64),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
CREATE INDEX admin_payouts_recent_idx ON admin_payouts (created_at DESC);
-- One live payout per payee. Two operators compensating the same player at the same moment is a
-- double payment, and the loser's transaction should roll back rather than both landing.
CREATE UNIQUE INDEX admin_payouts_one_live_idx
  ON admin_payouts (lower(payee_username))
  WHERE status IN ('queued', 'processing');

REVOKE ALL ON TABLE admin_payouts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE admin_payouts TO donut_api_runtime;

-- Two more things a bot can be told to do.
--
-- `admin_payout` is the same physical act as `cash_payout` — one /pay command, one receipt to
-- confirm — and the worker handles them with the same code. They stay separate kinds because what
-- the GATEWAY does on completion differs completely: a cash payout settles a withdrawal and may
-- refund a wallet, an admin payout settles neither and must never touch one.
--
-- `reconnect` carries no payload and moves no money. The bot already reconnects on its own ten
-- seconds after any disconnect; this exists for the case where it is nominally connected but not
-- behaving, and waiting for it to notice is slower than telling it.
ALTER TABLE bot_jobs DROP CONSTRAINT bot_jobs_kind_check;
ALTER TABLE bot_jobs
  ADD CONSTRAINT bot_jobs_kind_check
    CHECK (kind IN ('withdrawal', 'inventory_resync', 'cash_payout', 'admin_payout', 'reconnect'));

-- Supersedes donut_schema_ready_v28. The readiness probe names the exact schema the running API
-- expects, so traffic cannot reach the admin console before admin_payouts and the two new job
-- kinds exist.
CREATE FUNCTION donut_schema_ready_v29() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v29() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v29() TO donut_api_runtime;

COMMIT;
