BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Invite tracking for the community bot
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Discord will not tell you which invite somebody used. There is no field on the join event and
-- no endpoint that answers the question. The only way to know is to hold a count of every
-- invite's uses, and when a member joins, fetch them all again and find the one that went up.
--
-- That method has two consequences this schema exists to handle:
--
--   1. THE COUNTS MUST SURVIVE A RESTART. Kept only in memory, the first person to join after
--      every deploy is unattributable -- there is nothing to compare against. So the snapshot
--      lives in a table.
--
--   2. IT CAN GENUINELY FAIL. Two people joining in the same instant, an invite deleted between
--      the join and the fetch, a member added by a bot, or the server's vanity URL all produce a
--      join with no single counter that moved. That is recorded as `unknown` rather than guessed
--      at: an invite leaderboard that quietly credits the wrong person is worse than one that
--      admits it does not know.

-- ── the counter snapshot ───────────────────────────────────────────────────
-- One row per live invite, holding the use count as of the last time the bot looked. Rewritten on
-- every join; rows are removed when Discord says the invite is gone.
CREATE TABLE discord_invite_snapshots (
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  code varchar(32) NOT NULL,
  inviter_id varchar(32),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, code)
);

-- ── who brought whom ───────────────────────────────────────────────────────
/* One row per member, not one per join.
 *
 * A row per join would make leaving and rejoining the cheapest way to farm an invite count, and
 * that is the whole abuse this feature attracts -- the reward for "most invites" is what people
 * are competing for. Keeping the FIRST attribution and counting rejoins separately means a
 * leaderboard can show real arrivals, and anybody looking can see the churn.
 *
 * `left_at` is set rather than the row deleted, so "invited 40, 31 still here" is answerable. */
CREATE TABLE discord_invited_members (
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  member_id varchar(32) NOT NULL,
  -- Null together with inviter_id whenever source is not 'invite'.
  code varchar(32),
  inviter_id varchar(32),
  source varchar(12) NOT NULL CHECK (source IN ('invite', 'vanity', 'bot', 'unknown')),
  first_joined_at timestamptz NOT NULL DEFAULT now(),
  last_joined_at timestamptz NOT NULL DEFAULT now(),
  join_count integer NOT NULL DEFAULT 1 CHECK (join_count > 0),
  left_at timestamptz,
  PRIMARY KEY (guild_id, member_id),
  -- An attributed join names both the invite and who made it, or neither.
  CHECK ((source = 'invite') = (num_nonnulls(code, inviter_id) = 2))
);

-- The leaderboard query and `/invites` both read by inviter, and only attributed rows count.
CREATE INDEX discord_invited_members_inviter_idx
  ON discord_invited_members (guild_id, inviter_id)
  WHERE inviter_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  discord_invite_snapshots, discord_invited_members
  TO donut_api_runtime;

-- Supersedes donut_schema_ready_v46.
CREATE FUNCTION donut_schema_ready_v47() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v47() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v47() TO donut_api_runtime;

COMMIT;
