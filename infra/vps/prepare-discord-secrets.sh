#!/usr/bin/env bash
set -euo pipefail

# Adds the Discord control-plane secrets to an ALREADY PROVISIONED deployment.
#
# prepare-secrets.sh deliberately refuses to run twice — it mints every credential the platform
# owns, so a second run would rotate the database passwords and the bot's webhook secret out from
# under a live stack. That guard is right, and it is also why adding Discord later needs its own
# script rather than a flag on that one.
#
# Safe to re-run. Anything already on disk is kept unless you explicitly pass a new value, so
# running this to rotate the token cannot silently blank the operator allowlist, and cannot change
# the HMAC key that the gateway and the bot must continue to agree on.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run this script as root so the secret permissions match the other files" >&2
  exit 1
fi

state_dir="${DONUTDROP_STATE_DIR:-/opt/donutdrop/shared}"
secret_dir="$state_dir/secrets"

if [[ ! -d "$secret_dir" ]]; then
  echo "$secret_dir does not exist; run prepare-secrets.sh first" >&2
  exit 1
fi

umask 077

# Existing value wins over the generated fallback, and an explicitly supplied value wins over both.
keep_or_write() {
  local name="$1" supplied="$2" fallback="$3" path="$secret_dir/$1"
  if [[ -n "$supplied" ]]; then
    if [[ "$supplied" == *$'\n'* || "$supplied" == *$'\r'* ]]; then
      echo "$name must be exactly one line" >&2
      exit 1
    fi
    printf '%s' "$supplied" > "$path"
    echo "wrote $name"
  elif [[ -s "$path" ]]; then
    echo "kept existing $name"
  else
    printf '%s' "$fallback" > "$path"
    echo "created $name"
  fi
  chmod 0444 "$path"
}

# A placeholder token is a token that cannot log in, which is the correct state for a deployment
# that has no Discord application yet. The API mounts this file either way; DISCORD_CONTROL_ENABLED
# is what decides whether it is ever validated.
keep_or_write discord-bot-token "${DISCORD_BOT_TOKEN:-}" 'disabled-no-discord-application'

# Shared with the bot. Regenerating it after the bot is running breaks every signed request until
# both sides restart, so it is only ever created when absent.
keep_or_write discord-control-hmac-key "${DISCORD_CONTROL_HMAC_KEY:-}" "$(openssl rand -base64 32 | tr -d '\n')"

# The allowlist that decides who can mint an admin session. One entry is one operator.
keep_or_write discord-operators.json "${DISCORD_OPERATORS_JSON:-}" '{}'

echo
echo "Discord secrets are in $secret_dir"
echo "No secret value was printed. Set DISCORD_CONTROL_ENABLED=true in donutdrop.env to turn the"
echo "control plane on, and start the bot with: docker compose --profile discord up -d --build"
