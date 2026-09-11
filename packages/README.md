# Shared backend packages

- `provably-fair` contains the dependency-light RNG commitment, roll, and integer odds algorithm.
- `db/migrations` contains the PostgreSQL source of truth.

Other directories are reserved for future extraction. Packages never import from `apps/` or
`services/`.
