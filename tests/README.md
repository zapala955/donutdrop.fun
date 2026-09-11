# tests/

Cross-cutting tests that span more than one service. Unit tests live beside each backend package.

| Folder         | Scope                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| `e2e/`         | Full journeys through a real deployment: link, deposit, upgrade, and withdraw.      |
| `integration/` | Bot-event, custody-lot, immutable-ledger, and service-wiring contracts.             |
| `load/`        | Concurrent round, snapshot, deposit, and transfer-job performance and soak testing. |
| `fixtures/`    | Shared test vectors, mock provider responses, and isolated test identities.         |
