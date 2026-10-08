BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- A proxy per bot, set from the admin console
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Each bot can be told to reach DonutSMP through its own SOCKS5 or HTTP proxy instead of straight
-- from the VPS. The bot asks the gateway for its route before every login, so a change takes
-- effect on the bot's next connection; the console queues a reconnect to make that immediate.
--
-- The password is stored encrypted with DATA_ENCRYPTION_KEY, bound to the bot's id, and is never
-- returned to the console: the only reader is the bot it belongs to.
--
-- `proxy_revision` changes on every save. The bot reports the revision it actually connected
-- with on its heartbeat (`connected_proxy_revision`), which is how the console tells "assigned"
-- apart from "in use" without comparing hostnames assembled in two places.
--
-- Every column is nullable and starts NULL, so adding them and their CHECKs cannot fail against
-- existing rows: a NULL proxy is a bot that connects directly, which is what every bot does today.

ALTER TABLE bot_accounts
  ADD COLUMN proxy_type varchar(8) CHECK (proxy_type IN ('socks5', 'http')),
  ADD COLUMN proxy_host varchar(253),
  ADD COLUMN proxy_port integer CHECK (proxy_port BETWEEN 1 AND 65535),
  ADD COLUMN proxy_username varchar(255),
  ADD COLUMN proxy_password_encrypted text,
  ADD COLUMN proxy_revision uuid,
  ADD COLUMN proxy_updated_at timestamptz,
  ADD COLUMN connected_proxy_revision uuid,
  -- All of a proxy or none of it: a host without a port is not somewhere a bot can connect.
  ADD CONSTRAINT bot_accounts_proxy_complete CHECK (
    (proxy_type IS NULL AND proxy_host IS NULL AND proxy_port IS NULL
      AND proxy_username IS NULL AND proxy_password_encrypted IS NULL AND proxy_revision IS NULL)
    OR (proxy_type IS NOT NULL AND proxy_host IS NOT NULL AND proxy_port IS NOT NULL
      AND proxy_revision IS NOT NULL)
  ),
  -- SOCKS5 and HTTP proxy authentication both send a password only alongside a username.
  ADD CONSTRAINT bot_accounts_proxy_password_needs_username CHECK (
    proxy_password_encrypted IS NULL OR proxy_username IS NOT NULL
  );

-- One proxy, one bot. Providers commonly hand out one gateway host and port and tell sessions
-- apart by username, so the username is part of what makes a proxy distinct.
CREATE UNIQUE INDEX bot_accounts_one_bot_per_proxy
  ON bot_accounts (lower(proxy_host), proxy_port, coalesce(proxy_username, ''))
  WHERE proxy_host IS NOT NULL;

-- SELECT and UPDATE on bot_accounts are already granted to the runtime role; the new columns ride
-- on them.

-- Supersedes donut_schema_ready_v59.
CREATE FUNCTION donut_schema_ready_v60() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v60() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v60() TO donut_api_runtime;

COMMIT;
