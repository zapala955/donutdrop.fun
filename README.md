# Donut Upgrader backend

Backend-only implementation for a DonutSMP Minecraft-item upgrader. There is no frontend code, no
cash wallet, and no CS2/Steam inventory integration. The repository intentionally ships with an
empty catalog, so no item can be deposited, wagered, or awarded until an administrator explicitly
adds an observed Minecraft fingerprint and fixed price through the API.

Players prove account control in game. Once the separately reviewed transfer adapter is available,
allowlisted physical items can be held by a Mineflayer custody bot, wagered as inventory lots, and
exchanged for existing house stock on a win. Prices are fixed integer valuation units controlled by
the server; clients must bind each request to the exact current price.

## Services

- `services/api-gateway` - English Fastify REST API, authentication, compliance controls, fixed
  catalog, custody accounting, idempotent transfers, admin operations, and atomic upgrades.
- `services/minecraft-bot` - isolated Mineflayer worker for in-game identity proof, exact item
  fingerprints, inventory reconciliation, and durable transfer jobs.
- `packages/provably-fair` - HMAC-SHA256 commitments, deterministic rolls, and integer-only odds.
- `packages/db/migrations` - PostgreSQL schema and append-only custody, game, event, and audit data.

## Security properties

- Opaque hashed sessions use signed `HttpOnly`, `Secure`, `SameSite=Strict` cookies. Browser
  mutations also require the exact configured Origin and a session-bound CSRF token.
- Administrator login additionally requires replay-protected TOTP; privileged sessions are bound
  to the exact MFA-key fingerprint and fail closed after key rotation.
- Link codes are one-time, browser-bound, assigned to one bot, and confirmed with a server-observed
  Minecraft UUID. Username recycling revokes the former owner's sessions.
- Every bot has an independent 256-bit HMAC key. Request and response signatures bind both
  audiences, HTTP method, exact route, bot ID, timestamps, status, and canonical bodies; event IDs
  make retries idempotent. Quarantine is sticky and invalidates in-flight jobs.
- Fixed-price fingerprints include stable Minecraft item identity, metadata, NBT, and components.
  Unknown physical inventory or count mismatches quarantine the custody bot.
- Serializable transactions and row locks atomically consume stakes, reserve real target stock,
  record custody movement, resolve the roll, and rotate the committed seed.
- Server seeds are encrypted with AES-256-GCM. Commitments are available before play, while the
  seed, digest, and roll are stored in the immutable resolved round.
- Active status, allowed country, adult/age review, verified KYC, terms, cooldown, self-exclusion,
  and daily wager limits are rechecked inside the wager transaction.
- Migration, API runtime, and audit verification use separate PostgreSQL identities. HMAC-chained
  audit rows have database-enforced order and can be externally anchored with signed checkpoints.

## Local verification

Requirements are Node.js 22.23.2+ and PostgreSQL 17 for database integration tests.

```text
npm ci --ignore-scripts
npm run typecheck
npm test
npm run lint
npm run build
```

Copy `.env.example` to `.env` only for local development and replace its deterministic sample
values. Run `npm run db:migrate` with a migration-owner database URL, then `npm run dev`. The API and
bot are separate processes and must never share a secret file or database credential.

`npm run db:seed` confirms that the checked-in catalog is empty and refuses non-empty direct seeds,
because catalog changes must go through the authenticated, audited admin API.

## Physical transfers

The bundled transfer adapter is deliberately disabled. DonutSMP does not provide a documented
atomic player-to-player item API, and using dropped items would permit theft and ambiguous credits.
Account linking and inventory observation work now; deposits, withdrawals, and upgrades that depend
on transfer-capable custody fail closed.

Before transfer launch, implement the narrow `TransferAdapter` against the current DonutSMP trade
flow. It must serialize transfers and verify player UUID, item fingerprint, quantity, both
confirmation states, and the final inventory delta. Deposit initiation must remain limited to
server-verified raw player chat and must pass the signed API authorization immediately before the
handoff. Independent review and the legal/operational launch gates in
`docs/compliance/launch-gates.md` remain required.

API behavior is documented in `docs/api/backend.md`; deployment and secrets are documented in
`infra/README.md`.
