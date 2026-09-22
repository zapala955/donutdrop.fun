BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Two bots: a teller the players can see, and a vault they cannot
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The teller is the public face. It is the name on the deposit screen, the name a login nonce is
-- paid to, and the name a withdrawal arrives from. The vault holds the float and its username is
-- never rendered anywhere a player can reach.
--
-- Money moves teller -> vault on a sweep and vault -> teller -> player on a withdrawal. The point
-- is that the account holding the balance is never named to anybody, so it is never a target.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- EVERY DEPLOYMENT STARTS AS TELLER-ONLY, AND THAT IS A WORKING STATE
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `role` defaults to 'teller', so applying this to a live single-bot platform changes nothing:
-- there is no vault, no sweep is queued, and withdrawals are paid directly exactly as before. The
-- second account is opt-in, and the API checks for one rather than assuming it.
ALTER TABLE bot_accounts ADD COLUMN role varchar(8) NOT NULL DEFAULT 'teller'
  CHECK (role IN ('teller', 'vault'));

/* What the platform believes this bot is holding.
 *
 * DELIBERATELY NOT CHECKED >= 0. This is a tracked figure, not an authority: it is maintained
 * from the payment receipts and payout confirmations the bots report, and the real in-game
 * balance can move without us -- an operator paying the bot by hand, a receipt lost while the bot
 * was disconnected. A CHECK here would turn that ordinary drift into a constraint violation
 * inside the settlement of a real payout, which is the one place it must not appear. The admin
 * console shows the tracked figure and lets it be corrected; it never blocks a transfer. */
ALTER TABLE bot_accounts ADD COLUMN tracked_balance_minor bigint NOT NULL DEFAULT 0;

-- Every movement of money into or out of a bot, append-only, with the balance it produced. This
-- is the bot tab's transaction log and the source of tracked_balance_minor at once: the same
-- relationship wallet_transactions has with user_wallets.
CREATE TABLE bot_transfers (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bot_accounts(id),
  direction varchar(3) NOT NULL CHECK (direction IN ('in', 'out')),
  -- The other side, as an in-game name. Free text rather than a foreign key because the other
  -- side is usually a player and players are not rows in bot_accounts.
  counterparty varchar(16) NOT NULL,
  -- Set only when the other side is one of ours, which is what makes a bot-to-bot leg findable.
  counterparty_bot_id uuid REFERENCES bot_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  balance_after_minor bigint NOT NULL,
  reason varchar(16) NOT NULL CHECK (reason IN (
    'deposit', 'login', 'sweep', 'release', 'withdrawal', 'admin_payout', 'adjustment'
  )),
  -- What this leg belongs to: a withdrawal id, a sweep job id, a payment receipt's event id.
  reference_id uuid,
  user_id uuid REFERENCES users(id),
  note varchar(256),
  actor_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bot_transfers_bot_idx ON bot_transfers (bot_id, created_at DESC);
CREATE INDEX bot_transfers_reference_idx ON bot_transfers (reference_id)
  WHERE reference_id IS NOT NULL;

/* One row per leg. A bot reporting the same receipt twice, or a job result replayed after a
 * reconnect, must not book the money twice.
 *
 * Partial, because an adjustment typed by an administrator has no reference to be unique on and
 * a NULL would not collide anyway -- stating the condition is clearer than relying on that. */
CREATE UNIQUE INDEX bot_transfers_leg_idx
  ON bot_transfers (bot_id, direction, reason, reference_id)
  WHERE reference_id IS NOT NULL;

CREATE TRIGGER bot_transfers_append_only
  BEFORE UPDATE OR DELETE ON bot_transfers FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- The two new job kinds. Widening a CHECK cannot fail against existing rows, unlike narrowing
-- one, so this needs no reconciliation pass.
ALTER TABLE bot_jobs DROP CONSTRAINT bot_jobs_kind_check;
ALTER TABLE bot_jobs
  ADD CONSTRAINT bot_jobs_kind_check
    CHECK (kind IN (
      'withdrawal', 'inventory_resync', 'cash_payout', 'admin_payout', 'reconnect',
      -- teller -> vault, sweeping everything above the configured float.
      'vault_sweep',
      -- vault -> teller, funding a withdrawal the teller's float cannot cover on its own.
      'vault_release'
    ));

/* Which pocket a withdrawal is being paid out of, and when the vault leg landed.
 *
 * 'float' is the one-hop case: the teller already holds enough, so it pays the player directly
 * and the vault is not involved. 'vault' is the two-hop case, and `vault_released_at` is the
 * moment the first hop confirmed -- the second is queued a few seconds after it, so the two
 * transfers are not adjacent in the server's own chat log. */
ALTER TABLE cash_withdrawals ADD COLUMN funding varchar(8) NOT NULL DEFAULT 'float'
  CHECK (funding IN ('float', 'vault'));
ALTER TABLE cash_withdrawals ADD COLUMN vault_released_at timestamptz;

/* A withdrawal waiting on the vault leg. Widening, so no existing row can violate it.
 *
 * There is no timeout on this state by design. The vault_release job sits in bot_jobs until the
 * vault bot reconnects and claims it, which is what a job queue is for -- a withdrawal held for
 * an hour because the vault was down is a delay, and refunding it automatically would be a
 * second movement of somebody's money that nobody asked for. */
ALTER TABLE cash_withdrawals DROP CONSTRAINT cash_withdrawals_status_check;
ALTER TABLE cash_withdrawals
  ADD CONSTRAINT cash_withdrawals_status_check
    CHECK (status IN (
      'pending_approval', 'queued', 'awaiting_vault', 'processing', 'paid',
      'rejected', 'failed', 'manual_review'
    ));

/* A sweep, seen from the receiving bot's side.
 *
 * The vault sees the teller's sweep arrive as an ordinary incoming payment, and without a name
 * for it the gateway would fall through to its account lookup. A bot's in-game name is a real
 * Minecraft name, so if anybody ever signed into the site with the account the vault runs on,
 * that lookup would match and the platform's own float would be credited to them as a deposit.
 *
 * Widening the CHECK, so no existing row can violate it. */
ALTER TABLE cash_payment_receipts DROP CONSTRAINT cash_payment_receipts_status_check;
ALTER TABLE cash_payment_receipts
  ADD CONSTRAINT cash_payment_receipts_status_check
    CHECK (status IN (
      'credited', 'login_payment', 'unlinked', 'manual_review', 'internal_transfer'
    ));

GRANT SELECT, INSERT ON TABLE bot_transfers TO donut_api_runtime;
-- UPDATE on bot_accounts is already granted; the two new columns ride on it.

-- Supersedes donut_schema_ready_v42 (043 added no marker, deliberately). An API build that routes money through a teller and a vault
-- must not take traffic against a database with no role column to route on.
CREATE FUNCTION donut_schema_ready_v44() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v44() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v44() TO donut_api_runtime;

COMMIT;
