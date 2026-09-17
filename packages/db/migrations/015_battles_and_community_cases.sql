BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Case Battles and Community Cases
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two features, one migration, because they share an economic rule: neither one adds a rake.
--
-- A battle's prize pot is the sum of what the crates ACTUALLY DROPPED, not the sum of what the
-- players staked. Every crate on the platform already returns 90% in expectation, so a battle
-- returns 90% of everything wagered into it to exactly one winner, and the house keeps the same
-- 10% it would have kept had the players opened those crates alone. Taking a cut of the pot on
-- top would be charging the edge twice, and the second charge would be invisible to a player
-- reading the crate's published odds.
--
-- A community case is priced at EV / 0.90 by the same rule. The creator's royalty is carved OUT
-- of the house's 10%, never added to the price, so a player opening a community crate faces
-- exactly the same 90% return as a first-party one. The platform nets 10% minus the royalty.

-- ───────────────────────────────────────────────────────────────────────────
-- Community cases
-- ───────────────────────────────────────────────────────────────────────────
-- Community crates are ordinary rows in `cases`. They roll through the same engine, the same
-- provably-fair seed and the same weight table as first-party crates — a separate table would
-- have meant a second roll implementation, and a second roll implementation is a second chance
-- to get the odds wrong.
ALTER TABLE cases ADD COLUMN creator_user_id uuid REFERENCES users(id);

-- Basis points of the crate price paid to the creator on every open. Bounded well below the
-- house's own 1000 bps: the royalty comes out of that margin, so a royalty at or above it would
-- mean the platform pays to host someone else's crate.
ALTER TABLE cases ADD COLUMN royalty_bps integer NOT NULL DEFAULT 0
  CHECK (royalty_bps >= 0 AND royalty_bps <= 200);

-- draft: only the creator can see it. published: listed in the marketplace. retired: hidden from
-- the marketplace but still openable from a direct link and still rollable inside an old battle.
ALTER TABLE cases ADD COLUMN community_status varchar(16) NOT NULL DEFAULT 'first_party'
  CHECK (community_status IN ('first_party', 'draft', 'published', 'retired'));

-- Denormalised counters. Recomputing "most opened" from case_rounds on every marketplace load
-- would scan the whole round history; these are incremented in the same transaction as the open.
ALTER TABLE cases ADD COLUMN opens_count bigint NOT NULL DEFAULT 0 CHECK (opens_count >= 0);
ALTER TABLE cases ADD COLUMN volume_minor bigint NOT NULL DEFAULT 0 CHECK (volume_minor >= 0);
ALTER TABLE cases ADD COLUMN royalties_paid_minor bigint NOT NULL DEFAULT 0
  CHECK (royalties_paid_minor >= 0);

-- A first-party crate has no creator; a community crate must have one.
ALTER TABLE cases ADD CONSTRAINT cases_creator_matches_status
  CHECK ((community_status = 'first_party') = (creator_user_id IS NULL));

-- Only a community crate may carry a royalty.
ALTER TABLE cases ADD CONSTRAINT cases_royalty_requires_creator
  CHECK (royalty_bps = 0 OR creator_user_id IS NOT NULL);

-- The marketplace's four sorts, each reading only published rows.
CREATE INDEX cases_community_opened_idx ON cases (opens_count DESC, id)
  WHERE community_status = 'published';
CREATE INDEX cases_community_volume_idx ON cases (volume_minor DESC, id)
  WHERE community_status = 'published';
CREATE INDEX cases_community_new_idx ON cases (created_at DESC, id)
  WHERE community_status = 'published';
CREATE INDEX cases_community_yield_idx ON cases (royalties_paid_minor DESC, id)
  WHERE community_status = 'published';
-- A creator's own studio listing, drafts included.
CREATE INDEX cases_creator_idx ON cases (creator_user_id, created_at DESC)
  WHERE creator_user_id IS NOT NULL;

