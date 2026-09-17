BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1v1 Skill Duels
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS ONE TAKES A RAKE WHEN CASE BATTLES DO NOT
-- ---------------------------------------------------
-- Migration 015 refused to rake a case battle, and it was right: a battle's pot is built out of
-- crate drops, every crate already returns 90% in expectation, so the house has ALREADY taken its
-- 10% by the time the pot exists. Charging the pot again would charge the edge twice, and the
-- second charge would be invisible to anyone reading the published odds.
--
-- A skill duel has no such underlying edge. Nothing is rolled, no crate is opened, and the
-- outcome is decided entirely by the two players' inputs — the house has no position in it and
-- takes 0% on the result. The rake is therefore not a second charge, it is the ONLY charge, and
-- it is the whole reason the mode can exist. It is quoted per lobby, before anyone stakes.
--
-- The two rules that keep it honest:
--   1. The rake comes off the POT AT SETTLEMENT, never off the stake at entry. A duel that is
--      cancelled, expires, or ends with no valid result returns both stakes whole; the house is
--      paid for producing a winner and is not paid when it does not.
--   2. rake_bps is SNAPSHOT onto the lobby row at creation. Re-reading config at settlement would
--      let an operator change the fee under a duel that is already running, which is precisely
--      the thing a player cannot audit after the fact.

-- ───────────────────────────────────────────────────────────────────────────
-- Lobbies
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE duel_lobbies (
  id uuid PRIMARY KEY,
  -- Short, URL-safe, and the thing a private invite link carries. Same shape as a battle code.
  code varchar(12) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6,12}$'),

  host_user_id uuid NOT NULL REFERENCES users(id),
  -- Null until somebody takes the other side. A duel is strictly two players; there is no seat
  -- table because there is no configuration of this mode with three.
  opponent_user_id uuid REFERENCES users(id),
  -- Nobody duels themselves: that is a zero-risk way to launder a stake into wagered volume and
  -- farm rakeback with it.
  CONSTRAINT duel_distinct_players CHECK (opponent_user_id IS NULL OR opponent_user_id <> host_user_id),

  -- 'reflex'    — react to an unpredictable cue, fastest valid reaction wins the round.
  -- 'precision' — stop a sweeping needle as close to a marked target as possible.
  -- 'sequence'  — repeat a short symbol order from memory, most correct in the time limit wins.
  variant varchar(16) NOT NULL CHECK (variant IN ('reflex', 'precision', 'sequence')),

  visibility varchar(8) NOT NULL CHECK (visibility IN ('public', 'private')),
  -- Argon2id, like every other secret this platform stores. Null for a public lobby, required for
  -- a private one — the CHECK makes "private with no password" unrepresentable rather than a
  -- runtime branch somebody forgets.
  join_secret_hash text,
  CONSTRAINT duel_private_needs_secret
    CHECK ((visibility = 'private') = (join_secret_hash IS NOT NULL)),

  -- The wager PER PLAYER. Both sides stake the same; an uneven duel is a handicap, not a contest.
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- Snapshot, not a lookup. See the header.
  rake_bps integer NOT NULL CHECK (rake_bps >= 0 AND rake_bps <= 1000),

  status varchar(16) NOT NULL CHECK (status IN ('lobby', 'running', 'settled', 'cancelled')),

  -- Provably fair, and it protects a different thing here than it does in a crate.
  --
  -- Nothing about WHO WINS is random — that is the point of a skill mode. What is random is the
  -- STIMULUS SCHEDULE: how long the reflex cue waits before it fires, where the precision target
  -- sits, which symbols the sequence uses. If a player could predict that schedule they could
  -- pre-program an input against it, so the schedule is committed as a hash before either player
  -- can stake and revealed at settlement. A client can then replay the derivation and confirm the
  -- cue it was given is the cue the commitment promised.
  server_seed_hash char(64) NOT NULL CHECK (server_seed_hash ~ '^[a-f0-9]{64}$'),
  server_seed_ciphertext text NOT NULL,
  server_seed_reveal char(64) CHECK (server_seed_reveal ~ '^[a-f0-9]{64}$'),

  rounds_total smallint NOT NULL CHECK (rounds_total BETWEEN 1 AND 9),

  -- All null until settlement. pot = 2 * stake; rake = pot * rake_bps / 10000; payout = pot - rake.
  winner_user_id uuid REFERENCES users(id),
  pot_minor bigint CHECK (pot_minor >= 0),
  rake_minor bigint CHECK (rake_minor >= 0),
  payout_minor bigint CHECK (payout_minor >= 0),
  -- A draw is a real outcome, not an error: both stakes are returned and the house takes nothing,
  -- because it did not produce a winner. Recorded so settlement is never ambiguous about which of
  -- "no winner yet" and "no winner, ever" a null winner means.
  outcome varchar(16) CHECK (outcome IN ('decided', 'draw', 'forfeit', 'expired')),

  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  settled_at timestamptz,
  -- A lobby nobody joins must not hold its host's money forever.
  expires_at timestamptz NOT NULL,

  -- Settlement is all-or-nothing: either every settlement column is populated or none is.
  CONSTRAINT duel_settled_is_complete CHECK (
    (settled_at IS NULL AND pot_minor IS NULL AND rake_minor IS NULL
       AND payout_minor IS NULL AND outcome IS NULL AND server_seed_reveal IS NULL)
    OR
    (settled_at IS NOT NULL AND pot_minor IS NOT NULL AND rake_minor IS NOT NULL
       AND payout_minor IS NOT NULL AND outcome IS NOT NULL AND server_seed_reveal IS NOT NULL)
  ),
  -- The rake identity, enforced by the database rather than trusted from the settlement code.
  -- If these three ever disagree the row is refused, which is a far better failure than a ledger
  -- that quietly pays the wrong number.
  CONSTRAINT duel_rake_adds_up CHECK (
    settled_at IS NULL OR payout_minor + rake_minor = pot_minor
  ),
  -- A decided duel has a winner; every other outcome has none.
  CONSTRAINT duel_winner_matches_outcome CHECK (
    outcome IS NULL OR (outcome = 'decided' OR outcome = 'forfeit') = (winner_user_id IS NOT NULL)
  )
);

