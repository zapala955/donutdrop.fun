BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- The social and retention suite
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Five features land together because they share one property: every one of them moves real money
-- between real wallets, so not one of them can live in the browser. A jackpot bar that counts up in
-- JavaScript, a rain pool with no ledger behind it, or a tip that is a toast and nothing else are
-- all the same bug wearing different clothes.
--
-- WHERE THE MONEY COMES FROM
-- --------------------------
-- The vault jackpot and the lava rain pool are both funded out of the HOUSE MARGIN, exactly like
-- rakeback, the VIP ladder, the referral share and the creator programme. They are not a surcharge
-- on a wager. That matters at boot: assertVipSolvency sums every one of those claims against the
-- platform's thinnest edge and refuses to start if they add up to more than it, and the jackpot and
-- rain rates are now part of that sum. A giveback nobody counted is how a promotion bankrupts a
-- house six months after it launches.
--
-- Tips and side bets are different: they are player money moving between players. The house is paid
-- a rake on a side bet because it holds and settles the market; it takes nothing on a tip, because a
-- tip is not a wager and charging for one would be charging a player to be generous.

-- ───────────────────────────────────────────────────────────────────────────
-- Wager events
-- ───────────────────────────────────────────────────────────────────────────
-- Every wager, with its timestamp, in one append-only log.
--
-- This exists because the platform could not answer "how much has this player staked in the last
-- hour". `user_wager_totals` is lifetime and has no clock in it; `faction_contributions` has one but
-- only ever gets a row when a war is live and the player has picked a side. The lava rain's
-- eligibility window is a question about a SPAN of time, so it needs a table with time in it.
--
-- It is written from the same single call every other wager side effect is (recordWager), so a game
-- mode cannot be added that forgets to log. Idempotent on (source, reference_id), which is what
-- makes a retried settlement safe.
CREATE TABLE wager_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  -- The margin the wager actually generated. Carried so the jackpot and rain accruals can be
  -- reconciled against what the house really collected rather than re-derived from an edge the
  -- mode may not charge.
  margin_minor bigint NOT NULL CHECK (margin_minor >= 0),
  source varchar(24) NOT NULL
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena')),
  reference_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, reference_id)
);

