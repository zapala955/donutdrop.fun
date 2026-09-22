#!/usr/bin/env bash
set -euo pipefail

# Adds the second bot -- the vault -- to a running deployment.
#
# Everything here is the mechanical half: generating an id and a secret, writing them into the
# two files that need them, and starting the container. The three things it cannot do for you are
# making the Minecraft account, signing it into Microsoft, and pressing "Make vault" in the admin
# panel; it tells you when each of those is your turn.
#
# Safe to re-run. It backs up both files it touches, refuses to overwrite an id that already
# exists, and changes nothing until every check below has passed.

env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/infra/docker/compose.yml"
secret_file="/opt/donutdrop/shared/secrets/vault-bot-webhook-secret"
auth_dir="/opt/donutdrop/shared/vault-bot-auth"

say() { printf '\n\033[1;33m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mStopped:\033[0m %s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this with sudo: sudo $0"
[[ -f "$env_file" ]] || die "No environment file at $env_file"
command -v python3 >/dev/null || die "python3 is needed to edit the credentials file safely"

# ── 1. what the account is called ──────────────────────────────────────────
if [[ $# -ge 1 ]]; then
  ign="$1"
else
  printf 'Exact in-game name of the NEW Minecraft account: '
  read -r ign
fi
[[ "$ign" =~ ^[A-Za-z0-9_]{3,16}$ ]] || die "'$ign' is not a valid Minecraft name"

if [[ $# -ge 2 ]]; then
  ms_account="$2"
else
  printf 'Microsoft account it signs in with (email), or press enter to reuse "%s": ' "$ign"
  read -r ms_account
fi
[[ -n "$ms_account" ]] || ms_account="$ign"

# ── 2. the credentials file the API reads ──────────────────────────────────
creds_file="$(sed -n 's/^API_BOT_CREDENTIALS_JSON_FILE=//p' "$env_file" | tail -n 1)"
[[ -n "$creds_file" ]] || die "API_BOT_CREDENTIALS_JSON_FILE is not set in $env_file"
# Relative paths in that file are resolved against the compose directory.
[[ "$creds_file" = /* ]] || creds_file="$repo_root/infra/docker/$creds_file"
[[ -f "$creds_file" ]] || die "The credentials file $creds_file does not exist"

if grep -q '^VAULT_BOT_ID=' "$env_file"; then
  die "VAULT_BOT_ID is already set in $env_file. The vault is already configured; if you are
  trying to replace it, remove that line and the matching entry in $creds_file first."
fi

# ── 3. an id and a secret ──────────────────────────────────────────────────
vault_id="$(cat /proc/sys/kernel/random/uuid)"
vault_secret="$(openssl rand -base64 32)"

say "Adding $ign as the vault"
printf '  id:          %s\n' "$vault_id"
printf '  credentials: %s\n' "$creds_file"
printf '  environment: %s\n' "$env_file"
printf '\nPress enter to continue, or ctrl-c to stop. '
read -r _

# ── 4. write the bot's own secret, with no trailing newline ────────────────
# The bot refuses a secret file containing anything but one line, and `echo` would add a newline
# that makes the two sides disagree about the key.
install -d -m 0700 "$(dirname "$secret_file")"
printf '%s' "$vault_secret" >"$secret_file"
install -d "$auth_dir"

# ── OWNED BY THE CONTAINER'S USER, NOT BY ROOT ─────────────────────────────
# bot.Dockerfile ends in `USER node`, which is uid 1000, and compose bind-mounts a file secret
# straight through with the host's own ownership. Written as root at 0600 the bot cannot read its
# own secret and dies on EACCES before it has done anything; the auth directory is worse, because
# it has to WRITE its Microsoft token cache there and would fail the same way a moment later.
#
# 1000:1000 with the modes kept tight, rather than 0644: the secret authenticates every message
# this bot sends to the gateway and does not belong to every account on the host.
bot_uid=1000
chown "$bot_uid:$bot_uid" "$secret_file" "$auth_dir"
chmod 0600 "$secret_file"
chmod 0700 "$auth_dir"

# Proven, not assumed. Checking it here costs one command and turns a container that crash-loops
# on a stack trace into a message that says which file and why.
if ! su -s /bin/sh -c "test -r '$secret_file'" "#$bot_uid" 2>/dev/null; then
  die "uid $bot_uid still cannot read $secret_file. The container runs as that user and will not start."
fi
if ! su -s /bin/sh -c "test -w '$auth_dir'" "#$bot_uid" 2>/dev/null; then
  die "uid $bot_uid cannot write to $auth_dir. The bot stores its Microsoft session there."
fi
say "Wrote $secret_file and $auth_dir, owned by uid $bot_uid (the container's user)"

# ── 5. add the entry to the credentials JSON ───────────────────────────────
# Through python rather than sed: this file is JSON the API refuses to start without, and a
# malformed edit takes the whole site down until somebody notices.
cp -a "$creds_file" "$creds_file.bak.$(date +%Y%m%d%H%M%S)"
python3 - "$creds_file" "$vault_id" "$vault_secret" "$ign" <<'PY'
import json, sys
path, bot_id, secret, username = sys.argv[1:5]
with open(path, encoding='utf-8') as handle:
    creds = json.load(handle)
if not isinstance(creds, dict):
    raise SystemExit('credentials file is not a JSON object')
if bot_id in creds:
    raise SystemExit('that id is already in the credentials file')
host = next((v.get('serverHost') for v in creds.values() if isinstance(v, dict)), 'donutsmp.net')
# Exactly these three keys. The API rejects the whole file if any entry carries a fourth.
creds[bot_id] = {'secret': secret, 'serverHost': host, 'username': username}
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(creds, handle, indent=2)
    handle.write('\n')
print('  added %s (%s) alongside %d existing bot(s)' % (username, bot_id, len(creds) - 1))
PY
say "Updated $creds_file (backup kept beside it)"

# ── 6. the environment ─────────────────────────────────────────────────────
cp -a "$env_file" "$env_file.bak.$(date +%Y%m%d%H%M%S)"
cat >>"$env_file" <<EOF

# The vault bot -- holds the float, never named to a player. Added $(date -u +%Y-%m-%dT%H:%M:%SZ).
VAULT_BOT_ID=$vault_id
VAULT_MINECRAFT_USERNAME=$ms_account
VAULT_MINECRAFT_EXPECTED_USERNAME=$ign
EOF
say "Updated $env_file (backup kept beside it)"

# ── 7. bring it up ─────────────────────────────────────────────────────────
compose=(docker compose --env-file "$env_file" -f "$compose_file" --profile vault)
"${compose[@]}" config --quiet || die "compose rejected the configuration; both backups are beside the originals"

say "Restarting the API so it loads the new credentials"
"${compose[@]}" up -d --build api

say "Starting the vault bot"
"${compose[@]}" up -d --build minecraft-bot-vault

cat <<EOF

────────────────────────────────────────────────────────────────────────────
Two things left, and both are yours:

1. SIGN IT IN. The log below prints a microsoft.com/link code. Open it and
   sign in as the NEW account. This happens once.

2. PROMOTE IT. Once it is in game, open the admin panel, go to Bots, find
   $ign and press "Make vault".

   Until you press that, it is an ordinary teller and nothing has changed.

Watching the log now -- ctrl-c when you have the code, it keeps running.
────────────────────────────────────────────────────────────────────────────

EOF

"${compose[@]}" logs -f minecraft-bot-vault
