BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Tower
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One game per row, played across several requests: start, then climb one floor at a time by
-- turning a tile, until the player cashes out, turns TNT or reaches the top. The TNT on all nine
-- floors is placed at the start from the player's committed fairness seed (see
-- services/api-gateway/src/lib/tower.ts) and kept in the row; the API never sends it, or the
-- seed, to a browser until the game is over.
--
-- Every change to an existing table below WIDENS a constraint, by one value. Widening cannot fail
-- against existing rows; narrowing is how migration 030 took production down. Each list is the
-- latest one in force (067 for the ledger kinds, 057 for the wager sources) plus Tower.

-- ── the ledger kinds ───────────────────────────────────────────────────────
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
      'jackpot_win', 'rain_claim', 'tip_sent', 'tip_received',
      'sidebet_stake', 'sidebet_win', 'sidebet_refund',
      'pay_login_deposit', 'cash_deposit',
      'cash_withdrawal', 'cash_withdrawal_refund',
      'roulette_stake', 'roulette_win',
      'signup_bonus',
      'blackjack_stake', 'blackjack_double', 'blackjack_payout',
      'crash_stake', 'crash_payout',
      'mines_stake', 'mines_payout',
      'plinko_stake', 'plinko_payout',
      'coinflip_stake', 'coinflip_win', 'coinflip_refund',
      'dice_stake', 'dice_payout',
      'discord_join_reward', 'discord_tag_reward', 'discord_invite_reward',
      'mines_duel_stake', 'mines_duel_win', 'mines_duel_refund',
      'daily_code_reward',
      'demo_topup',
      'tower_stake', 'tower_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower'));

-- ── the games ──────────────────────────────────────────────────────────────
CREATE TABLE tower_games (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- easy: 4 tiles, 1 TNT · medium: 3, 1 · hard: 2, 1 · expert: 3, 2. Nine floors in every mode.
  mode varchar(8) NOT NULL CHECK (mode IN ('easy', 'medium', 'hard', 'expert')),
  -- The TNT, bottom floor first: one tile per floor (two on expert), 0-based from the left.
  -- Secret until the game settles.
  trap_tiles smallint[] NOT NULL,
  -- The tile turned on each floor cleared, bottom floor first.
  picks smallint[] NOT NULL DEFAULT '{}',
  -- The payout ceiling that applied when the game started.
  max_payout_minor bigint NOT NULL CHECK (max_payout_minor > 0),
  status varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
  outcome varchar(10) CHECK (outcome IN ('cashout', 'trap')),
  -- The TNT tile turned, on floor cardinality(picks), when that is how it ended.
  trap_hit smallint CHECK (trap_hit BETWEEN 0 AND 3),
  payout_minor bigint CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  -- Written at settlement and not before.
  server_seed_reveal char(64),
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (user_id, idempotency_key),
  CHECK (cardinality(trap_tiles) = 9 * CASE mode WHEN 'expert' THEN 2 ELSE 1 END),
  CHECK (cardinality(picks) <= 9),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status = 'active'
         OR (outcome IS NOT NULL AND payout_minor IS NOT NULL AND server_seed_reveal IS NOT NULL)),
  CHECK (status = 'settled' OR (server_seed_reveal IS NULL AND outcome IS NULL AND payout_minor IS NULL)),
  CHECK (outcome IS DISTINCT FROM 'trap' OR (trap_hit IS NOT NULL AND payout_minor = 0)),
  -- A cash-out has climbed at least one floor; a climb past the top cannot exist.
  CHECK (outcome IS DISTINCT FROM 'cashout' OR cardinality(picks) >= 1)
);

-- One game in play per player, refused by the index rather than by a read in the handler: two
-- clicks half a second apart both pass a read.
CREATE UNIQUE INDEX tower_games_one_active_idx ON tower_games (user_id) WHERE status = 'active';
CREATE INDEX tower_games_user_idx ON tower_games (user_id, created_at DESC);
-- The live feed reads settled games newest-first.
CREATE INDEX tower_games_feed_idx ON tower_games (settled_at DESC) WHERE status = 'settled';

GRANT SELECT, INSERT, UPDATE ON TABLE tower_games TO donut_api_runtime;

-- Supersedes donut_schema_ready_v67.
CREATE FUNCTION donut_schema_ready_v68() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v68() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v68() TO donut_api_runtime;

COMMIT;
