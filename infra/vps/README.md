# Deploying Donut Drop to `donutdrop.fun`

The production layout is deliberately one origin:

```text
Internet -> Caddy :443 -> 127.0.0.1:8080 -> container nginx
                                             |-> static frontend
                                             `-> /v1 and /health -> API
```

PostgreSQL and Redis have no published ports. The API is reachable only from Docker's private
networks, and `/internal/` is rejected by the public nginx edge. Its separate egress bridge is used
for DonutSMP balance verification but publishes no port. Caddy owns certificates and the
HTTP-to-HTTPS redirect. Do not publish container port 8080 on a non-loopback address.

## 1. VPS and DNS

Use a supported Linux VPS with at least 4 GB RAM, Docker Engine, the Docker Compose plugin, Git,
Curl, OpenSSL, and Caddy. Point the `A` records for `donutdrop.fun` and `www.donutdrop.fun` to the
VPS. Add `AAAA` records only when the VPS really accepts IPv6 traffic. Allow inbound TCP 22, 80,
and 443; keep 3001, 5432, 6379, and 8080 closed publicly.

Clone only the canonical repository:

```bash
sudo install -d -o "$USER" -g "$USER" /opt/donutdrop
git clone https://github.com/zapala955/donutdrop.fun.git /opt/donutdrop/app
cd /opt/donutdrop/app
```

## 2. Production settings and secrets

Create the non-secret environment file:

```bash
sudo install -d -m 0700 /opt/donutdrop/shared
sudo cp infra/vps/donutdrop.env.example /opt/donutdrop/shared/donutdrop.env
sudo chmod 0600 /opt/donutdrop/shared/donutdrop.env
sudoedit /opt/donutdrop/shared/donutdrop.env
```

Set the real bot UUID, Microsoft login identifier, exact Minecraft username, country allowlist,
and any reviewed feature flags. `APP_ORIGIN` must remain exactly `https://donutdrop.fun`.

`GAME_CURRENCY_ONLY=true` disables the country, age, terms, and KYC profile for deployments that
use only DonutSMP game currency. Suspensions, closed accounts, cooldowns, and self-exclusion still
apply. Set it to `false` before integrating any currency or item with off-server monetary value.

Generate the secret files once. This command does not print any generated value:

```bash
sudo BOT_ID='replace-with-bot-uuid' \
  BOT_USERNAME='ReplaceWithBotName' \
  AUDIT_LOG_KEY_ID='prod-v1' \
  ./infra/vps/prepare-secrets.sh
```

The script prompts for the DonutSMP API key without echoing it.

The generated secret directory is root-owned with mode `0700`. Individual files are read-only but
world-readable _inside their dedicated container mount_ because local Docker Compose preserves
host ownership for file-backed secrets and the services run under different non-root UIDs. The
root-only parent directory prevents other VPS users from traversing to those files on the host.
Do not loosen the directory permissions.

The script refuses to overwrite an existing secret directory. Back up
`/opt/donutdrop/shared/secrets` to an encrypted secret store before continuing. Losing the data
encryption key or audit keys makes recovery incomplete; exposing the cookie, bot, or database
keys is a credential incident.

## 3. TLS proxy

Install the checked-in Caddy configuration and validate it before reloading:

```bash
sudo cp infra/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews certificates automatically after DNS points at the VPS and ports 80/443
are reachable. Its upstream is loopback-only nginx; nginx serves the frontend and API on the same
host so strict cookies, CSRF origin validation, and WebSockets all agree on one origin.

## 4. First deploy

```bash
sudo COMPOSE_ENV_FILE=/opt/donutdrop/shared/donutdrop.env ./infra/vps/deploy.sh
```

The first Minecraft-bot start may require Microsoft device authentication. Follow only the URL
and code emitted by the dedicated bot container, then confirm that its auth files were written to
`/opt/donutdrop/shared/minecraft-auth`:

```bash
sudo docker compose --env-file /opt/donutdrop/shared/donutdrop.env \
  -f infra/docker/compose.yml logs -f minecraft-bot
```

Verify both the private hop and the public domain:

```bash
curl --fail http://127.0.0.1:8080/health/ready
curl --fail https://donutdrop.fun/health/ready
curl --fail --head https://donutdrop.fun/
curl --fail --head https://www.donutdrop.fun/
```

The API is intentionally single-instance while the in-memory Slither arena is enabled. Do not
scale the `api` service horizontally without first extracting or externally coordinating that
simulation.

## 5. Updates

Deploy only committed code from `main`, and refuse non-fast-forward updates:

```bash
cd /opt/donutdrop/app
git fetch origin
git pull --ff-only origin main
sudo COMPOSE_ENV_FILE=/opt/donutdrop/shared/donutdrop.env ./infra/vps/deploy.sh
```

The migrator is a one-shot dependency and applies each checksummed migration before the API is
allowed to start. The readiness route is pinned to the newest schema marker. Static assets use
revalidation because their filenames are not content-hashed, so a deploy cannot strand browsers
on a week-old JavaScript file.

## Launch gates that deployment cannot automate

A clean production database intentionally has an empty item and case catalogue. Direct production
seeding is blocked because it would bypass the authenticated audit log. Bootstrap the first
administrator as described in [`../README.md`](../README.md), then create and review the catalogue
through the admin API before accepting players.

The bundled Minecraft transfer adapter remains disabled; the provided production template uses
cash-only play and cannot custody deposits or withdrawals. Do not change that flag until an atomic
DonutSMP transfer adapter has been implemented and independently reviewed.

Before real money or valuable in-game currency is accepted, complete the legal/compliance launch
gates, configure encrypted off-host PostgreSQL backups plus point-in-time recovery, publish audit
checkpoints outside the VPS, run a restore drill, and configure monitoring. See
[`../../docs/compliance/launch-gates.md`](../../docs/compliance/launch-gates.md) and the main
infrastructure runbook.
