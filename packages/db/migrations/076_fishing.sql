BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Fishing
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per cast, a deep dive on a fishing line: the stake is taken and the line's breaking point
-- drawn from the player's committed fairness seed when the cast is made (see
-- services/api-gateway/src/lib/fishing.ts); the cast is open while the lure sinks and the multiplier
-- climbs, and settles once, reeled up (landed) or cut (snapped).
--
-- Every change to an existing table below WIDENS a constraint, by one value. Each list is the
-- latest one in force (072's; 073 changed none of them) plus Fishing.

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
      'tower_stake', 'tower_payout',
      'chicken_stake', 'chicken_payout',
      'slots_stake', 'slots_payout',
      'fishing_stake', 'fishing_payout'
    ));

-- ── where a wager came from ────────────────────────────────────────────────
ALTER TABLE wager_events DROP CONSTRAINT wager_events_source_check;
ALTER TABLE wager_events
  ADD CONSTRAINT wager_events_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing'));

ALTER TABLE faction_contributions DROP CONSTRAINT faction_contributions_source_check;
ALTER TABLE faction_contributions
  ADD CONSTRAINT faction_contributions_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing'));

ALTER TABLE referral_earnings DROP CONSTRAINT referral_earnings_source_check;
ALTER TABLE referral_earnings
  ADD CONSTRAINT referral_earnings_source_check
    CHECK (source IN ('upgrader', 'case', 'piggy_bank', 'skill_duel', 'slither_arena', 'roulette',
                      'blackjack', 'crash', 'mines', 'plinko', 'coinflip', 'dice', 'mines_duel',
                      'tower', 'chicken', 'slots', 'fishing'));

-- ── the casts ──────────────────────────────────────────────────────────────
CREATE TABLE fishing_casts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  stake_minor bigint NOT NULL CHECK (stake_minor > 0),
  -- The sinker sets how fast the lure sinks and the multiplier climbs; the odds are the same in all three.
  sinker text NOT NULL CHECK (sinker IN ('feather', 'iron', 'anvil')),
  -- Land here by itself, if the line holds that far.
  auto_land_x100 integer CHECK (auto_land_x100 IS NULL OR auto_land_x100 BETWEEN 101 AND 100000),
  -- The line's breaking point, in hundredths: 100 snaps on the bite. Secret until the cast settles.
  snap_x100 integer NOT NULL CHECK (snap_x100 BETWEEN 100 AND 100000),
  -- The bite: the multiplier climbs from 1.00x here.
  hooked_at timestamptz NOT NULL,
  status varchar(8) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'landed', 'snapped')),
  landed_x100 integer CHECK (landed_x100 BETWEEN 101 AND 99999),
  catch text CHECK (catch ~ '^[a-z_]{2,32}$'),
  payout_minor bigint NOT NULL DEFAULT 0 CHECK (payout_minor >= 0),
  fairness_seed_id uuid NOT NULL REFERENCES fairness_seeds(id),
  server_seed_hash char(64) NOT NULL,
  -- Written at settlement and not before.
  server_seed_reveal char(64),
  client_seed varchar(128) NOT NULL,
  nonce integer NOT NULL CHECK (nonce >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (user_id, idempotency_key),
  -- A seed decides one cast.
  UNIQUE (fairness_seed_id),
  CHECK ((status = 'open') = (settled_at IS NULL)),
  CHECK (status = 'open' OR server_seed_reveal IS NOT NULL),
  CHECK (status <> 'open' OR (server_seed_reveal IS NULL AND landed_x100 IS NULL AND payout_minor = 0)),
  -- A landing is below the breaking point, and pays the stake times its multiplier, floored.
  CHECK (status <> 'landed'
         OR (landed_x100 < snap_x100 AND catch IS NOT NULL AND payout_minor = stake_minor * landed_x100 / 100)),
  CHECK (status <> 'snapped' OR (landed_x100 IS NULL AND catch IS NULL AND payout_minor = 0))
);

-- One cast in play per player, refused by the index rather than by a read in the handler.
CREATE UNIQUE INDEX fishing_casts_one_open_idx ON fishing_casts (user_id) WHERE status = 'open';
CREATE INDEX fishing_casts_user_idx ON fishing_casts (user_id, created_at DESC);
-- The live feed and the day's biggest wins read settled casts newest-first.
CREATE INDEX fishing_casts_feed_idx ON fishing_casts (settled_at DESC) WHERE status <> 'open';

GRANT SELECT, INSERT, UPDATE ON TABLE fishing_casts TO donut_api_runtime;

-- Supersedes donut_schema_ready_v75.
CREATE FUNCTION donut_schema_ready_v76() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v76() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v76() TO donut_api_runtime;

COMMIT;
