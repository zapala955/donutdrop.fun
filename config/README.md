# config/

Per-environment, non-secret application configuration.

| Folder         | Used by                          |
| -------------- | -------------------------------- |
| `development/` | Local and shared development.    |
| `staging/`     | Pre-production, production-like. |
| `production/`  | Live.                            |

## Rules

- Store only endpoints, timeouts, feature defaults, limits, and log levels here.
- Load secrets from the deployment secret store, never from this tree.
- Keep the key set identical across environments; only values differ.
- The checked-in development catalog is deliberately an empty JSON array.
