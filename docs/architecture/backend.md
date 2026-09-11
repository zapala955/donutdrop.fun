# Backend architecture

The deployment is a modular API plus an isolated Minecraft worker. PostgreSQL is the source of
truth. Redis shares rate-limit counters; game correctness never depends on Redis.

```text
Browser -> trusted TLS edge -> Nginx -> Fastify API -> PostgreSQL
                                      |                ^
                              signed bot network       | read-only audit login
                                      |                |
                                  Mineflayer      checkpoint verifier
                                      |
                                  DonutSMP
```

Nginx rejects `/internal/*`. The API is reachable from Nginx and the bot only on fixed internal
networks; PostgreSQL and Redis are on a separate network the bot cannot join. Mineflayer has the
outbound network required for Microsoft authentication and DonutSMP, but receives only its own
webhook key. The API cannot use the migration or audit-checkpoint credentials.

Bot requests use HMAC-SHA256 with an independent key per bot. The canonical payload binds protocol
version 2, audience `donut-upgrader-api`, HTTP method, exact internal path, bot ID, millisecond
timestamp, and body. API responses are separately signed for audience `donut-upgrader-bot` and bind
the request timestamp and body, response timestamp, HTTP status, and response body. Both directions
enforce a 60-second clock window. Request IDs are journaled; job-claim responses are durable and
lease secrets are deterministically recoverable after a lost response.

Only cryptographically verified raw player chat can initiate linking or a deposit. The bot derives
identity from the server-authenticated UUID, not displayed chat text, then obtains a replay-safe API
authorization immediately before any deposit handoff. Deposit confirmation carries that same UUID,
and the transaction rechecks account eligibility and bot custody state before crediting inventory.
Each deposit can receive exactly one database-backed authorization lease, capped at 150 seconds.
Only the lease-token hash is stored; exact authorization retries recover the same capability from
the journal instead of issuing another one. An expired authorization is never deleted or renewed.

## Custody and fixed pricing

`inventory_lots` allocate real items in one bot inventory. A null owner means house stock.
`custody_movements` is append-only. Reconciliation compares every allocated fingerprint and quantity
against the complete physical inventory; unknown or mismatched items quarantine the bot. Quarantine
is sticky, stops queued/leased jobs, and requires an audited administrator release after a fresh
matching snapshot and credential review.

Only administrators can create catalog entries or change fixed values. Clients submit exact expected
values to bind a wager to the quote they saw. Resolved rounds snapshot stake/target values, edge,
chance, committed seed, reveal, and digest. The core transaction uses `SERIALIZABLE` isolation and
locks eligibility, inventory, seed, and target stock before writing any outcome.

## Retention and maintenance

The restricted maintenance process expires only pending deposit intents for which no handoff was
ever authorized. If an intent or its authorization lease expires after authorization, the intent is
sent to manual review because the bot may already hold the items. Maintenance also expires stale
job leases, removes authentication records only after their safety windows, and invokes a
fixed-policy database function for high-volume bot telemetry. Each hourly run is serialized by a
transaction-scoped advisory lock. Telemetry deletion is limited to 25,000 rows per table per run
after 30 days.

Only heartbeats, inventory-snapshot journal entries, empty job polls, and superseded physical
snapshots are eligible. The newest snapshot and newest mismatch for every bot stay protected.
Account links, deposit authorizations and confirmations, job results, and non-empty job claims remain
append-only. The API login has no direct DELETE privilege on either telemetry table; it can execute
only the owner-defined, fixed-search-path pruning function.

## Production boundaries

- The host TLS proxy must replace client forwarding headers; Nginx and Fastify each trust only their
  immediate fixed proxy subnet.
- Bootstrap-superuser, migration-owner, API-runtime, audit-reader, encryption, cookie, bot, IP-hash,
  audit-log, and checkpoint secrets are separate.
- Microsoft tokens live in an explicitly supplied encrypted host directory readable by the
  unprivileged bot container.
- Migrations are checksum-protected and atomic. API runtime roles cannot alter schema or
  mutate/delete append-only ledgers.
- Audit verification uses a SELECT-only login and a checkpoint key unavailable to the API. Publish
  checkpoints to external immutable storage to detect database-owner rollback.
- Alert on quarantine, reconciliation mismatch, dead-letter/manual-review jobs, serializable retry
  exhaustion, unexpected win-rate drift, and audit checkpoint regression.
