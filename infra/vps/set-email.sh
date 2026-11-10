#!/usr/bin/env bash
set -euo pipefail

# Turns email on (linking an address, signing in with a code, moving an account), or off.
#
#   ./infra/vps/set-email.sh                 takes RESEND_API_KEY from donutdrop.env and moves it
#   ./infra/vps/set-email.sh re_xxxxxxxx      or the key given here
#   ./infra/vps/set-email.sh --off
#   add --no-restart to write the settings without recreating the API (a deploy that follows will
#   pick them up: that is one restart instead of two)
#
# The key is a secret: it ends up in a secret file beside the others, never in donutdrop.env. A
# RESEND_API_KEY line left in the env file is removed once the key is in its file.
#
# Validates the resulting configuration with the real loader before restarting anything, because a
# half-configured email setup is refused at boot and would otherwise take the API down.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root so the secret permissions match the other files" >&2
  exit 1
fi

restart=true
args=()
for arg in "$@"; do
  if [[ "$arg" == "--no-restart" ]]; then restart=false; else args+=("$arg"); fi
done
set -- "${args[@]+"${args[@]}"}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
compose_file="$repo_root/infra/docker/compose.yml"
secret_dir="${DONUTDROP_STATE_DIR:-/opt/donutdrop/shared}/secrets"
secret_file="$secret_dir/resend-api-key"

for path in "$env_file" "$compose_file" "$secret_dir"; do
  [[ -e "$path" ]] || { echo "Missing $path" >&2; exit 1; }
done

compose() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }

set_env() {
  local key="$1" value="$2"
  if grep -q "^$key=" "$env_file"; then
    sed -i "s|^$key=.*|$key=$value|" "$env_file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$env_file"
  fi
}

backup="$(mktemp -d)"
trap 'rm -rf "$backup"' EXIT
cp "$env_file" "$backup/env"
[[ -f "$secret_file" ]] && cp "$secret_file" "$backup/secret"

umask 077

# The API mounts this file whether or not email is configured (deploy.sh writes the same placeholder).
if [[ ! -f "$secret_file" ]]; then
  printf '%s' 'not-configured' > "$secret_file"
  chmod 0444 "$secret_file"
  echo "Created $secret_file"
fi

if [[ "${1:-}" == "--off" ]]; then
  set_env EMAIL_ENABLED false
  echo "Email disabled. The key is left in place."
else
  key="${1:-}"
  if [[ -z "$key" ]]; then
    # The line as written in the env file, with any surrounding quotes taken off. Never printed.
    key="$(grep -m1 '^RESEND_API_KEY=' "$env_file" | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//')" || true
  fi
  if [[ -z "$key" ]]; then
    echo "No key given, and no RESEND_API_KEY line in $env_file" >&2
    exit 1
  fi
  if [[ ! "$key" =~ ^re_[A-Za-z0-9_]{10,}$ ]]; then
    echo "That does not look like a Resend API key (expected re_ followed by the token)" >&2
    exit 1
  fi
  printf '%s' "$key" > "$secret_file"
  chmod 0444 "$secret_file"
  # The key now lives in its file; the plaintext line in the env file goes.
  sed -i '/^RESEND_API_KEY=/d' "$env_file"
  grep -q '^EMAIL_DAILY_LIMIT=' "$env_file" || set_env EMAIL_DAILY_LIMIT 100
  grep -q '^EMAIL_FROM=' "$env_file" || printf '%s\n' 'EMAIL_FROM=DonutLuxe <login@donutluxe.com>' >> "$env_file"
  set_env EMAIL_ENABLED true
fi

echo "Validating..."
validation="$(compose run --rm --no-deps --entrypoint node api \
  --input-type=module --eval '
    const m = await import("file:///app/services/api-gateway/dist/src/config.js");
    try { m.loadConfig(); process.stdout.write("CONFIG OK"); }
    catch (e) { process.stdout.write("CONFIG ERROR: " + e.message); }' 2>/dev/null | tr -d '\r')"

if [[ "$validation" != *"CONFIG OK"* ]]; then
  cp "$backup/env" "$env_file"
  [[ -f "$backup/secret" ]] && cp "$backup/secret" "$secret_file" && chmod 0444 "$secret_file"
  echo "$validation" >&2
  echo "Nothing was changed." >&2
  exit 1
fi

if [[ "$restart" == false ]]; then
  echo "Written and valid. The API was not restarted; the next deploy picks it up."
  exit 0
fi

echo "Applying..."
if ! compose up -d --force-recreate api; then
  echo >&2
  echo "The API did not come back up. The configuration above is written and valid, so this is" >&2
  echo "something else — check: docker compose logs --tail=40 api" >&2
  exit 1
fi

echo
if [[ "${1:-}" == "--off" ]]; then
  echo "Email is off."
else
  echo "Email is on. The key was not printed; it is in $secret_file."
fi
