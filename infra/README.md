# Deployment infrastructure

The Compose deployment separates public proxy traffic, PostgreSQL, Redis, bot control traffic, API
egress, and bot internet egress. PostgreSQL and Redis cannot reach one another and have no external
network. The API and Mineflayer containers have separate outbound bridges and neither has a
published application port; the Mineflayer container cannot reach either data network.

For the exact `donutdrop.fun` VPS topology, first-deploy commands, TLS configuration, and update
procedure, use [`vps/README.md`](vps/README.md). The Compose nginx bind-mounts the checked-in
frontend read-only and exposes only `127.0.0.1:8080` for the host TLS proxy.

Images and GitHub Actions are pinned to reviewed immutable digests. Update a version and digest
together only after reviewing its upstream release notes.

## Secrets and database roles

Create an ignored `.secrets/` directory at the repository root. Secret key, password, URL, and JSON
files must contain exactly one non-empty line. `redis.conf` is the sole multi-line exception. Use
restrictive host permissions and independently generated values; never deploy the example values.

Required PostgreSQL files:

- `postgres-superuser-password`: bootstrap/emergency password. It is mounted only into PostgreSQL.
- `postgres-migrator-password`: password for the non-superuser schema owner `donut_migrator`.
- `postgres-runtime-password`: different password for `donut_api_login`.
- `postgres-audit-password`: different password for the read-only `donut_audit_login`.
- `migration-database-url`: `postgresql://donut_migrator:<encoded-password>@postgres:5432/donut_upgrader`.
- `api-database-url`: `postgresql://donut_api_login:<encoded-password>@postgres:5432/donut_upgrader`.
- `audit-database-url`: `postgresql://donut_audit_login:<encoded-password>@postgres:5432/donut_upgrader`.

The one-time bootstrap creates separate group roles. The API can update operational tables but
cannot own or alter schema and cannot mutate/delete append-only records. The audit verifier can
select only `audit_log`. The migration role owns the application database but is not a cluster
superuser and cannot create roles or databases.

Other required files:

- `redis.conf`: reviewed configuration containing `bind 0.0.0.0`, `protected-mode yes`, one
  `requirepass <random-password>` line, and an appropriate `maxmemory` policy.
- `api-redis-url`: `redis://:<encoded-password>@redis:6379/0` using that Redis password.
- `api-cookie-secret`, `api-audit-hmac-key`, and `api-ip-hash-key`: distinct random values of at
  least 32 characters.
- `api-donutsmp-api-key`: the private key created with `/api` in game. It is required for the
  payment-login balance check and is mounted only into the API.
- `api-data-encryption-key`: exactly 32 random bytes in canonical base64.
- `api-bot-credentials.json`: one-line JSON mapping each provisioned bot UUID to an object containing
  its independent 32-byte canonical-base64 `secret`, exact `serverHost`, and exact in-game
  `username`. Heartbeats and link confirmations fail closed if that identity changes.
- `api-admin-totp-secrets.json`: one-line JSON mapping every identity in `ADMIN_MINECRAFT_IDS` to a
  distinct canonical RFC 4648 base32 secret (20-64 bytes, uppercase, no padding). Configure the
  authenticator for SHA-256, eight digits, and a 30-second period. Use `{}` when there are no admins.
- `audit-verification-keys.json`: one-line JSON mapping every retained audit key ID to its secret.
  Keep old keys during rotation; use `legacy-v1` only for rows created before migration 002.
- `audit-checkpoint-hmac-key`: an independent random value of at least 32 characters. It is never
  mounted into the API or bot.
- `bot-webhook-secret`: only the key belonging to `BOT_ID`; it must match the API credential map.

Set `BOT_AUTH_DIRECTORY` to an existing directory on an encrypted host filesystem, owned so the
container's unprivileged UID can write it. It stores Microsoft device-auth tokens and must not be a
normal unencrypted Docker volume or source-controlled directory. Use a dedicated low-privilege
Microsoft/Minecraft account because the bot necessarily has outbound access to Microsoft and
DonutSMP.

For a new empty deployment, run from the repository root:

```text
docker compose --env-file .env -f infra/docker/compose.yml up --build
```