-- The eligibility question, which is always "this user, this window".
CREATE INDEX wager_events_user_window_idx ON wager_events (user_id, created_at DESC);
-- The pruning question. This table grows with turnover and is the one thing here that needs a
-- retention policy rather than living forever.
CREATE INDEX wager_events_created_idx ON wager_events (created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- Vault jackpot
-- ───────────────────────────────────────────────────────────────────────────
-- One pot for the whole platform, accumulating a share of every wager's margin and paid out whole
-- to one player when a draw hits.
--
-- A single row rather than a sum over a history table, for the reason every other running total on
-- this platform is a row: it is updated inside the settlement of every crate open and every
-- upgrader pull, and an aggregate over all history would grow without bound.
CREATE TABLE vault_jackpot (
  -- Exactly one row, forever. The CHECK is what makes a second pot unrepresentable rather than
  -- merely unlikely — two pots would each pay out and the house would fund both.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  pot_minor bigint NOT NULL DEFAULT 0 CHECK (pot_minor >= 0),
  -- What the pot resets to after a win, so the bar is never sitting at zero looking broken.
  seed_minor bigint NOT NULL DEFAULT 0 CHECK (seed_minor >= 0),
  -- Lifetime figures, for the bar's own history and for reconciliation.
  lifetime_contributed_minor bigint NOT NULL DEFAULT 0 CHECK (lifetime_contributed_minor >= 0),
  lifetime_paid_minor bigint NOT NULL DEFAULT 0 CHECK (lifetime_paid_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO vault_jackpot (id) VALUES (true);

-- Every win, with the draw that produced it.
--
-- `roll` and `threshold` are both stored so the outcome can be re-checked rather than taken on
-- trust: the draw hit if roll < threshold, and threshold is a published function of the wager. A
-- jackpot whose trigger nobody can audit is a jackpot the house can claim never triggered.
CREATE TABLE vault_jackpot_wins (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  -- The wager that drew it, so a win is always traceable to a real round.
  source varchar(24) NOT NULL,
  reference_id uuid NOT NULL,
  wager_minor bigint NOT NULL CHECK (wager_minor > 0),
  roll bigint NOT NULL CHECK (roll >= 0),
  threshold bigint NOT NULL CHECK (threshold >= 0),
  won_at timestamptz NOT NULL DEFAULT now(),
  -- One draw per wager. A retried settlement must not be able to win twice off one round.
  UNIQUE (source, reference_id)
);
CREATE INDEX vault_jackpot_wins_recent_idx ON vault_jackpot_wins (won_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Lava rain
-- ───────────────────────────────────────────────────────────────────────────
-- A pot announced in advance, open for a fixed window, split evenly between everyone who claims
-- and qualifies.
--
-- Split on SETTLEMENT rather than paid on claim, because the share depends on how many people claim
-- and that is not known until the window shuts. Claiming registers an entitlement; the money moves
-- once, at the end, when the divisor is final.
CREATE TABLE lava_rain_events (
  id uuid PRIMARY KEY,
  pool_minor bigint NOT NULL CHECK (pool_minor > 0),
  -- Null for an automated drop; set when a member of staff started it by hand.
  created_by uuid REFERENCES users(id),
  -- The bar a player must clear to claim: this much wagered inside the trailing window.
  min_wagered_minor bigint NOT NULL CHECK (min_wagered_minor >= 0),
  window_minutes integer NOT NULL CHECK (window_minutes > 0 AND window_minutes <= 1440),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  CONSTRAINT lava_rain_window_is_forward CHECK (closes_at > opens_at),
  status varchar(12) NOT NULL CHECK (status IN ('open', 'settled', 'expired')),
  -- Null until settlement. `expired` is the no-claimant case: the pool was never handed out and
  -- goes back to the house, which is recorded rather than left implicit.
  claimant_count integer CHECK (claimant_count >= 0),
  per_claim_minor bigint CHECK (per_claim_minor >= 0),
  -- Integer division leaves a few units that cannot be split evenly. Kept rather than quietly
  -- dropped, so the pool always adds up.
  remainder_minor bigint CHECK (remainder_minor >= 0),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lava_rain_settled_is_complete CHECK (
    (status = 'open' AND settled_at IS NULL AND claimant_count IS NULL
       AND per_claim_minor IS NULL AND remainder_minor IS NULL)
    OR
    (status <> 'open' AND settled_at IS NOT NULL AND claimant_count IS NOT NULL
       AND per_claim_minor IS NOT NULL AND remainder_minor IS NOT NULL)
  ),
  -- The pool identity: what everybody got, plus what could not be split, is what was promised.
  CONSTRAINT lava_rain_pool_adds_up CHECK (
    settled_at IS NULL
      OR per_claim_minor * claimant_count + remainder_minor = pool_minor
  )
);
CREATE INDEX lava_rain_open_idx ON lava_rain_events (closes_at) WHERE status = 'open';

CREATE TABLE lava_rain_claims (
  event_id uuid NOT NULL REFERENCES lava_rain_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  -- What they had wagered in the window at the moment they claimed. Stored because eligibility is
  -- a claim about the past and the window will have moved on by the time anybody checks.
  qualifying_wagered_minor bigint NOT NULL CHECK (qualifying_wagered_minor >= 0),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  -- Filled at settlement, when the divisor is finally known.
  paid_minor bigint CHECK (paid_minor >= 0),
  -- One claim each. This is the whole integrity of an even split.
  PRIMARY KEY (event_id, user_id)
);

-- ───────────────────────────────────────────────────────────────────────────
-- Player-to-player tips
-- ───────────────────────────────────────────────────────────────────────────
-- Player money moving sideways. The house takes nothing: a tip is not a wager, it generates no
-- margin, and a fee on one would be a charge for being generous.
--
-- It is also the most obvious laundering and bonus-abuse channel on the platform, which is why the
-- row keeps both sides and why tips are excluded from every wagered-volume counter. A tip must never
-- move a player up the VIP ladder or into a rain window.
CREATE TABLE player_tips (
  id uuid PRIMARY KEY,
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  CONSTRAINT tip_distinct_parties CHECK (from_user_id <> to_user_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  -- Optional one-line note, shown on the chat line the tip produces.
  note varchar(80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_tips_from_idx ON player_tips (from_user_id, created_at DESC);
CREATE INDEX player_tips_to_idx ON player_tips (to_user_id, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Spectator side bets
-- ───────────────────────────────────────────────────────────────────────────
-- A market on somebody else's match, for people who are not in it.
--
-- WHY THE HOUSE IS PAID HERE AND NOT ON A TIP. The house holds both sides of a side bet, decides it
-- from a match it is already refereeing, and pays the winners. That is a service, and the rake is
-- the price of it. It comes off the POOL at settlement, never off the stake at entry — the same rule
-- the duel rake and the arena cut follow, so a market that never resolves refunds at face value.
CREATE TABLE side_bet_markets (
  id uuid PRIMARY KEY,
  -- What is being bet on. Both are matches this platform already runs and settles itself.
  kind varchar(16) NOT NULL CHECK (kind IN ('slither', 'duel')),
  -- The arena session id or the duel code this market follows.
  subject_ref varchar(64) NOT NULL,
  -- Two outcomes, named by the market's creator and fixed at creation.
  outcome_a varchar(40) NOT NULL,
  outcome_b varchar(40) NOT NULL,
  CONSTRAINT side_bet_outcomes_distinct CHECK (outcome_a <> outcome_b),
  -- Snapshot, not a lookup, for the same reason every other fee on this platform is snapshot: an
  -- operator must not be able to change the terms under a market that is already taking money.
  rake_bps integer NOT NULL CHECK (rake_bps >= 0 AND rake_bps <= 1000),
  status varchar(12) NOT NULL CHECK (status IN ('open', 'locked', 'settled', 'voided')),
  -- Null until settled. 'void' is a real outcome: the match produced no answer and every stake is
  -- returned whole with no rake, because the house did not decide anything.
  winning_outcome varchar(40),
  pool_minor bigint CHECK (pool_minor >= 0),
  rake_minor bigint CHECK (rake_minor >= 0),
  payout_minor bigint CHECK (payout_minor >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  settled_at timestamptz,
  CONSTRAINT side_bet_settled_is_complete CHECK (
    (status IN ('open', 'locked') AND settled_at IS NULL AND pool_minor IS NULL
       AND rake_minor IS NULL AND payout_minor IS NULL)
    OR
    (status IN ('settled', 'voided') AND settled_at IS NOT NULL AND pool_minor IS NOT NULL
       AND rake_minor IS NOT NULL AND payout_minor IS NOT NULL)
  ),
  CONSTRAINT side_bet_rake_adds_up CHECK (
    settled_at IS NULL OR payout_minor + rake_minor = pool_minor
  ),
  -- A voided market pays the house nothing, because it decided nothing.
  CONSTRAINT side_bet_void_takes_no_rake CHECK (status <> 'voided' OR rake_minor = 0),
  -- A settled market names its winner; every other state has none.
  CONSTRAINT side_bet_winner_matches_status CHECK (
    (status = 'settled') = (winning_outcome IS NOT NULL)
  ),
  -- The winner has to be one of the two outcomes the market opened with.
  CONSTRAINT side_bet_winner_is_an_outcome CHECK (
    winning_outcome IS NULL OR winning_outcome IN (outcome_a, outcome_b)
  ),
  -- One live market per subject. Two markets on the same match split the liquidity and give two
  -- different prices for the same question.
  UNIQUE (kind, subject_ref)
);
CREATE INDEX side_bet_markets_open_idx ON side_bet_markets (opened_at DESC)
  WHERE status IN ('open', 'locked');

CREATE TABLE side_bets (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL REFERENCES side_bet_markets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  outcome varchar(40) NOT NULL,
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- Null until the market settles. A losing bet is paid zero rather than left null, so "settled and
  -- lost" and "not settled yet" can never be confused.
  payout_minor bigint CHECK (payout_minor >= 0),
  placed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT side_bet_payout_matches_settlement CHECK (
    (settled_at IS NULL) = (payout_minor IS NULL)
  )
);
-- A spectator backs one side, once. Letting them take both sides makes the rake a pure loss for
-- them and the market meaningless for everyone else.
CREATE UNIQUE INDEX side_bets_one_per_market_idx ON side_bets (market_id, user_id);
CREATE INDEX side_bets_market_idx ON side_bets (market_id);
CREATE INDEX side_bets_user_idx ON side_bets (user_id, placed_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Chat timeouts
-- ───────────────────────────────────────────────────────────────────────────
-- A player muted in chat for a while, by a named member of staff, for a stated reason.
--
-- Separate from responsible_limits.cooldown_until, which is a RESPONSIBLE-PLAY control that stops
-- somebody gambling. Conflating the two would mean a moderator silencing a spammer also barred them
-- from the games they had money in, and that a self-exclusion looked like a moderation action in
-- the audit trail. Different powers, different tables.
--
-- Rows are kept after they expire rather than deleted: "has this account been timed out before" is
-- the question a moderator asks before deciding how long the next one should be.
CREATE TABLE chat_timeouts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  issued_by uuid NOT NULL REFERENCES users(id),
  CONSTRAINT chat_timeout_not_self CHECK (user_id <> issued_by),
  reason varchar(120),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Lifted early by a moderator. The row stays; only the effect ends.
  lifted_at timestamptz,
  lifted_by uuid REFERENCES users(id),
  CONSTRAINT chat_timeout_lift_is_complete CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);
-- "Is this account muted right now" — asked on every message send.
CREATE INDEX chat_timeouts_active_idx ON chat_timeouts (user_id, expires_at DESC)
  WHERE lifted_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- Ledger vocabulary
-- ───────────────────────────────────────────────────────────────────────────
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
      'duel_stake', 'duel_win', 'duel_refund',
      'slither_stake', 'slither_cashout', 'slither_refund',
      -- The social suite. Both halves of a tip are written, because a transfer that only appears
      -- in one party's history is a transfer neither party can reconcile.
      'jackpot_win', 'rain_claim', 'tip_sent', 'tip_received',
      'sidebet_stake', 'sidebet_win', 'sidebet_refund'
    ));

GRANT SELECT, INSERT ON TABLE
  wager_events, vault_jackpot_wins, lava_rain_events, lava_rain_claims,
  player_tips, side_bet_markets, side_bets, chat_timeouts
  TO donut_api_runtime;
GRANT SELECT, UPDATE ON TABLE vault_jackpot TO donut_api_runtime;
-- Markets, rain events and claims move through states. The wager log, the tip log and the win log
-- do not: they are evidence, and evidence that can be edited after the fact is not evidence.
GRANT UPDATE ON TABLE lava_rain_events, lava_rain_claims, side_bet_markets, side_bets,
  chat_timeouts
  TO donut_api_runtime;
-- The retention sweeper prunes the wager log; nothing else may delete from any of these.
GRANT DELETE ON TABLE wager_events TO donut_api_runtime;

COMMIT;
