# Maintenance and retention runbook

The `maintenance` service runs immediately after migrations and then hourly. A successful run emits
one JSON line with unleased expired-deposit counts, authorization-expiry manual-review counts, job
lease counts, authentication cleanup counts, and telemetry deletion counts.
`{"status":"skipped"}` is normal when another instance owns the advisory lock; repeated skips
without a successful run require investigation.

## Retention invariants

- The application login cannot directly delete `inbound_bot_events` or
  `bot_inventory_snapshots`.
- The security-definer pruning function has a fixed search path, 30-day cutoff, and 25,000-row
  limit per table and run.
- Only heartbeat events, inventory-snapshot events, empty job claims, and superseded snapshots can
  be removed.
- The newest snapshot and newest mismatching snapshot for each bot, plus their journal events, are
  always retained.
- Link confirmations, deposit authorizations and confirmations, job results, and non-empty job
  claims remain append-only.
- A pending deposit with no authorization lease can expire normally. Once a lease exists, expiry of
  either the lease or intent sends the deposit to `manual_review`; the lease is never deleted or
  renewed because item custody may already have changed.

After any migration or restore, run the PostgreSQL integration suite and verify that the runtime
login still receives SQLSTATE `42501` for direct telemetry deletion while
`public.donut_prune_bot_telemetry()` succeeds. Compare deletion-count trends with bot traffic and
alert on abrupt increases, persistent zero counts despite known old telemetry, or maintenance
failures.

Do not bypass the retention triggers, grant table DELETE, or edit old journal rows to recover a
failed run. Fix the maintenance configuration or database capacity, preserve relevant logs, and
rerun the one-shot maintenance command under the restricted runtime credential. A legal hold or a
different retention period requires a reviewed migration and compliance approval; it is not a
runtime setting.
