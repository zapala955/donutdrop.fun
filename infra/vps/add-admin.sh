#!/usr/bin/env bash
set -euo pipefail

# add-admin.sh — make one more linked account an administrator and a Discord operator, keeping
# every administrator already configured.
#
#   sudo ./infra/vps/add-admin.sh SomePlayer 1514304386589790398
#
# set-admin.sh REPLACES the admin surface with a single account; this ADDS to it. The same three
# things have to agree or the gateway refuses to boot:
#
#   ADMIN_MINECRAFT_IDS          in donutdrop.env           (comma-separated identities)
#   discord-operators.json       snowflake -> identity
#   api-admin-totp-secrets.json  identity  -> base32 secret
#
# So, like set-admin.sh, this writes all three, proves the result loads with the real config loader,
# and puts every file back if it does not. The API is restarted only against a configuration that
# has already been shown to load. The new operator can then run /dashboard in the control server
# for an MFA-verified console link; the TOTP secret printed at the end is only the fallback.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root so the secret permissions match the other files" >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <minecraft-username> <discord-user-id>" >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to merge the JSON files" >&2; exit 1; }

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

# The database is the authority on which accounts exist. The username has been checked against a
# strict pattern above, so it cannot carry a quote into this statement.
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
identity="$(printf '%s' "$identity" | tr 'A-F' 'a-f')"

# 20 random bytes is exactly 32 base32 characters with no padding, the only shape the gateway's
# canonical decoder accepts. Generated here so it never passes through a command line.
secret="$(python3 -c '
import base64, os
print(base64.b32encode(os.urandom(20)).decode(), end="")')"
if [[ ! "$secret" =~ ^[A-Z2-7]{32}$ ]]; then
  echo "Could not generate a TOTP secret" >&2
  exit 1
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

# ── merge, never replace ──
# An identity that already has a TOTP secret keeps it: replacing it would lock out whoever holds the
# current recovery code. The snowflake is (re)pointed at this identity.
current_ids="$(sed -n 's|^ADMIN_MINECRAFT_IDS=||p' "$env_file" | tr -d '[:space:]')"
umask 077
result="$(OPS="$operators_file" TOTP="$totp_file" IDS="$current_ids" \
  NEW_ID="$identity" NEW_DISCORD="$discord_id" NEW_SECRET="$secret" python3 -c '
import json, os
ops_path, totp_path = os.environ["OPS"], os.environ["TOTP"]
ops = json.load(open(ops_path)) if os.path.getsize(ops_path) else {}
totp = json.load(open(totp_path)) if os.path.getsize(totp_path) else {}
ids = [i.strip().lower() for i in os.environ["IDS"].split(",") if i.strip()]
new_id = os.environ["NEW_ID"]
if new_id not in ids:
    ids.append(new_id)
ops[os.environ["NEW_DISCORD"]] = new_id
fresh = new_id not in totp
if fresh:
    totp[new_id] = os.environ["NEW_SECRET"]
open(ops_path, "w").write(json.dumps(ops, separators=(",", ":")))
open(totp_path, "w").write(json.dumps(totp, separators=(",", ":")))
print(",".join(ids) + ("|fresh" if fresh else "|kept"), end="")
')"
ids="${result%|*}"
totp_state="${result#*|}"
chmod 0444 "$operators_file" "$totp_file"

set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$env_file"; then
    sed -i "s|^$key=.*|$key=$value|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}
set_env ADMIN_MINECRAFT_IDS "$ids"
set_env DISCORD_CONTROL_ENABLED true

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

# ── the database half ── the role is normally applied on an authenticated request, which an
# administrator cannot make before they have a console session.
compose exec -T postgres psql -qX -U postgres -d donut_upgrader \
  -c "UPDATE users SET role = 'admin', status = 'active', updated_at = now() WHERE minecraft_identity = '$identity'" \
  > /dev/null

echo "Applying..."
compose up -d --force-recreate api > /dev/null 2>&1

echo
echo "Administrator added: $username ($identity)"
echo "Discord operator:    $discord_id"
echo "All administrators:  $ids"
if [[ "$totp_state" == "fresh" ]]; then
  echo
  echo "Give this recovery code to $username privately. It is shown once and only needed if Discord"
  echo "is unavailable -- the /dashboard link issues a session that is already MFA-verified."
  echo "otpauth://totp/DonutDrop:$identity?secret=$secret&issuer=DonutDrop&algorithm=SHA256&digits=8&period=30"
fi
echo
echo "They can now run /dashboard in the control Discord to reach the admin panel."
