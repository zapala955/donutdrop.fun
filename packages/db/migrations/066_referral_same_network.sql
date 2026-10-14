BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- Invites from the inviter's own network
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The referral bonus is worth more than the wager it asks for, so the cheapest way to collect it is
-- to invite yourself: a second account, signed up on the same connection. Until now the only answer
-- was an administrator noticing and voiding it by hand.
--
-- From here an invite between two accounts that have used the same network is voided automatically
-- and both accounts are blocked from the referral programme. Nothing else about the accounts
-- changes: they log in, play, deposit and withdraw as before. They simply cannot earn from invites
-- until an administrator lifts the block.
--
-- Additive: two columns on users, one table, one relaxed constraint; nothing existing is rewritten.

-- ─────────────────────────────────────────────────────────────────────────────
-- The block
-- ─────────────────────────────────────────────────────────────────────────────
-- Recorded together or not at all, so a blocked account can always say why.
ALTER TABLE users
  ADD COLUMN referral_blocked_at timestamptz,
  ADD COLUMN referral_block_reason varchar(256);

ALTER TABLE users
  ADD CONSTRAINT users_referral_block_recorded_together
    CHECK (num_nonnulls(referral_blocked_at, referral_block_reason) IN (0, 2));

-- ─────────────────────────────────────────────────────────────────────────────
-- Networks an account has used
-- ─────────────────────────────────────────────────────────────────────────────
-- `sessions.ip_hash` only says where an account signed in, and sessions are deleted a week after
-- they end, so it cannot answer "have these two accounts ever shared a connection". This can.
--
-- `network_hash` is an HMAC under IP_HASH_KEY, never an address: an IPv4 address as is (so it is
-- byte for byte the `sessions.ip_hash` of the same address), an IPv6 address by its /64, which is
-- one household or one phone however often the device rotates the rest. Rows not seen for 90 days
-- are deleted by the maintenance job.
CREATE TABLE user_networks (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network_hash bytea NOT NULL CHECK (octet_length(network_hash) = 32),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, network_hash),
  CHECK (last_seen_at >= first_seen_at)
);

-- "Who else has used this network" is the question every check asks.
CREATE INDEX user_networks_network_idx ON user_networks (network_hash, user_id);
-- The retention sweep.
CREATE INDEX user_networks_last_seen_idx ON user_networks (last_seen_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_networks TO donut_api_runtime;

-- Seeded from the sessions still on record, so accounts already playing are covered from the first
-- request rather than from their next sign-in. Only 32-byte hashes, which is every one the API has
-- ever written; anything else would fail the CHECK above and take the migration down with it.
INSERT INTO user_networks (user_id, network_hash, first_seen_at, last_seen_at)
SELECT user_id, ip_hash, min(created_at), greatest(max(created_at), max(last_seen_at))
  FROM sessions
 WHERE octet_length(ip_hash) = 32
 GROUP BY user_id, ip_hash
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- A void nobody clicked
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 045 required every void to name the administrator who made it. An automatic void has
-- no administrator, so `voided_by` may now be empty; the time and the reason still may not. The
-- new rule is strictly weaker than the old one, so every existing row already satisfies it.
ALTER TABLE referrals DROP CONSTRAINT referrals_void_recorded_together;
ALTER TABLE referrals
  ADD CONSTRAINT referrals_void_recorded_together
    CHECK (
      num_nonnulls(voided_at, void_reason) IN (0, 2)
      AND (voided_by IS NULL OR voided_at IS NOT NULL)
    );

-- Set when an administrator restores a referral: they have looked at it and decided it is real,
-- so the automatic check does not void it again on the next wager.
ALTER TABLE referrals ADD COLUMN network_reviewed_at timestamptz;

-- Supersedes donut_schema_ready_v65.
CREATE FUNCTION donut_schema_ready_v66() RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog, public
  AS $$ SELECT true $$;

REVOKE ALL ON FUNCTION donut_schema_ready_v66() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION donut_schema_ready_v66() TO donut_api_runtime;

COMMIT;