-- Every royalty payment, one row each. Append-only, like every other ledger here: a creator's
-- earnings history is money and must reconcile against wallet_transactions forever.
CREATE TABLE creator_royalties (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases(id),
  creator_user_id uuid NOT NULL REFERENCES users(id),
  -- The player whose open generated it. Nullable so a royalty can survive account deletion.
  payer_user_id uuid REFERENCES users(id),
  -- What the crate cost, and the slice taken, both recorded so the rate is auditable after the
  -- fact even if the crate's royalty_bps is later changed.
  case_price_minor bigint NOT NULL CHECK (case_price_minor > 0),
  royalty_bps integer NOT NULL CHECK (royalty_bps > 0 AND royalty_bps <= 200),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  -- 'case_open' or 'battle'. Where the open happened, for the creator's own breakdown.
  source varchar(16) NOT NULL CHECK (source IN ('case_open', 'battle')),
  -- The case_rounds row that produced it. One royalty per round, however many times a request is
  -- replayed: this is what makes the payment idempotent under retry.
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_id)
);
CREATE INDEX creator_royalties_creator_idx
  ON creator_royalties (creator_user_id, created_at DESC);
CREATE INDEX creator_royalties_case_idx ON creator_royalties (case_id, created_at DESC);

CREATE TRIGGER creator_royalties_append_only
  BEFORE UPDATE OR DELETE ON creator_royalties FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ───────────────────────────────────────────────────────────────────────────
-- Case battles
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE battles (
  id uuid PRIMARY KEY,
  -- Short, URL-safe, and the thing a private invite link carries.
  code varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,12}$'),
  host_user_id uuid NOT NULL REFERENCES users(id),

  -- 1v1, 1v1v1, 1v1v1v1 and 2v2 are all expressed as (team_count, team_size).
  team_count smallint NOT NULL CHECK (team_count BETWEEN 2 AND 4),
  team_size smallint NOT NULL CHECK (team_size BETWEEN 1 AND 2),
  -- Derived, but stored so a lobby query does not have to multiply to know when it is full.
  seat_count smallint NOT NULL CHECK (seat_count BETWEEN 2 AND 8),

  -- 'standard': highest total wins. 'crazy': LOWEST total wins.
  mode varchar(16) NOT NULL CHECK (mode IN ('standard', 'crazy')),
  visibility varchar(8) NOT NULL CHECK (visibility IN ('public', 'private')),
  -- Empty seats are filled by house bots when the host asks for it, so a private battle does not
  -- stall forever waiting for a fourth player.
  allow_bots boolean NOT NULL DEFAULT false,

  -- The wager PER SEAT: the sum of the crate prices in the round list. Every seat pays the same,
  -- which is what makes the pot a fair contest rather than a handicap.
  entry_cost_minor bigint NOT NULL CHECK (entry_cost_minor > 0),

  status varchar(16) NOT NULL
    CHECK (status IN ('lobby', 'running', 'settled', 'cancelled')),

  -- Provably fair. The hash is published the moment the lobby opens, before anyone can join, so
  -- the outcomes are committed before a single client seed is known. The seed itself is revealed
  -- only at settlement.
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_ciphertext text NOT NULL,
  server_seed_reveal char(64) CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),
  -- SHA256 over the server seed, every client seed in seat order, and the nonce.
  combined_seed_hash char(64) CHECK (combined_seed_hash ~ '^[a-f0-9]{64}$'),
  nonce integer NOT NULL DEFAULT 0 CHECK (nonce >= 0),

  -- The pot: the sum of every payout dropped across every reel. Null until settlement.
  pot_minor bigint CHECK (pot_minor >= 0),
  winning_team smallint CHECK (winning_team >= 0),

  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  settled_at timestamptz,
  -- A lobby nobody joins must not hold its host's money forever.
  expires_at timestamptz NOT NULL,

  CHECK (seat_count = team_count * team_size),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK ((status = 'settled') = (server_seed_reveal IS NOT NULL)),
  CHECK ((status = 'settled') = (pot_minor IS NOT NULL))
);
CREATE INDEX battles_open_lobbies_idx ON battles (created_at DESC, id)
  WHERE status = 'lobby' AND visibility = 'public';
CREATE INDEX battles_status_idx ON battles (status, created_at DESC);
CREATE INDEX battles_host_idx ON battles (host_user_id, created_at DESC);

