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

## 6. Discord control plane (optional)

The admin dashboard has no password. The only way in is a one-time link minted by a Discord slash
command, so approving a held payout means running the Discord bot.

Create the application at <https://discord.com/developers/applications> and invite it to exactly one
guild. Then find the platform identity the operator will act as — the `mc:` value, not a username,
because usernames are reassignable:

```bash
cd /opt/donutdrop/app
sudo docker compose --env-file /opt/donutdrop/shared/donutdrop.env \
  -f infra/docker/compose.yml exec -T postgres \
  psql -qtAX -U postgres -d donut_upgrader \
  -c "SELECT minecraft_identity FROM users WHERE normalized_username = lower('YOUR_MC_NAME')"
```

Write the Discord secrets with the script that adds them to an existing deployment.
`prepare-secrets.sh` is not the one to use here: it mints every credential the platform owns and
refuses to run twice, because a second run would rotate the database passwords and the bot webhook
secret out from under a live stack.

```bash
sudo DISCORD_BOT_TOKEN='paste-the-token-here' \
     DISCORD_OPERATORS_JSON='{"YOUR_DISCORD_USER_ID":"mc:the-identity-from-above"}' \
     ./infra/vps/prepare-discord-secrets.sh
```

Re-running it is safe. Anything already on disk is kept unless a new value is passed, so rotating
the token later cannot blank the allowlist or change the HMAC key the gateway and bot share.

On a brand-new deployment `prepare-secrets.sh` writes these three files itself, and this step is
only needed to fill in real values.

One entry in `DISCORD_OPERATORS_JSON` means one operator. Nobody else can mint an admin link, in
that guild or any other.

Then set in `/opt/donutdrop/shared/donutdrop.env`. `ADMIN_MINECRAFT_IDS` is the one that is easy
to miss: the operator has to be an administrator in its own right, and the gateway refuses to boot
if a Discord mapping points at an identity that is not listed there. A Discord mapping is
permission to *use* an administrator identity, never permission to become one.

```
ADMIN_MINECRAFT_IDS=mc:the-identity-from-above
DISCORD_CONTROL_ENABLED=true
DISCORD_APPLICATION_ID=<application id>
DISCORD_GUILD_ID=<the one guild the bot is pinned to>
```

Register the slash commands once, then bring the profile up:

```bash
# The compiled registrar ships inside the image, so this needs no Node on the host.
sudo docker compose --env-file /opt/donutdrop/shared/donutdrop.env   -f infra/docker/compose.yml --profile discord run --rm discord-bot   node services/discord-bot/dist/scripts/register-commands.js
sudo docker compose --env-file /opt/donutdrop/shared/donutdrop.env \
  -f infra/docker/compose.yml --profile discord up -d --build
```

The bot sits behind the `discord` compose profile, so an ordinary `deploy.sh` leaves it untouched
unless `--profile discord` is passed. The token never belongs in the repository or in
`donutdrop.env`: it is read from `/opt/donutdrop/shared/secrets/discord-bot-token`, mounted
read-only, and a token that has been pasted anywhere else should be regenerated before use.

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
