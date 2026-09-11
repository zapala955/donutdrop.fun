# Threat model

| Threat                                          | Primary controls                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Client invents an item or price                 | Bot-originated deposits; exact fingerprint allowlist; fixed server-side prices               |
| Spoofed/replayed bot event                      | Private network; per-bot HMAC identity; 60-second timestamp; unique event journal            |
| Forged API response redirects bot custody       | Signed responses bind audience, route, request, status, and response body                    |
| Spoofed in-game deposit command                 | Verified raw player chat; server UUID; pre-trade authorization; confirmation recheck         |
| Concurrent bots authorize one deposit twice     | Unique append-only deposit lease; hashed 150-second capability; exact replay journal         |
| Double-click or network retry repeats a wager   | User-scoped idempotency key and serializable transaction                                     |
| Concurrent wagers spend the same item           | Row locks on user and inventory lots                                                         |
| House awards inventory it does not possess      | Physical snapshots, custody reconciliation, degraded-bot exclusion                           |
| Duplicate withdrawal after lost acknowledgement | Expired leases enter manual review; no automatic ambiguous retry                             |
| Username reuse or spoofed login                 | In-game proof plus server-observed UUID; no username-only identity fallback                  |
| Command injection through a username            | Minecraft username regex; no configurable shell or chat command templates                    |
| Server chooses RNG after seeing the stake       | Client submits the previously displayed seed commitment; reveal and rotation are atomic      |
| Floating-point odds or price drift              | PostgreSQL bigint values and integer probability math; per-round snapshots                   |
| Browser CSRF/session theft                      | Opaque hashed sessions, signed secure cookies, SameSite, exact Origin, CSRF hash             |
| Privileged tampering                            | Active admin gate, replay-safe TOTP, MFA-key-bound sessions, ordered HMAC audit checkpoints  |
| Gambling by restricted account                  | Transactional account, country, age, cooldown, self-exclusion, and daily-limit gates         |
| Telemetry growth or journal-evidence deletion   | Bounded fixed-policy pruning; durable custody/identity events excluded; protected snapshots  |
| Forged API failure steers bot retry handling    | Failures to an authenticated bot are signed; the bot verifies before reading the status      |
| Compromised bot reports a delivered job failed  | Cancellation is limited to jobs no bot has ever claimed; snapshot reconciliation quarantines |
| Error response maps the accepted request shape  | Schema issues are logged server-side; only a stable code and message reach the caller        |
| Sibling subdomain overwrites the CSRF cookie    | `__Host-` prefix on every browser cookie; CSRF header verified against the session row hash  |

Residual risks requiring operations or external review include malicious database administrators,
compromised bot accounts, errors in a future server-specific transfer adapter, DonutSMP protocol or
rule changes, DDoS at the network edge, and jurisdiction-specific legal requirements.

## Single-actor administration

Catalog prices and house stock are changed by one authenticated administrator. Every such change is
MFA-gated, idempotency-keyed, and written to the hash-chained audit log with a mandatory reason, so
it is attributable and tamper-evident after the fact — but it is not prevented at the time. A
compromised administrator session can therefore reprice an item or mint stock until the action is
noticed.

Four-eyes approval is the control that would close this. It is **an accepted risk, not an
oversight**: the control requires at least two staffed administrators and a documented path for
when the second is unavailable, and with a single operator it adds no real separation of duties
while making routine price maintenance impossible. Detection therefore rests on the audit chain,
which is append-only at the database-privilege level and verified by the signed checkpoint job.

Revisit this decision when a second administrator is onboarded, before accepting deposits from
users outside a closed test group, or if any jurisdiction in `ALLOWED_COUNTRIES` requires
segregation of duties over house inventory. The implementation would be a pending-action table
plus an approval route on the two value-bearing admin endpoints, gated so a single-operator
deployment is unaffected.

## Dependency advisories

`npm audit --omit=dev` reports six moderate advisories that all resolve to one root cause:
GHSA-w5hq-g745-h8pq in `uuid` below 11.1.1, reached through
`mineflayer -> minecraft-protocol -> prismarine-auth -> @azure/msal-node`.

The advisory is a missing buffer bounds check that is only reachable when `v3`, `v5`, or `v6` is
called with an explicit `buf` argument. The single call site in this tree,
`prismarine-auth/src/TokenManagers/XboxTokenManager.js`, passes no buffer, so the vulnerable branch
is not reachable from this application.

The remediation npm proposes is `mineflayer@1.4.0`, a major downgrade from the installed 4.39.0
that would remove the secure-chat verification this system's entire identity model depends on. That
trade is strictly negative and must not be applied. Forcing `uuid` through a dependency override
was also rejected: it would move a transitive Microsoft authentication dependency across a major
version that no test here exercises, to fix a branch that is never executed.

Re-evaluate if `prismarine-auth` starts passing a buffer to those generators, if the advisory is
re-scored above moderate, or once `mineflayer` ships a release carrying a patched `uuid`. CI gates
at `--audit-level=high`, so this set does not fail the build.
