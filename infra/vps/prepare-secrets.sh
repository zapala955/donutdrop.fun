#!/usr/bin/env bash
set -euo pipefail

# Run once on the VPS as root. Required values are deliberately supplied by the operator rather
# than inferred from development files or written to shell history by this script.
: "${BOT_ID:?Set BOT_ID to the provisioned bot UUID}"
: "${BOT_USERNAME:?Set BOT_USERNAME to the exact in-game bot username}"

if [[ ! "$BOT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  echo "BOT_ID is not a valid UUID" >&2
  exit 1
fi
if [[ ! "$BOT_USERNAME" =~ ^[A-Za-z0-9_]{3,16}$ ]]; then
  echo "BOT_USERNAME is not a valid Minecraft username" >&2
  exit 1
fi
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root so the secret and bot-auth permissions are correct" >&2
  exit 1
fi
if [[ -z "${DONUTSMP_API_KEY:-}" ]]; then
  read -rsp 'DonutSMP API key: ' DONUTSMP_API_KEY
  echo
fi
if [[ -z "$DONUTSMP_API_KEY" || "$DONUTSMP_API_KEY" == *$'\n'* || "$DONUTSMP_API_KEY" == *$'\r'* ]]; then
  echo "DONUTSMP_API_KEY must be one non-empty line" >&2
  exit 1
fi

state_dir="${DONUTDROP_STATE_DIR:-/opt/donutdrop/shared}"
secret_dir="$state_dir/secrets"
auth_dir="$state_dir/minecraft-auth"
audit_key_id="${AUDIT_LOG_KEY_ID:-prod-v1}"

if [[ ! "$audit_key_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ || "$audit_key_id" == 'legacy-v1' ]]; then
  echo "AUDIT_LOG_KEY_ID is invalid or reserved" >&2
  exit 1
fi

if [[ -e "$secret_dir" ]]; then
  echo "$secret_dir already exists; refusing to overwrite production secrets" >&2
  exit 1
fi

umask 077
install -d -m 0700 "$secret_dir" "$auth_dir"

random_hex() { openssl rand -hex 32; }
random_base64() { openssl rand -base64 32 | tr -d '\n'; }
write_one() { printf '%s' "$2" > "$secret_dir/$1"; }

postgres_superuser_password="$(random_hex)"
postgres_migrator_password="$(random_hex)"
postgres_runtime_password="$(random_hex)"
postgres_audit_password="$(random_hex)"
redis_password="$(random_hex)"
audit_hmac_key="$(random_hex)"
bot_webhook_secret="$(random_base64)"

write_one postgres-superuser-password "$postgres_superuser_password"
write_one postgres-migrator-password "$postgres_migrator_password"
write_one postgres-runtime-password "$postgres_runtime_password"
write_one postgres-audit-password "$postgres_audit_password"
write_one migration-database-url "postgresql://donut_migrator:${postgres_migrator_password}@postgres:5432/donut_upgrader"
write_one api-database-url "postgresql://donut_api_login:${postgres_runtime_password}@postgres:5432/donut_upgrader"
write_one audit-database-url "postgresql://donut_audit_login:${postgres_audit_password}@postgres:5432/donut_upgrader"
printf '%s\n' \
  'bind 0.0.0.0' \
  'protected-mode yes' \
  "requirepass $redis_password" \
  'appendonly yes' \
  'maxmemory 384mb' \
  'maxmemory-policy noeviction' > "$secret_dir/redis.conf"
write_one api-redis-url "redis://:${redis_password}@redis:6379/0"
write_one api-cookie-secret "$(random_hex)"
write_one api-data-encryption-key "$(random_base64)"
write_one api-bot-credentials.json "{\"${BOT_ID,,}\":{\"secret\":\"$bot_webhook_secret\",\"serverHost\":\"donutsmp.net\",\"username\":\"$BOT_USERNAME\"}}"
write_one api-admin-totp-secrets.json '{}'
write_one api-audit-hmac-key "$audit_hmac_key"
write_one api-ip-hash-key "$(random_hex)"
write_one api-donutsmp-api-key "$DONUTSMP_API_KEY"
write_one audit-verification-keys.json "{\"$audit_key_id\":\"$audit_hmac_key\"}"
write_one audit-checkpoint-hmac-key "$(random_hex)"
write_one bot-webhook-secret "$bot_webhook_secret"

# Discord. The three files are always written so the API can mount them whether or not the control
# plane is switched on; DISCORD_CONTROL_ENABLED is what actually turns the feature on, and the
# gateway only validates these when it is. A placeholder token is a token that cannot log in, which
# is the correct state for a deployment that has no Discord application.
write_one discord-bot-token "${DISCORD_BOT_TOKEN:-disabled-no-discord-application}"
write_one discord-control-hmac-key "${DISCORD_CONTROL_HMAC_KEY:-$(random_base64)}"
discord_operators="${DISCORD_OPERATORS_JSON:-}"
# An empty allowlist, written explicitly. ${VAR:-{}} does not survive brace parsing in bash, and
# a silently mangled operator file is one that either locks everybody out or lets somebody in.
if [[ -z "$discord_operators" ]]; then discord_operators='{}'; fi
write_one discord-operators.json "$discord_operators"

# The API mounts this whether or not a challenge is configured, so it always has to exist. A
# placeholder is a key that cannot verify anything, which is the right state for a deployment with
# TURNSTILE_ENABLED off.
write_one turnstile-secret-key "${TURNSTILE_SECRET_KEY:-disabled-no-turnstile}"

# Docker Compose implements local file-backed secrets as bind mounts, so the files keep their
# host mode inside the container. The services deliberately run under different non-root UIDs and
# must be able to read their individual mounts. The parent directory remains root-owned and 0700,
# which prevents unprivileged host users from traversing to these read-only files.
chmod 0444 "$secret_dir"/*
chown -R 1000:1000 "$auth_dir"
chmod 0700 "$auth_dir"

echo "Created production secret files in $secret_dir"
echo "Created writable Microsoft authentication state directory in $auth_dir"
echo "No secret value was printed. Back up this directory in an encrypted secret store."
