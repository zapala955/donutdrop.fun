BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Slither Arena — the real-time PvP pit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT IS DIFFERENT ABOUT THIS MODE, AND WHY THE SCHEMA LOOKS LIKE THIS
-- ---------------------------------------------------------------------
-- Every other mode on this platform settles a ROUND: money goes in, an outcome is produced, money
-- comes out, and the row that records it is written once. The arena does not have rounds. A player
-- buys in, and from that moment their stake is a live quantity that grows when they eat and
-- vanishes when they die — continuously, at twenty ticks a second, for as long as they stay in.
--
-- Storing every tick would be absurd and storing nothing would be negligent, so this table stores
-- the two instants that actually move money: ENTRY and EXIT. Between them the authoritative value
-- lives in the arena process, and the two facts a ledger needs — what went in, what came out — are
-- both here, with the reason for the difference.
--
-- THE FOUR WAYS A SESSION ENDS, AND WHO IS PAID
-- ---------------------------------------------
--   cashed_out  The player reached a gate or held the extraction channel. The house takes its cut
--               and the remainder is credited. This is the ONLY exit that pays the house.
--   killed      The player ran into somebody. Their whole value became orbs on the floor and other
--               players took it. The house takes nothing: it did not produce that transfer, the
--               killer did, and charging for it would be charging a fee on somebody else's win.
--   abandoned   The connection died and the grace period ran out. Identical to `killed` in every
--               respect that matters — the value went onto the floor — and recorded separately
--               only so that "quit to save the stake" can be proven impossible from the data.
--   voided      The arena process died holding this session. The stake is returned WHOLE. This is
--               the row that exists so a crash cannot be indistinguishable from a loss.
--
-- WHY THE FEE IS ON THE EXIT AND NOT THE ENTRY
-- --------------------------------------------
-- Same rule as every other mode here: the house is paid for delivering the thing it promised, and
-- what it promises the arena is an extraction. A player who never gets out never pays it. Taking
-- the cut at the door would charge the losing player for the privilege of losing, and would make
-- the arena the only mode on the platform where the stake you see is not the stake you play.
--
-- The rate is SNAPSHOT onto the row at entry, exactly as duel_lobbies.rake_bps is, so an operator
-- cannot change the terms under a session that is already running.

CREATE TABLE slither_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),

  -- The buy-in. The band is written into the schema rather than left to configuration because it
  -- is a product rule, not a tuning knob: the whole mode is balanced around a snake whose size is
  -- a log interpolation between these two numbers, and a value outside them has no defined size.
  -- $1,000,000 minimum, $100,000,000 maximum.
  entry_minor bigint NOT NULL
    CHECK (entry_minor >= 1000000 AND entry_minor <= 100000000),

  -- Basis points of the extracted value. Snapshot, not a lookup. See the header.
  fee_bps integer NOT NULL CHECK (fee_bps >= 0 AND fee_bps <= 1000),

  status varchar(16) NOT NULL
    CHECK (status IN ('alive', 'cashed_out', 'killed', 'abandoned', 'voided')),

  -- The largest the snake ever got, for the player's own history. Never used in a payout.
  peak_value_minor bigint NOT NULL CHECK (peak_value_minor >= 0),

  -- All null while status = 'alive'. On exit: the gross value carried at the final tick, the cut
  -- taken from it, and what actually reached the wallet.
  final_value_minor bigint CHECK (final_value_minor >= 0),
  fee_minor bigint CHECK (fee_minor >= 0),
  credited_minor bigint CHECK (credited_minor >= 0),

  kills integer NOT NULL DEFAULT 0 CHECK (kills >= 0),

  joined_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,

  -- Settlement is all-or-nothing, as it is for duels: either every exit column is populated or
  -- none is. A half-written exit is a session nobody can audit.
  CONSTRAINT slither_exit_is_complete CHECK (
    (status = 'alive' AND ended_at IS NULL AND final_value_minor IS NULL
       AND fee_minor IS NULL AND credited_minor IS NULL)
    OR
    (status <> 'alive' AND ended_at IS NOT NULL AND final_value_minor IS NOT NULL
       AND fee_minor IS NOT NULL AND credited_minor IS NOT NULL)
  ),
  -- The fee identity, enforced here rather than trusted from the settlement code. If the three
  -- numbers ever disagree the row is refused, which is a far better failure than a ledger that
  -- quietly pays the wrong one.
  --
  -- It is scoped to the exits that actually SPLIT something. On a death `final_value_minor` is the
  -- amount that hit the floor, which went to other players rather than through a split, so there
  -- is no identity for it to describe — and requiring one made every death unrepresentable, since
  -- `slither_loss_pays_nobody` already pins both other columns to zero. The two rules together
  -- said a snake could only die carrying nothing.
  CONSTRAINT slither_fee_adds_up CHECK (
    status NOT IN ('cashed_out', 'voided')
      OR credited_minor + fee_minor = final_value_minor
  ),
  -- A death and an abandonment pay nobody anything: the value is already on the floor, in other
  -- players' hands, and the house takes no cut of a transfer it did not produce. `final_value_minor`
  -- still records what was carried at the last tick, because "how much hit the floor" is the one
  -- number anybody investigating a death will want.
  CONSTRAINT slither_loss_pays_nobody CHECK (
    status NOT IN ('killed', 'abandoned')
      OR (fee_minor = 0 AND credited_minor = 0)
  ),
  -- A voided session is a refund of exactly the stake, with no cut. It is the one exit the player
  -- did not choose, so it is the one exit that cannot cost them anything.
  CONSTRAINT slither_void_refunds_whole CHECK (
    status <> 'voided'
      OR (fee_minor = 0 AND credited_minor = entry_minor AND final_value_minor = entry_minor)
  )
);

