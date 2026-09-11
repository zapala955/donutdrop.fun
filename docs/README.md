# docs/

Written knowledge. Write the doc before the code where it matters.

| Folder          | Contents                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture/` | System overview, context diagrams, data flow, service boundaries, tech-stack decisions.                                                                                                      |
| `adr/`          | Architecture Decision Records — one file per decision, dated, immutable once accepted.                                                                                                       |
| `api/`          | API reference — REST endpoints, WebSocket events, error catalog, versioning policy.                                                                                                          |
| `upgrader/`     | Game spec — win-chance formula (stake ÷ target value), house-edge model, min/max multiplier, item locking, win/lose resolution, **provably-fair** commit/reveal scheme + verification steps. |
| `compliance/`   | Licensing, age/jurisdiction checks, responsible-gaming requirements, Minecraft item custody and payout policy, data retention, audit obligations.                                            |
| `runbooks/`     | On-call procedures — bot farm down, stuck trade offers, price-feed stale, payout freeze, reconciliation, incident response.                                                                  |
| `onboarding/`   | New-engineer setup, local dev, conventions, glossary.                                                                                                                                        |
