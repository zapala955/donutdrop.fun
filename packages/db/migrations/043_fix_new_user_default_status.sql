BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- New accounts could not be created
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 036 removed the compliance apparatus. It narrowed users.status to
-- ('active', 'suspended', 'closed') and updated every existing row off the two values it was
-- dropping -- and it left the column DEFAULT pointing at one of them:
--
--   status varchar(24) NOT NULL DEFAULT 'pending_compliance'   -- migration 001, never revised
--
-- POST /v1/auth/link/complete inserts a new player without naming `status`, so every first-time
-- signup took that default, violated the CHECK that had just been narrowed against it, and
-- returned a 500 AFTER the player had already paid the login nonce. Existing players were
-- unaffected -- their row already said 'active' and their login is an UPDATE -- which is why this
-- survived a deploy and showed up only as new players reporting "payment received, sign-in
-- failed". The developer login was unaffected too: it names the column explicitly.
--
-- The lesson 036 was written to respect was "a new CHECK is validated against existing rows".
-- The rule is bigger than that: a narrowed CHECK has to be reconciled with everything that can
-- still produce a value, and a column default is a writer that no row and no query mentions.
--
-- No money was lost to this. The completion transaction rolls back as a unit, so `completed_at`
-- stays NULL and no wallet credit is written; the handler reconciles every confirmed-but-
-- uncompleted challenge for the same Minecraft identity on the next attempt. Players who paid and
-- were refused are signed in and credited in full the moment they try again.
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'active';

-- Belt and braces for anything already sitting in the table, in case a row was written between
-- 036 and this by a path that did not go through the API.
UPDATE users SET status = 'active', updated_at = now()
 WHERE status NOT IN ('active', 'suspended', 'closed');

-- No readiness bump. The API build shipped alongside this names `status` in its INSERT, so it is
-- correct against a database with or without this migration, and a marker would couple them for
-- no reason. The migration is what repairs an already-deployed gateway.

COMMIT;
