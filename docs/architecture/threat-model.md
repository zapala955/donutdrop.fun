# Threat model

| Threat                                          | Primary controls                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Client invents an item or price                 | Bot-originated deposits; exact fingerprint allowlist; fixed server-side prices              |
| Spoofed/replayed bot event                      | Private network; per-bot HMAC identity; 60-second timestamp; unique event journal           |
| Forged API response redirects bot custody       | Signed responses bind audience, route, request, status, and response body                   |
| Spoofed in-game deposit command                 | Verified raw player chat; server UUID; pre-trade authorization; confirmation recheck        |
| Concurrent bots authorize one deposit twice     | Unique append-only deposit lease; hashed 150-second capability; exact replay journal        |
| Double-click or network retry repeats a wager   | User-scoped idempotency key and serializable transaction                                    |
| Concurrent wagers spend the same item           | Row locks on user and inventory lots                                                        |
| House awards inventory it does not possess      | Physical snapshots, custody reconciliation, degraded-bot exclusion                          |
| Duplicate withdrawal after lost acknowledgement | Expired leases enter manual review; no automatic ambiguous retry                            |
| Username reuse or spoofed login                 | In-game proof plus server-observed UUID; no username-only identity fallback                 |
| Command injection through a username            | Minecraft username regex; no configurable shell or chat command templates                   |
| Server chooses RNG after seeing the stake       | Client submits the previously displayed seed commitment; reveal and rotation are atomic     |
| Floating-point odds or price drift              | PostgreSQL bigint values and integer probability math; per-round snapshots                  |
| Browser CSRF/session theft                      | Opaque hashed sessions, signed secure cookies, SameSite, exact Origin, CSRF hash            |
| Privileged tampering                            | Active admin gate, replay-safe TOTP, MFA-key-bound sessions, ordered HMAC audit checkpoints |
| Gambling by restricted account                  | Transactional account, country, age, cooldown, self-exclusion, and daily-limit gates        |
| Telemetry growth or journal-evidence deletion   | Bounded fixed-policy pruning; durable custody/identity events excluded; protected snapshots |

Residual risks requiring operations or external review include malicious database administrators,
compromised bot accounts, errors in a future server-specific transfer adapter, DonutSMP protocol or
rule changes, DDoS at the network edge, and jurisdiction-specific legal requirements.
