# Backend API summary

All JSON endpoints are versioned under `/v1`. Browser mutations require the session cookie, exact
configured `Origin`, `X-CSRF-Token`, and (where noted) `Idempotency-Key`. Integer values are returned
as strings when they originate from PostgreSQL `bigint` columns.

This is an English, Minecraft-only backend. The checked-in catalog is empty, no CS2 or Steam item
types exist, and transfer-dependent operations remain disabled until the DonutSMP adapter passes its
separate launch review.

## Public and authentication

| Method | Path                                | Purpose                                   |
| ------ | ----------------------------------- | ----------------------------------------- |
| GET    | `/health/live`                      | Process liveness                          |
| GET    | `/health/ready`                     | Schema, PostgreSQL, and Redis readiness   |
| POST   | `/v1/auth/link/start`               | Create in-game proof instruction          |
| GET    | `/v1/auth/link/status?challengeId=` | Poll proof state from the same browser    |
| POST   | `/v1/auth/link/complete`            | Consume confirmed proof and issue session |
| GET    | `/v1/auth/me`                       | Current identity                          |
| POST   | `/v1/auth/logout`                   | Revoke this session                       |
| POST   | `/v1/auth/logout-all`               | Revoke every session                      |

## Player

| Method    | Path                         | Purpose                                          |
| --------- | ---------------------------- | ------------------------------------------------ |
| GET/PATCH | `/v1/account`                | Profile and compliance declaration               |
| PUT       | `/v1/account/limits`         | Tighten daily limit or begin cooldown            |
| POST      | `/v1/account/self-exclusion` | Timed or indefinite exclusion                    |
| GET       | `/v1/catalog/items`          | Enabled fixed-price targets and reconciled stock |
| GET       | `/v1/inventory`              | User custody lots                                |
| GET       | `/v1/fairness/current`       | Pre-round commitment                             |
| GET       | `/v1/upgrades/config`        | Immutable algorithm and configured odds limits   |
| POST      | `/v1/fairness/verify`        | Public verifier                                  |
| POST      | `/v1/upgrades`               | Atomic item-only upgrade; idempotency required   |
| GET       | `/v1/upgrades/history`       | Private immutable history                        |
| GET       | `/v1/upgrades/recent-wins`   | Redacted public wins                             |
| POST/GET  | `/v1/deposits`               | Create/list deposit intents                      |
| POST/GET  | `/v1/withdrawals`            | Create/list withdrawals                          |
| DELETE    | `/v1/withdrawals/:id`        | Cancel a job before it is leased                 |

## Admin

Admin routes require an admin Minecraft identity configured in `ADMIN_MINECRAFT_IDS`, a matching
SHA-256/8-digit/30-second TOTP secret, and the same session/Origin/CSRF protections as player
mutations. An administrator must include `adminTotpCode` when completing an account-link challenge;
the server atomically rejects reused TOTP counters. Each privileged session is bound to the
fingerprint of the exact TOTP key used at login, so rotating that administrator's configured key
invalidates every session created with the previous key and requires a new account-link login.

There is no public first-admin endpoint. The reviewed one-time bootstrap command is documented in
`infra/README.md`; it requires an already linked/profiled allowlisted identity and an explicit KYC
review confirmation.

| Method | Path                             | Purpose                                               |
| ------ | -------------------------------- | ----------------------------------------------------- |
| POST   | `/v1/admin/catalog-items`        | Add an exact fingerprint and fixed value              |
| PATCH  | `/v1/admin/catalog-items/:id`    | Change fixed value, metadata, or enabled state        |
| GET    | `/v1/admin/observed-items`       | Discover exact fingerprints reported by bot inventory |
| GET    | `/v1/admin/bots`                 | Inspect bot heartbeat and reconciliation status       |
| PATCH  | `/v1/admin/bots/:id/quarantine`  | Quarantine or explicitly release a reconciled bot     |
| GET    | `/v1/admin/users`                | Search users for compliance/support review            |
| GET    | `/v1/admin/jobs`                 | Inspect pending and dead-letter transfer jobs         |
| POST   | `/v1/admin/stock`                | Allocate physically observed bot stock                |
| PATCH  | `/v1/admin/users/:id/compliance` | Record reviewed age/KYC status and activate           |

## Internal bot protocol

| Method | Path                                        | Purpose                                                  |
| ------ | ------------------------------------------- | -------------------------------------------------------- |
| POST   | `/internal/v1/minecraft/events`             | Heartbeat, link, deposit, snapshot, and job-result input |
| POST   | `/internal/v1/minecraft/deposits/authorize` | Recheck a signed player's deposit immediately pre-trade  |
| POST   | `/internal/v1/minecraft/jobs/claim`         | Lease one job with an absolute `leaseExpiresAt`          |

These endpoints must not be internet-routed even though every body is signed and replay protected.
Each request carries `X-Bot-Id`, a 13-digit millisecond `X-Bot-Timestamp`, and an HMAC-SHA256 over
canonical JSON that binds protocol version 2, audience `donut-upgrader-api`, HTTP method, exact
internal route path, bot ID, timestamp, and request body. Every successful response is independently
authenticated by `X-Api-Timestamp` and `X-Api-Signature`; its canonical payload binds the original
request, status code, and response body to audience `donut-upgrader-bot`. Both sides enforce a
60-second clock window and the bot enforces a 64 KiB response limit. Replayed event, authorization,
and claim IDs return only their original stored result.

A deposit command is accepted only from Minecraft's verified raw `playerChat` packet and carries
the server-authenticated player UUID as `mc:<uuid>`. Before opening a trade, the bot calls the
authorization endpoint with that immutable identity, current username, bot ID, and deposit code.
The API rechecks intent expiry, ownership, account eligibility, responsible-play controls, bot
freshness, reconciliation, and the transfer feature gate. The later `deposit_confirmed` event binds
the same UUID and username and rechecks eligibility while recording custody; authorization alone
never credits an item.

An upgrade request supplies `expectedUnitValueMinor` for every stake selection and
`expectedTargetUnitValueMinor` for the target. They are quote bindings, not prices chosen by the
client; the API returns `409 PRICE_CHANGED` unless each string exactly matches the fixed catalog
value locked by the transaction.