-- The lobby list: open duels, biggest stake first, which is the order the table renders in.
CREATE INDEX duel_lobbies_open_idx ON duel_lobbies (stake_minor DESC, created_at DESC)
  WHERE status = 'lobby' AND visibility = 'public';
-- The sweeper that refunds abandoned lobbies.
CREATE INDEX duel_lobbies_expiry_idx ON duel_lobbies (expires_at)
  WHERE status IN ('lobby', 'running');
-- "My duels", for the profile and match history.
CREATE INDEX duel_lobbies_host_idx ON duel_lobbies (host_user_id, created_at DESC);
CREATE INDEX duel_lobbies_opponent_idx ON duel_lobbies (opponent_user_id, created_at DESC)
  WHERE opponent_user_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- Rounds
-- ───────────────────────────────────────────────────────────────────────────
-- One row per player per round. This is the audit trail for a mode whose entire integrity claim
-- is "the server validated the input", so it stores what the server was told, when the server
-- actually heard it, and what it decided — not just the score it derived.
CREATE TABLE duel_rounds (
  duel_id uuid NOT NULL REFERENCES duel_lobbies(id) ON DELETE CASCADE,
  round_index smallint NOT NULL CHECK (round_index >= 0 AND round_index < 9),
  user_id uuid NOT NULL REFERENCES users(id),

  -- The scheduled moment the cue fires, as an offset in ms from the round's shared start. Derived
  -- from the committed server seed, so it is reproducible from the reveal.
  cue_offset_ms integer NOT NULL CHECK (cue_offset_ms >= 0),
  -- For 'precision', the target the needle should be stopped on, in the same ms space.
  target_offset_ms integer CHECK (target_offset_ms >= 0),

  -- What the client SAYS the player did, measured locally against the shared start so that
  -- network latency does not decide a reaction contest.
  reported_ms integer CHECK (reported_ms >= 0),
  -- When the server actually received it, same ms space. The gap between this and reported_ms is
  -- the player's round trip, and a reported time that could not have produced this arrival is how
  -- a forged input gets caught. Both are kept: the derived number is not a substitute for the two
  -- measurements it came from.
  arrived_ms integer CHECK (arrived_ms >= 0),

  -- 'valid'       — counted.
  -- 'too_early'   — input landed before the cue: a guess, or a program that fired on a timer.
  -- 'too_late'    — no input inside the round window.
  -- 'implausible' — inside the window but faster than a human nervous system, or contradicted by
  --                 its own arrival time.
  verdict varchar(16) NOT NULL
    CHECK (verdict IN ('valid', 'too_early', 'too_late', 'implausible')),
  -- Lower is better for reflex and precision. Null when the verdict is not 'valid'.
  score integer CHECK (score >= 0),
  CONSTRAINT duel_score_requires_valid CHECK ((verdict = 'valid') = (score IS NOT NULL)),

  recorded_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (duel_id, round_index, user_id)
);

-- ───────────────────────────────────────────────────────────────────────────
-- Ledger and contribution vocabulary
-- ───────────────────────────────────────────────────────────────────────────
-- Duel money moves through the same wallet ledger as everything else, so it lands in a player's
-- history beside their wins instead of appearing from nowhere.
ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_kind_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_kind_check
    CHECK (kind IN (
      'case_open', 'item_sale', 'admin_adjustment', 'upgrade_stake',
      'vault_yield', 'piggy_open', 'piggy_claim', 'piggy_break',
      'upgrade_win', 'case_win', 'quest_reward', 'streak_reward', 'faction_payout',
      'battle_stake', 'battle_win', 'battle_refund', 'creator_royalty',
      'referral_revshare', 'referral_bonus',
      'rakeback_claim', 'race_payout',
      'duel_stake', 'duel_win', 'duel_refund'
    ));

-- A duel stake counts toward the faction war exactly as a crate open does. The war measures what
-- a player put at risk, and a duel stake is at risk in precisely the same way.
ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel'));

GRANT SELECT, INSERT ON TABLE duel_lobbies, duel_rounds TO donut_api_runtime;
-- Lobbies genuinely move through states — joined, started, settled, cancelled. Rounds do not: a
-- recorded input is evidence, and evidence that can be edited after the fact is not evidence.
GRANT UPDATE ON TABLE duel_lobbies TO donut_api_runtime;

COMMIT;
