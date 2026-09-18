#!/usr/bin/env bash
set -euo pipefail

# set-admin.sh — make one linked account the platform administrator, or clear the admin surface.
#
#   ./infra/vps/set-admin.sh q9w 1529422856990228519
#   ./infra/vps/set-admin.sh --clear
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY THIS IS ONE COMMAND AND NOT A RUNBOOK
# ─────────────────────────────────────────────────────────────────────────────────────────────
# Three things have to agree or the gateway refuses to boot, and the check that compares them runs
# whether or not the Discord control plane is switched on:
#
#   ADMIN_MINECRAFT_IDS          in donutdrop.env
#   discord-operators.json       snowflake -> identity
#   api-admin-totp-secrets.json  identity  -> base32 secret
#
# All three naming the same identity is valid. All three empty is valid. Every other combination
# takes the API down on its next restart — including combinations that look like progress, such as
# "I have cleared the admin list but not the operator map". Setting them by hand, one file at a
# time, means passing through an invalid state on the way to a valid one and finding out later.
#
# So this writes all three, validates the result with the real config loader, and rolls every file
# back if the loader refuses. The API is never restarted against a configuration that has not
# already been proven to load.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root so the secret permissions match the other files" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
compose_file="$repo_root/infra/docker/compose.yml"
state_dir="${DONUTDROP_STATE_DIR:-/opt/donutdrop/shared}"
secret_dir="$state_dir/secrets"
operators_file="$secret_dir/discord-operators.json"
totp_file="$secret_dir/api-admin-totp-secrets.json"

for path in "$env_file" "$compose_file" "$operators_file" "$totp_file"; do
  [[ -e "$path" ]] || { echo "Missing $path" >&2; exit 1; }
done

compose() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }

clear_mode=false
if [[ "${1:-}" == "--clear" ]]; then
  clear_mode=true
elif [[ $# -ne 2 ]]; then
  echo "Usage: $0 <minecraft-username> <discord-user-id>" >&2
  echo "       $0 --clear" >&2
  exit 1
fi

# ── work out the target state ──

if [[ "$clear_mode" == true ]]; then
  identity=''
  operators='{}'
  totp='{}'
  control='false'
  secret=''
else
  username="$1"
  discord_id="$2"

  if [[ ! "$username" =~ ^(([A-Za-z0-9_]{3,16})|(\.[A-Za-z0-9_]{2,15}))$ ]]; then
    echo "'$username' is not a valid Minecraft username" >&2
    exit 1
  fi
  if [[ ! "$discord_id" =~ ^[0-9]{5,32}$ ]]; then
    echo "'$discord_id' is not a Discord user id (5-32 digits)" >&2
    exit 1
  fi

  # The database is the authority on which accounts exist. An identity invented here would pass
  # every config check and then fail at the only moment that matters, when somebody runs /dashboard.
  identity="$(compose exec -T postgres psql -qtAX -U postgres -d donut_upgrader \
    -c "SELECT minecraft_identity FROM users WHERE normalized_username = lower('$username')" \
    | tr -d '\r[:space:]')"

  if [[ -z "$identity" ]]; then
    echo "No account for '$username'. Sign in on the site with it first." >&2
    exit 1
  fi
  if [[ ! "$identity" =~ ^mc:[0-9a-fA-F]{32}$ ]]; then
    echo "Unexpected identity for '$username': $identity" >&2
    exit 1
  fi

  # 20 random bytes is exactly 32 base32 characters with no padding, which is the only shape the
  # gateway's canonical decoder accepts.
  secret="$(compose run --rm --no-deps --entrypoint node api -e '
    const c = require("node:crypto");
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let acc = 0, bits = 0, out = "";
    for (const b of c.randomBytes(20)) {
      acc = (acc << 8) | b; bits += 8;
      while (bits >= 5) { bits -= 5; out += A[(acc >>> bits) & 31]; }
    }
    process.stdout.write(out);' | tr -d '\r[:space:]')"

  if [[ ! "$secret" =~ ^[A-Z2-7]{32}$ ]]; then
    echo "Could not generate a TOTP secret (got ${#secret} characters)" >&2
    exit 1
  fi

  operators="{\"$discord_id\":\"$identity\"}"
  totp="{\"$identity\":\"$secret\"}"
  control='true'
fi

# ── keep what is there, so a refusal can put it back exactly ──

backup="$(mktemp -d)"
trap 'rm -rf "$backup"' EXIT
cp "$operators_file" "$backup/operators"
cp "$totp_file" "$backup/totp"
cp "$env_file" "$backup/env"

restore() {
  cp "$backup/operators" "$operators_file"
  cp "$backup/totp" "$totp_file"
  cp "$backup/env" "$env_file"
  chmod 0444 "$operators_file" "$totp_file"
}

umask 077
printf '%s' "$operators" > "$operators_file"
printf '%s' "$totp" > "$totp_file"
chmod 0444 "$operators_file" "$totp_file"

set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$env_file"; then
    sed -i "s|^$key=.*|$key=$value|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}
set_env ADMIN_MINECRAFT_IDS "$identity"
set_env DISCORD_CONTROL_ENABLED "$control"

# ── prove it loads before anything restarts against it ──

echo "Validating..."
validation="$(compose run --rm --no-deps --entrypoint node api \
  --input-type=module --eval '
    const m = await import("file:///app/services/api-gateway/dist/src/config.js");
    try { m.loadConfig(); process.stdout.write("CONFIG OK"); }
    catch (e) { process.stdout.write("CONFIG ERROR: " + e.message); }' 2>/dev/null | tr -d '\r')"

if [[ "$validation" != *"CONFIG OK"* ]]; then
  restore
  echo "$validation" >&2
  echo "Nothing was changed." >&2
  exit 1
fi

# ── the database half ──
#
# The admin role is normally applied on an authenticated request, which an administrator cannot
# make: an admin session has to come from the Discord link. Granting it here is what breaks that
# circle. On --clear the row goes back to being an ordinary player.

if [[ "$clear_mode" == true ]]; then
  previous="$(sed -n 's|^ADMIN_MINECRAFT_IDS=||p' "$backup/env" | tr -d '[:space:]')"
  if [[ -n "$previous" ]]; then
    compose exec -T postgres psql -qX -U postgres -d donut_upgrader \
      -c "UPDATE users SET role = 'player', updated_at = now() WHERE minecraft_identity = '$previous'" \
      > /dev/null
  fi
else
  compose exec -T postgres psql -qX -U postgres -d donut_upgrader \
    -c "UPDATE users SET role = 'admin', status = 'active', updated_at = now() WHERE minecraft_identity = '$identity'" \
    > /dev/null
fi

echo "Applying..."
compose up -d --force-recreate api > /dev/null 2>&1

echo
if [[ "$clear_mode" == true ]]; then
  echo "Admin surface cleared. No administrator, Discord control off."
else
  echo "Administrator: $username ($identity)"
  echo "Discord operator: $discord_id"
  echo
  echo "Save this recovery code somewhere safe. It is shown once and only needed if Discord is"
  echo "unavailable — the /dashboard link issues a session that is already MFA-verified."
  echo "otpauth://totp/DonutDrop:$identity?secret=$secret&issuer=DonutDrop&algorithm=SHA256&digits=8&period=30"
  echo
  echo "Run /dashboard in Discord to reach the admin panel."
fi
