BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The community Discord bot
-- ═══════════════════════════════════════════════════════════════════════════
--
-- State for the bot that runs the PUBLIC server: tickets, moderation history, giveaways,
-- suggestions, self-serve roles and per-guild settings.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- THIS IS NOT THE CONTROL PLANE
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- services/discord-bot is the operator bot: private guild, ephemeral replies, mints admin
-- dashboard links. Nothing here grants any of that. These tables describe a Discord server's own
-- housekeeping, and the one place the two worlds touch is `users.discord_user_id`, which is set
-- by the site's own OAuth callback and read here for nothing but a profile lookup.
--
-- Everything is keyed by guild_id as well as by its own id. A bot invited to a second server must
-- not be able to see, close or moderate the first one's rows.

-- ── per-guild configuration ────────────────────────────────────────────────
-- One row per server, created on demand. Every column is nullable because a feature that has not
-- been set up yet is off, not broken: the bot checks for the channel or role and declines with an
-- explanation rather than throwing.
CREATE TABLE discord_guild_settings (
  guild_id varchar(32) PRIMARY KEY CHECK (guild_id ~ '^[0-9]{5,32}$'),
  ticket_category_id varchar(32),
  ticket_log_channel_id varchar(32),
  ticket_staff_role_id varchar(32),
  modlog_channel_id varchar(32),
  welcome_channel_id varchar(32),
  welcome_message varchar(1024),
  goodbye_channel_id varchar(32),
  autorole_id varchar(32),
  suggestion_channel_id varchar(32),
  -- Automod. Off by default: a bot that starts deleting messages the moment it joins is a bot
  -- that gets removed the same day.
  automod_invites boolean NOT NULL DEFAULT false,
  automod_links boolean NOT NULL DEFAULT false,
  automod_spam boolean NOT NULL DEFAULT false,
  automod_caps boolean NOT NULL DEFAULT false,
  automod_exempt_role_id varchar(32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── tickets ────────────────────────────────────────────────────────────────
-- The channel is the conversation; this row is the record of it. Kept after the channel is
-- deleted, which is the entire reason it exists: "what did we tell that player in March" is not a
-- question Discord can answer once somebody tidies up.
CREATE TABLE discord_tickets (
  id uuid PRIMARY KEY,
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  channel_id varchar(32) NOT NULL,
  -- Sequential per guild, so a ticket has a human name -- "#0042" -- rather than a uuid nobody
  -- can read out loud.
  number integer NOT NULL CHECK (number > 0),
  category varchar(16) NOT NULL CHECK (category IN ('support', 'media')),
  opener_id varchar(32) NOT NULL,
  opener_tag varchar(64),
  subject varchar(256),
  status varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'closed')),
  claimed_by varchar(32),
  claimed_at timestamptz,
  closed_by varchar(32),
  closed_at timestamptz,
  close_reason varchar(512),
  -- The conversation, rendered at close. Bounded by the writer, not by this column.
  transcript text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, number),
  -- A closed ticket names who closed it and when, or it is not closed.
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL))
);
CREATE UNIQUE INDEX discord_tickets_channel_idx ON discord_tickets (channel_id);
/* One open ticket per person per category. Without this a single frustrated member opens nine
 * support channels in a minute and the staff view becomes unusable -- and it is an index rather
 * than a check in the handler, because two clicks half a second apart both pass a handler check. */
CREATE UNIQUE INDEX discord_tickets_one_open_idx
  ON discord_tickets (guild_id, opener_id, category)
  WHERE status <> 'closed';
CREATE INDEX discord_tickets_guild_idx ON discord_tickets (guild_id, created_at DESC);

