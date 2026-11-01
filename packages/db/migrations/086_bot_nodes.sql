BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- A pool of equal nodes, beside the teller and the vault
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A node is a teller and a vault at once: players pay it, it pays players, and it holds an equal
-- share of the float with the other nodes. With a teller and one vault, one lost account was
-- nearly the whole float; with five nodes it is a fifth. Routing lives in lib/bot-nodes.ts:
-- deposits go to the emptiest node, withdrawals come from the fullest, and a node pays another
-- node only when the pool is heavily skewed.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- NOTHING CHANGES UNTIL A BOT IS MADE A NODE
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Widening the CHECK cannot fail against existing rows, and every existing bot keeps its role.
-- The bots themselves need nothing new: a node-to-node transfer is a `vault_sweep` job and a node
-- topping up another for a withdrawal is a `vault_release`, both of which every bot already runs.
ALTER TABLE bot_accounts DROP CONSTRAINT bot_accounts_role_check;
ALTER TABLE bot_accounts
  ADD CONSTRAINT bot_accounts_role_check CHECK (role IN ('teller', 'vault', 'node'));

-- Supersedes donut_schema_ready_v85.
CREATE FUNCTION donut_schema_ready_v86() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v86() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v86() TO donut_api_runtime;

COMMIT;
