#!/usr/bin/env bash
set -euo pipefail

# Turns the sign-in challenge on, or off.
#
#   ./infra/vps/set-turnstile.sh 0xSITEKEY 0xSECRETKEY
#   ./infra/vps/set-turnstile.sh --off
#
# The site key is public and goes in donutdrop.env; the secret key is what proves a challenge was
# actually solved, so it goes in a secret file beside the others and never into the env file.
#
# Validates the resulting configuration with the real loader before restarting anything, because a
# half-configured challenge is refused at boot and would otherwise take the API down.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root so the secret permissions match the other files" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
compose_file="$repo_root/infra/docker/compose.yml"
secret_dir="${DONUTDROP_STATE_DIR:-/opt/donutdrop/shared}/secrets"
secret_file="$secret_dir/turnstile-secret-key"

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
if [[ "${1:-}" == "--off" ]]; then
  set_env TURNSTILE_ENABLED false
  echo "Challenge disabled. The site key and secret are left in place."
else
  if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <site-key> <secret-key>" >&2
    echo "       $0 --off" >&2
    exit 1
  fi
  site_key="$1"
  secret_key="$2"

  # Cloudflare issues both as 0x-prefixed tokens. Checking the shape here turns a mistyped key into
  # a refusal rather than into an API that will not boot.
  for pair in "site:$site_key" "secret:$secret_key"; do
    name="${pair%%:*}"
    value="${pair#*:}"
    if [[ ! "$value" =~ ^0x[A-Za-z0-9_-]{10,}$ ]]; then
      echo "The $name key does not look like a Turnstile key (expected 0x followed by the token)" >&2
      exit 1
    fi
  done
  if [[ "$site_key" == "$secret_key" ]]; then
    echo "The site key and the secret key are the same value; check which is which" >&2
    exit 1
  fi

  printf '%s' "$secret_key" > "$secret_file"
  chmod 0444 "$secret_file"
  set_env TURNSTILE_SITE_KEY "$site_key"
  set_env TURNSTILE_ENABLED true
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

echo "Applying..."
compose up -d --force-recreate api > /dev/null 2>&1

echo
if [[ "${1:-}" == "--off" ]]; then
  echo "Sign-in challenge is off."
else
  echo "Sign-in challenge is on. Open the sign-in card and the widget should appear above Continue."
  echo "The secret was not printed; it is in $secret_file."
fi