-- "Am I already in?" — the question asked on every join, and the constraint that makes two
-- concurrent joins by one account impossible rather than merely unlikely. A player may hold at
-- most one live snake; a second buy-in while the first is still on the floor is how one account
-- feeds its own orbs to itself.
CREATE UNIQUE INDEX slither_one_live_session_idx ON slither_sessions (user_id)
  WHERE status = 'alive';
-- The player's own arena history.
CREATE INDEX slither_sessions_user_idx ON slither_sessions (user_id, joined_at DESC);
-- The sweeper that voids sessions left alive by a process that died.
CREATE INDEX slither_sessions_alive_idx ON slither_sessions (joined_at) WHERE status = 'alive';

-- ───────────────────────────────────────────────────────────────────────────
-- Kills
-- ───────────────────────────────────────────────────────────────────────────
-- The audit trail for the only event in this mode that moves money between players without either
-- of them making a request. A kill is recorded with the value that was on the victim at the moment
-- it happened, which is what makes "where did that $40M go" answerable after the fact.
--
-- There is no "amount credited to the killer" column, and deliberately so: a kill does not pay the
-- killer. It puts the victim's value on the FLOOR, and whoever reaches the orbs takes it — very
-- often several players, very often not including whoever caused the death. Recording a transfer
-- that did not happen would make this table lie in exactly the way an audit table must not.
CREATE TABLE slither_kills (
  id uuid PRIMARY KEY,
  victim_session_id uuid NOT NULL REFERENCES slither_sessions(id) ON DELETE CASCADE,
  -- Null for a wall collision or an abandonment: nobody killed them.
  killer_session_id uuid REFERENCES slither_sessions(id) ON DELETE SET NULL,
  -- Nobody kills themselves. A head that touches its own body is not a collision in this mode.
  CONSTRAINT slither_kill_distinct CHECK (
    killer_session_id IS NULL OR killer_session_id <> victim_session_id
  ),
  -- The victim's gross value at the instant of death — the amount that hit the floor as orbs.
  dropped_minor bigint NOT NULL CHECK (dropped_minor >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX slither_kills_killer_idx ON slither_kills (killer_session_id, occurred_at DESC)
  WHERE killer_session_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- Ledger and contribution vocabulary
-- ───────────────────────────────────────────────────────────────────────────
-- Arena money moves through the same wallet ledger as everything else, so a buy-in and an
-- extraction land in a player's history beside their crate opens instead of appearing from
-- nowhere. Three kinds, not five: the floor is not the ledger, and an orb changing hands mid-round
-- is not a wallet event — it is a change in a live position the ledger only ever sees at entry and
-- at exit.
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
      -- The buy-in, the extraction, and the stake handed back when the arena process could not
      -- finish what it started.
      'slither_stake', 'slither_cashout', 'slither_refund'
    ));

-- An arena buy-in counts toward the faction war exactly as a duel stake does. The war measures what
-- a player put at risk, and a buy-in is at risk from the first tick.
ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena'));

GRANT SELECT, INSERT ON TABLE slither_sessions, slither_kills TO donut_api_runtime;
-- Sessions genuinely move through states — alive, then exactly one terminal state. Kills do not:
-- a recorded kill is evidence, and evidence that can be edited after the fact is not evidence.
GRANT UPDATE ON TABLE slither_sessions TO donut_api_runtime;

COMMIT;
