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
| GET    | `/v1/cases`                         | Enabled cases and exact weighted pools    |
| GET    | `/v1/activity/recent`               | Redacted case and upgrader wins           |
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
| POST      | `/v1/inventory/:id/sell`     | Sell a custody lot at the locked server quote    |
| GET       | `/v1/balance`                | Current server wallet balance                    |
| GET       | `/v1/balance/transactions`   | Append-only private wallet history               |
| GET       | `/v1/fairness/current`       | Pre-round commitment                             |
| POST      | `/v1/cases/:id/open`         | Atomic server-weighted case open; idempotent     |
| GET       | `/v1/cases/history`          | Private case history and fairness evidence       |
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
`infra/README.md`; it requires an already linked, allowlisted identity and an explicit confirmation.

The web console at `/admin/` exposes all safe runtime operations. Every mutation that changes
money, content, moderation, rewards, custody allocation, or bot state requires a reason and writes
to the hash-chained audit log. Admin identities, MFA keys, database credentials, proxy policy, and
other trust roots remain deployment-managed and are intentionally read-only in the console.

| Area       | Routes                                                                                                 | Runtime management                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Dashboard  | `GET /v1/admin/overview`, `/system-config`                                                             | Platform totals, attention queues, redacted effective configuration                                     |
| Players    | `GET /users[/:id]`, `PATCH /users/:id/status`, `POST /users/:id/{balance,sessions/revoke}`             | Search, suspend/close/reactivate, credit/debit, revoke sessions, inspect turnover and ledger            |
| Economy    | `GET /economy`, `/cash-withdrawals`; payout decision and resolution routes                             | Ledger, receipts, approvals, rejections, and human resolution of ambiguous payouts                      |
| Catalog    | `GET/POST/PATCH /catalog-items`, `GET /observed-items`, `/inventory`, `POST /stock`, `/catalog-ladder` | Create/reprice/enable items, inspect bot observations and lots, allocate verified stock                 |
| Cases      | `GET/POST/PATCH /cases[/:id]`                                                                          | Create, price, publish, replace weighted pools, moderate community cases, and set creator royalty       |
| Bots       | `GET /bots`, `PATCH /bots/:id/quarantine`, bot reconnect/pay routes, `GET /payouts`                    | Health, reconciliation, quarantine/release, reconnect, operator payouts                                 |
| Jobs       | `GET /jobs`, `POST /jobs/:id/retry`                                                                    | Queue visibility and safe retry of idempotent control jobs; value-bearing jobs require human resolution |
| Moderation | `GET /moderation`; `/v1/chat/:id` and `/v1/chat/timeouts` mutations                                    | Message removal, chat timeouts, early lifts, complete history                                           |
| Programs   | Creator decision, Lava Rain, race CRUD/settlement, quest CRUD routes                                   | Creator applications/codes/revshare, promotions, wager races, daily quest definitions                   |
| Audit      | `GET /v1/admin/audit`                                                                                  | Search actors, actions, targets, details, and chain hashes                                              |

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

A case-open request similarly binds `expectedPriceMinor`, the active `serverSeedHash`, and a client
seed. The server locks the enabled pool and verifies that every published outcome has enough fresh,
reconciled, transfer-capable house stock before deducting balance. It maps the full 256-bit HMAC
digest into the integer sum of server-configured weights, records an immutable pool snapshot and
fairness proof, transfers the selected custody lot, writes the wallet debit, and rotates the seed in
one serializable transaction. A stock failure rolls the entire operation back.

Item sale requests bind both the current catalog value (`expectedUnitValueMinor`) and the displayed
sell-rate quote (`expectedSellRateBps`), but never submit proceeds. The server applies its own
`ITEM_SELL_RATE_BPS`, moves the selected custody quantity to house ownership, credits the wallet,
and records both append-only custody and wallet entries atomically. There is intentionally no player
endpoint that sets a balance directly.