The Mineflayer bot starts by default. The PostgreSQL bootstrap marker prevents migrations from
racing the role setup. Initialization scripts run only for a new database volume. Do not point this
Compose file at a volume created by the earlier configuration where `donut_migrator` was the
cluster superuser. Back it up and have a PostgreSQL administrator migrate/demote the roles or restore
into a freshly bootstrapped volume; never delete a production volume merely to rerun initialization.

The maintenance container starts by default, runs immediately, and repeats hourly under the
restricted API database role. Authentication garbage is removed after its safety window, and bot
heartbeats, inventory-snapshot journal rows, empty job polls, and superseded snapshots are pruned in
bounded batches after 30 days. The newest snapshot and newest mismatch for each bot are always
retained. Identity links, deposit decisions/confirmations, job results, and non-empty job claims are
not retention-deletable. The runtime login has no direct telemetry DELETE grant; maintenance can
invoke only the fixed-policy security-definer function. Alert on maintenance container restarts or
failures. See `docs/runbooks/maintenance-retention.md` for verification and recovery steps.

## First administrator bootstrap

Before the first account link, put the administrator's immutable `mc:` UUID in
`ADMIN_MINECRAFT_IDS` and add the same identity to `api-admin-totp-secrets.json`. Link that account,
provide the eight-digit TOTP code to `/v1/auth/link/complete`, and complete its country, birth-date,
and terms profile. After an operator independently reviews KYC, run exactly once:

```text
docker compose --env-file .env -f infra/docker/compose.yml exec api node --enable-source-maps services/api-gateway/dist/scripts/bootstrap-admin.js --identity=mc:<32-lowercase-hex-digits> --confirm-kyc-reviewed
```

The command uses the restricted runtime role, serializes bootstrap attempts, refuses a second active
administrator, checks age/country/exclusion state, revokes sessions, and appends `admin.bootstrap`
to the audit chain. The administrator must link again after it succeeds. Later compliance reviews
must use the authenticated admin API.

Nginx is bound to host loopback. Terminate TLS at a trusted host proxy. That proxy must discard
incoming forwarding headers and set one `X-Forwarded-For` value to its verified client address.
Nginx trusts that header only from the fixed `172.29.0.1` Docker gateway, then overwrites the headers
sent to Fastify. If the public Docker subnet must change, update both Compose and
`infra/nginx/nginx.conf` in the same reviewed change.

## Audit verification and external anchoring

Run the isolated verifier after each deployment and on a schedule:

```text
docker compose --env-file .env -f infra/docker/compose.yml --profile ops run --rm audit-checkpoint
```

It verifies every HMAC, key version, predecessor, and sequence in a repeatable-read snapshot, then
emits an independently signed JSON checkpoint. Send each output line to an immutable external log
or write-once object store. Alert if `headSequenceNo` decreases or the hash changes for an already
published sequence. Keeping checkpoints beside PostgreSQL does not protect against a database-owner
compromise.

## Transfer launch gate

Both `MINECRAFT_TRANSFERS_ENABLED` and `BOT_TRANSFERS_ENABLED` remain forced to `false`, and the
bundled adapter refuses transfers. Account linking and inventory observation work, but deposits and
withdrawals fail closed until a DonutSMP-specific atomic transfer adapter is implemented, reviewed,
and explicitly wired into both processes. Rotate a quarantined bot's credential before using the
admin release API. The initial catalog is empty; this deployment adds no items.

Compose isolates bot control traffic, but a Docker bridge is not a destination allowlist. Before
enabling any transfer adapter, enforce bot egress at the host firewall or a dedicated egress proxy,
allowing only the reviewed Microsoft authentication endpoints, DNS/NTP dependencies, and the
configured DonutSMP endpoint. Deny access to cloud metadata and private management networks.

The API also needs outbound HTTPS for payment-login balance verification against
`api.donutsmp.net` (and for Discord OAuth/webhooks if those optional features are enabled). Apply
the same host-firewall or dedicated-proxy policy to `API_EGRESS_NETWORK_CIDR`; in particular, deny
cloud metadata and private management ranges. Removing API egress disables payment login.

## Backup launch gate

The local PostgreSQL volume is not a backup. Before production, configure encrypted off-host base
backups plus WAL archiving/PITR, retention, restore credentials separated from the application, and
scheduled restore drills. Keep audit checkpoints outside that backup trust boundary. Production is
not ready until a restore has been successfully tested.
