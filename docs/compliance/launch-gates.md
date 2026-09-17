# Production launch gates

This repository provides technical controls, not a determination that operating an item-wagering
service is lawful or permitted. Do not enable wagering in production until counsel and the server
operator have reviewed the exact business and custody model.

The current build is English-only and includes a server-ledger frontend. It contains no CS2/Steam
integration, or catalog items. Both transfer feature flags are forced off and the placeholder
adapter refuses every handoff.

Required before launch:

- Written confirmation that the service and bot comply with DonutSMP rules, Minecraft/Microsoft
  terms, and every applicable gambling or prize-game law.
- Jurisdiction allowlist backed by reliable geolocation at the edge, sanctions screening where
  required, verified minimum age, terms/version evidence, privacy notice, retention schedule, and a
  process for data access/deletion requests.
- Independently tested responsible-play controls, self-exclusion handling, customer support,
  complaints/disputes, and recovery of items held for excluded or suspended users.
- Independent review of odds presentation, fixed-price fairness, bot custody segregation, seed/key
  management, disaster recovery, dependency security, and penetration testing.
- Monitoring and human approval procedures for reconciliation mismatches, ambiguous handoffs,
  high-value withdrawals, dead-letter jobs, and privileged catalog changes.
- A reviewed data-retention policy for durable identity/custody records, external audit checkpoints,
  encrypted backups, and the fixed 30-day non-custody telemetry window. Verify pruning and legal-hold
  behavior against that policy before production.

The API deliberately requires administrator age verification before an account becomes active.
Country declaration is not a substitute for edge geolocation, and the included placeholder transfer
adapter must remain disabled until the exact live-server transfer mechanism, verified-chat behavior,
UUID binding, and final inventory-delta checks are tested against the live DonutSMP server.
