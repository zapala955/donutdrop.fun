BEGIN;

-- The owner, 2026-11-17: "i want it to be the stats bot and players do /stats (player) in the
-- community bot and it shows a players stats in the donutsmp ... make sure it gets the stats by
-- running /stats on donutsmp and make sure it has no proxy".
--
-- A stats bot is a Minecraft account that holds no money and takes no money work: it runs DonutSMP's
-- own /stats for whoever a Discord member asks about and reports what the server showed. It is a role
-- of its own so that nothing that picks a bot for money (deposits, logins, payouts, sweeps) can ever
-- pick it: every one of those asks for 'teller', 'vault' or 'node' by name.
ALTER TABLE bot_accounts DROP CONSTRAINT bot_accounts_role_check;
ALTER TABLE bot_accounts
  ADD CONSTRAINT bot_accounts_role_check CHECK (role IN ('teller', 'vault', 'node', 'stats'));

-- One lookup per /stats a member runs: queued by the community bot's request, claimed by the stats
-- bot, finished with what /stats showed. A lookup for the same player inside a few minutes is served
-- from the last one, so a popular name costs the server one /stats, not one per member.
CREATE TABLE player_stats_lookups (
  id uuid PRIMARY KEY,
  -- As the member typed it, and lowercased to match on: a Java name, or a Bedrock one with its '.'.
  player varchar(16) NOT NULL CHECK (player ~ '^([A-Za-z0-9_]{3,16}|\.[A-Za-z0-9_]{2,15})$'),
  normalized_player varchar(16) NOT NULL CHECK (normalized_player = lower(player)),
  status varchar(12) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'found', 'not_found', 'failed')),
  requested_by_discord_id varchar(32) NOT NULL CHECK (requested_by_discord_id ~ '^[0-9]{5,25}$'),
  bot_id uuid REFERENCES bot_accounts(id),
  -- The figures, as the server wrote them and as numbers (lib/player-stats.ts statsSchema).
  stats jsonb,
  -- The player's name as the server spelled it, and their skin, when /stats showed them.
  shown_name varchar(16),
  skin_url varchar(200),
  -- What the server sent back, trimmed: how the reader is checked against the real menu.
  raw jsonb,
  error_code varchar(64),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  CHECK ((status IN ('found', 'not_found', 'failed')) = (finished_at IS NOT NULL)),
  CHECK (status <> 'found' OR stats IS NOT NULL)
);

CREATE INDEX player_stats_lookups_queue_idx ON player_stats_lookups (created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX player_stats_lookups_player_idx ON player_stats_lookups (normalized_player, finished_at DESC);
CREATE INDEX player_stats_lookups_requester_idx ON player_stats_lookups (requested_by_discord_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON TABLE player_stats_lookups TO donut_api_runtime;

-- Supersedes donut_schema_ready_v101.
CREATE FUNCTION donut_schema_ready_v102() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v102() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v102() TO donut_api_runtime;

COMMIT;
