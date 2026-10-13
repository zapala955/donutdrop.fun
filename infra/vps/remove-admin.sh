#!/usr/bin/env bash
set -euo pipefail

# remove-admin.sh — take one account's administrator and Discord-operator rights away, keeping every
# other administrator exactly as configured. The inverse of add-admin.sh.
#
#   sudo ./infra/vps/remove-admin.sh SomePlayer
#
# The same three things have to agree or the gateway refuses to boot, so all three lose the
# identity together:
#
#   ADMIN_MINECRAFT_IDS          in donutdrop.env           (comma-separated identities)
#   discord-operators.json       snowflake -> identity      (every snowflake pointing at it)
#   api-admin-totp-secrets.json  identity  -> base32 secret (its recovery code stops working)
#
# The result is proven to load with the real config loader before the API restarts against it, and
# every file is put back if it does not. The account itself is kept: it becomes a player, and every
# session it holds is ended now rather than on its next request. Removing the last administrator is
# refused, because the gateway would boot with nobody able to reach the console.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root so the secret permissions match the other files" >&2
  exit 1
fi
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <minecraft-username>" >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to edit the JSON files" >&2; exit 1; }

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
if [[ ! "$username" =~ ^(([A-Za-z0-9_]{3,16})|(\.[A-Za-z0-9_]{2,15}))$ ]]; then
  echo "'$username' is not a valid Minecraft username" >&2
  exit 1
fi

# The username has been checked against a strict pattern above, so it cannot carry a quote here.
row="$(compose exec -T postgres psql -qtAX -U postgres -d donut_upgrader -F '|' \
  -c "SELECT id, minecraft_identity FROM users WHERE normalized_username = lower('$username')" \
  | tr -d '\r[:space:]')"
user_id="${row%%|*}"
identity="${row#*|}"
if [[ -z "$row" ]]; then
  echo "No account for '$username'." >&2
  exit 1
fi
if [[ ! "$user_id" =~ ^[0-9a-f-]{36}$ || ! "$identity" =~ ^mc:[0-9a-fA-F]{32}$ ]]; then
  echo "Unexpected account row for '$username'" >&2
  exit 1
fi
identity="$(printf '%s' "$identity" | tr 'A-F' 'a-f')"

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

current_ids="$(sed -n 's|^ADMIN_MINECRAFT_IDS=||p' "$env_file" | tr -d '[:space:]')"
umask 077
result="$(OPS="$operators_file" TOTP="$totp_file" IDS="$current_ids" GONE="$identity" python3 -c '
import json, os, sys
ops_path, totp_path = os.environ["OPS"], os.environ["TOTP"]
ops = json.load(open(ops_path)) if os.path.getsize(ops_path) else {}
totp = json.load(open(totp_path)) if os.path.getsize(totp_path) else {}
ids = [i.strip().lower() for i in os.environ["IDS"].split(",") if i.strip()]
gone = os.environ["GONE"]
if gone not in ids and gone not in totp and gone not in ops.values():
    print("not-admin", end=""); sys.exit(0)
ids = [i for i in ids if i != gone]
if not ids:
    print("last-admin", end=""); sys.exit(0)
dropped = [s for s, i in ops.items() if i == gone]
ops = {s: i for s, i in ops.items() if i != gone}
totp.pop(gone, None)
open(ops_path, "w").write(json.dumps(ops, separators=(",", ":")))
open(totp_path, "w").write(json.dumps(totp, separators=(",", ":")))
print(",".join(ids) + "|" + ",".join(dropped), end="")
')"
chmod 0444 "$operators_file" "$totp_file"
if [[ "$result" == "not-admin" ]]; then
  echo "'$username' is not an administrator. Nothing was changed."
  exit 0
fi
if [[ "$result" == "last-admin" ]]; then
  restore
  echo "'$username' is the only administrator; add another first (add-admin.sh). Nothing was changed." >&2
  exit 1
fi
ids="${result%|*}"
dropped_discord="${result#*|}"
sed -i "s|^ADMIN_MINECRAFT_IDS=.*|ADMIN_MINECRAFT_IDS=$ids|" "$env_file"

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

echo "Applying..."
compose up -d --force-recreate api > /dev/null 2>&1

# ── the database half ── the gateway would demote the account and end its sessions on its next
# request anyway (lib/auth.ts); done here so no session outlives this script, not even an idle one.
compose exec -T postgres psql -qX -U postgres -d donut_upgrader -v ON_ERROR_STOP=1 <<SQL > /dev/null
BEGIN;
UPDATE users SET role = 'player', updated_at = now() WHERE id = '$user_id' AND role <> 'player';
UPDATE sessions SET revoked_at = now() WHERE user_id = '$user_id' AND revoked_at IS NULL;
COMMIT;
SQL

echo
echo "Administrator removed: $username ($identity)"
echo "Discord operator ids dropped: ${dropped_discord:-none}"
echo "Administrators left: $ids"
echo "Their sessions are ended; the account stays, as a player."