-- The crate list, in the order it will be opened. Stored as rows rather than as a jsonb array so
-- the reference to cases(id) is a real foreign key and a crate cannot be deleted out from under a
-- battle that is mid-flight.
CREATE TABLE battle_rounds (
  battle_id uuid NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  round_index smallint NOT NULL CHECK (round_index >= 0 AND round_index < 10),
  case_id uuid NOT NULL REFERENCES cases(id),
  -- The price at the moment the lobby was created. A crate repriced mid-lobby must not change
  -- what the players already agreed to pay.
  price_minor bigint NOT NULL CHECK (price_minor > 0),
  PRIMARY KEY (battle_id, round_index)
);

CREATE TABLE battle_players (
  battle_id uuid NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  seat smallint NOT NULL CHECK (seat >= 0 AND seat < 8),
  team smallint NOT NULL CHECK (team >= 0 AND team < 4),
  -- Null for a bot seat. A bot stakes nothing and wins nothing; it exists to make the reels move.
  user_id uuid REFERENCES users(id),
  is_bot boolean NOT NULL DEFAULT false,
  display_name varchar(64) NOT NULL,
  -- The player's own entropy, mixed into the combined seed.
  client_seed varchar(128) NOT NULL,
  -- What this seat actually paid. Zero for a bot.
  staked_minor bigint NOT NULL DEFAULT 0 CHECK (staked_minor >= 0),
  -- The sum of this seat's drops. Null until the battle settles.
  total_drop_minor bigint CHECK (total_drop_minor >= 0),
  -- What this seat was paid out of the pot. Zero for everyone but the winners.
  payout_minor bigint CHECK (payout_minor >= 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, seat),
  CHECK ((user_id IS NULL) = is_bot),
  CHECK (NOT is_bot OR staked_minor = 0)
);
-- One seat per player per battle: nobody plays against themselves to farm the pot.
CREATE UNIQUE INDEX battle_players_one_seat_idx ON battle_players (battle_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX battle_players_user_idx ON battle_players (user_id, joined_at DESC)
  WHERE user_id IS NOT NULL;

-- Every reel result: one row per seat per round. Append-only, and the audit trail a player uses
-- to recompute the battle from the revealed seeds.
CREATE TABLE battle_results (
  battle_id uuid NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  round_index smallint NOT NULL CHECK (round_index >= 0 AND round_index < 10),
  seat smallint NOT NULL CHECK (seat >= 0 AND seat < 8),
  case_id uuid NOT NULL REFERENCES cases(id),
  catalog_item_id uuid NOT NULL REFERENCES catalog_items(id),
  -- The HMAC this reel was decided by, and where it landed in the weight table.
  roll_digest char(64) NOT NULL CHECK (roll_digest ~ '^[a-f0-9]{64}$'),
  roll_weight bigint NOT NULL CHECK (roll_weight >= 0),
  total_weight bigint NOT NULL CHECK (total_weight > 0),
  awarded_weight integer NOT NULL CHECK (awarded_weight > 0),
  payout_minor bigint NOT NULL CHECK (payout_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, round_index, seat),
  CHECK (roll_weight < total_weight)
);
CREATE INDEX battle_results_battle_idx ON battle_results (battle_id, round_index, seat);

CREATE TRIGGER battles_no_delete
  BEFORE DELETE ON battle_results FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Battle money moves through the same ledger as everything else.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake',
      'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break',
      'upgrade_win', 'case_win', 'quest_reward', 'streak_reward', 'faction_payout',
      'battle_stake', 'battle_win', 'battle_refund', 'creator_royalty'
    ));

GRANT SELECT, INSERT ON TABLE
  battles, battle_rounds, battle_players, battle_results, creator_royalties
  TO donut_api_runtime;
-- UPDATE on battles and battle_players: a lobby fills, starts and settles, and a seat records its
-- own result. battle_results and creator_royalties get no UPDATE — both are append-only and both
-- carry a trigger that refuses one.
GRANT UPDATE ON TABLE battles, battle_players TO donut_api_runtime;
-- The marketplace counters and a community crate's own lifecycle are updates to `cases`, which
-- the runtime could not previously write at all.
GRANT UPDATE ON TABLE cases TO donut_api_runtime;
GRANT INSERT ON TABLE cases, case_items TO donut_api_runtime;

-- Supersedes donut_schema_ready_v14.
CREATE FUNCTION donut_schema_ready_v15() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v15() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v15() TO donut_api_runtime;

COMMIT;