-- ── moderation history ─────────────────────────────────────────────────────
-- Append-only. A strike record that can be edited is not a record, and "how many warnings does
-- this person actually have" is the only question this table exists to answer.
CREATE TABLE discord_mod_actions (
  id uuid PRIMARY KEY,
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  target_id varchar(32) NOT NULL,
  target_tag varchar(64),
  moderator_id varchar(32) NOT NULL,
  action varchar(16) NOT NULL
    CHECK (action IN ('warn', 'timeout', 'kick', 'ban', 'unban', 'untimeout', 'purge')),
  reason varchar(512) NOT NULL,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  -- Set when a warning is withdrawn. The row stays; the count stops including it.
  revoked_at timestamptz,
  revoked_by varchar(32),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX discord_mod_actions_target_idx
  ON discord_mod_actions (guild_id, target_id, created_at DESC);
CREATE TRIGGER discord_mod_actions_append_only
  BEFORE DELETE ON discord_mod_actions FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ── giveaways ──────────────────────────────────────────────────────────────
CREATE TABLE discord_giveaways (
  id uuid PRIMARY KEY,
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  channel_id varchar(32) NOT NULL,
  message_id varchar(32),
  prize varchar(256) NOT NULL,
  winner_count smallint NOT NULL CHECK (winner_count BETWEEN 1 AND 20),
  host_id varchar(32) NOT NULL,
  ends_at timestamptz NOT NULL,
  ended_at timestamptz,
  -- Recorded so a reroll can exclude the people who already won.
  winner_ids text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discord_giveaways_due_idx ON discord_giveaways (ends_at) WHERE ended_at IS NULL;

CREATE TABLE discord_giveaway_entries (
  giveaway_id uuid NOT NULL REFERENCES discord_giveaways(id) ON DELETE CASCADE,
  user_id varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The primary key IS the "one entry per person" rule. A double-click cannot buy two tickets.
  PRIMARY KEY (giveaway_id, user_id)
);

-- ── suggestions ────────────────────────────────────────────────────────────
CREATE TABLE discord_suggestions (
  id uuid PRIMARY KEY,
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  channel_id varchar(32) NOT NULL,
  message_id varchar(32),
  number integer NOT NULL CHECK (number > 0),
  author_id varchar(32) NOT NULL,
  body varchar(2000) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'declined', 'duplicate')),
  staff_note varchar(512),
  decided_by varchar(32),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, number),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL))
);

CREATE TABLE discord_suggestion_votes (
  suggestion_id uuid NOT NULL REFERENCES discord_suggestions(id) ON DELETE CASCADE,
  user_id varchar(32) NOT NULL,
  -- Changing your mind updates this row rather than adding a second one.
  vote smallint NOT NULL CHECK (vote IN (-1, 1)),
  PRIMARY KEY (suggestion_id, user_id)
);

-- ── self-serve roles ───────────────────────────────────────────────────────
-- A posted menu of buttons. The message is the menu; these rows say what its buttons mean, so a
-- restart does not turn a role picker into a set of buttons that do nothing.
CREATE TABLE discord_role_menus (
  id uuid PRIMARY KEY,
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{5,32}$'),
  channel_id varchar(32) NOT NULL,
  message_id varchar(32),
  title varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discord_role_menu_options (
  menu_id uuid NOT NULL REFERENCES discord_role_menus(id) ON DELETE CASCADE,
  role_id varchar(32) NOT NULL,
  label varchar(64) NOT NULL,
  emoji varchar(64),
  position smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (menu_id, role_id)
);

-- ── linking a Discord account to a Donut Drop account ───────────────────────
/* There is no table here, and that is the point.
 *
 * The site has linked Discord accounts since migration 016, over OAuth: `users.discord_user_id`,
 * `discord_username` and `discord_verified_at` are written together by the callback in
 * services/api-gateway/src/routes/referrals.ts, guarded by a single-use state parameter and a
 * partial unique index that allows one site account per Discord account.
 *
 * A link CODE issued in chat would have been a second way into the same column, and a weaker one:
 * a string a member can be talked into pasting, versus a redirect only Discord can complete. Two
 * paths to one identity means the weaker path decides how strong the link is. The community bot
 * therefore reads `users.discord_user_id` and never writes it -- `/link` points at the existing
 * button on the site. */

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  discord_guild_settings, discord_tickets, discord_mod_actions, discord_giveaways,
  discord_giveaway_entries, discord_suggestions, discord_suggestion_votes,
  discord_role_menus, discord_role_menu_options
  TO donut_api_runtime;

-- Supersedes donut_schema_ready_v45.
CREATE FUNCTION donut_schema_ready_v46() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v46() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v46() TO donut_api_runtime;

COMMIT;
