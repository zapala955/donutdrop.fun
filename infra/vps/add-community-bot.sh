#!/usr/bin/env bash
set -euo pipefail

# Sets up the community Discord bot on a running deployment.
#
# The mechanical half: writing the two secret files, generating the HMAC key the gateway and the
# bot share, adding the switches to the environment file, and starting the container. The parts it
# cannot do for you happen at https://discord.com/developers/applications and it tells you when
# each one is your turn.
#
# Safe to re-run. It backs up the environment file, refuses to clobber an application id that is
# already configured, and changes nothing until every check below has passed.

env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/infra/docker/compose.yml"
secrets_dir="/opt/donutdrop/shared/secrets"
token_file="$secrets_dir/community-bot-token"
hmac_file="$secrets_dir/community-bot-hmac-key"
control_hmac_file="$secrets_dir/discord-control-hmac-key"

say() { printf '\n\033[1;33m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mStopped:\033[0m %s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this with sudo: sudo $0"
[[ -f "$env_file" ]] || die "No environment file at $env_file"

if grep -q '^COMMUNITY_APPLICATION_ID=' "$env_file"; then
  die "COMMUNITY_APPLICATION_ID is already set in $env_file. The community bot is already
  configured; to replace it, remove that line and COMMUNITY_GUILD_ID first."
fi

# ── 1. what you need from Discord ──────────────────────────────────────────
cat <<'INTRO'

Before this can finish you need three things from Discord. Open
https://discord.com/developers/applications and either pick the application for
your PUBLIC server or press "New Application".

  1. Application ID  — the "General Information" page, under the name.
  2. Bot token       — the "Bot" page, "Reset Token". Shown ONCE; copy it now.
  3. Server ID       — right-click your server in Discord, "Copy Server ID".
                       (Needs Developer Mode: Settings > Advanced.)

On that same "Bot" page, turn ON both of these under Privileged Gateway Intents:

  * SERVER MEMBERS INTENT   — so it can greet people and give them roles
  * MESSAGE CONTENT INTENT  — so automod can read what it is judging

Without those two the bot starts and then silently does nothing on joins or
messages, which is a confusing way to find out.

INTRO
printf 'Press enter when you have all three, or ctrl-c to stop. '
read -r _

if [[ $# -ge 1 ]]; then application_id="$1"; else
  printf 'Application ID: '; read -r application_id
fi
[[ "$application_id" =~ ^[0-9]{5,32}$ ]] || die "'$application_id' is not a Discord id"

if [[ $# -ge 2 ]]; then guild_id="$2"; else
  printf 'Server (guild) ID: '; read -r guild_id
fi
[[ "$guild_id" =~ ^[0-9]{5,32}$ ]] || die "'$guild_id' is not a Discord id"

printf 'Bot token (it will not be echoed): '
read -rs bot_token
printf '\n'
[[ -n "$bot_token" ]] || die "The bot token cannot be empty"
case "$bot_token" in
  *[[:space:]]*) die "The token has whitespace in it — copy it again without a line break" ;;
esac

# ── 2. the two secret files ────────────────────────────────────────────────
# printf, not echo: the bot rejects a secret file containing anything but one line, and a stray
# trailing newline is the difference between "starts" and "crash-loops on a config error". This
# exact mistake took the site down once already; see add-vault-bot.sh.
install -d -m 0700 "$secrets_dir"
printf '%s' "$bot_token" >"$token_file"

# ── THE KEY IS REUSED IF IT IS ALREADY THERE ───────────────────────────────
# deploy.sh writes this file on every deploy, because the API mounts it whether or not the bot is
# running and a compose secret with no file stops the container being created. Generating a fresh
# one here would leave the running API holding the old key until it restarted -- a window in which
# every profile lookup fails its signature check for no visible reason.
if [[ -s "$hmac_file" ]]; then
  say "Reusing the existing $hmac_file"
else
  printf '%s' "$(openssl rand -hex 32)" >"$hmac_file"
  say "Generated $hmac_file"
fi

# ── IT MUST NOT MATCH THE CONTROL PLANE'S KEY ──────────────────────────────
# That key turns a Discord snowflake into a platform ADMINISTRATOR. This process runs in a server
# anybody can join. The API refuses to boot if the two are equal; checking here turns that into a
# sentence rather than a container that will not start.
if [[ -f "$control_hmac_file" ]] && cmp -s "$hmac_file" "$control_hmac_file"; then
  die "$hmac_file holds the same value as the control-plane key. Delete it and re-run."
fi

# 0444 owned by root, matching every other secret in this directory. The directory is 0700 root,
# which is what actually keeps these private; the files inside are readable so that any container
# user can mount them -- the API runs as `node` and so does the bot.
chown 0:0 "$token_file" "$hmac_file"
chmod 0444 "$token_file" "$hmac_file"

# Proven, not assumed. One command, and it turns a container that crash-loops on a stack trace
# into a message naming the file and the reason.
bot_uid=1000
for file in "$token_file" "$hmac_file"; do
  if ! su -s /bin/sh -c "test -r '$file'" "#$bot_uid" 2>/dev/null; then
    die "uid $bot_uid cannot read $file. The containers run as that user and will not start."
  fi
  # One line each, which is the shape the loader actually enforces.
  if [[ "$(wc -l <"$file")" -gt 0 ]]; then
    die "$file ended up with a trailing newline. This is a bug in this script."
  fi
done
say "Wrote $token_file and $hmac_file (root, 0444, inside a 0700 directory)"

# ── 3. the environment ─────────────────────────────────────────────────────
cp -a "$env_file" "$env_file.bak.$(date +%Y%m%d%H%M%S)"
{
  printf '\n# The community Discord bot (added %s by add-community-bot.sh)\n' "$(date -Iseconds)"
  printf 'COMMUNITY_APPLICATION_ID=%s\n' "$application_id"
  printf 'COMMUNITY_GUILD_ID=%s\n' "$guild_id"
  # Two switches, deliberately. This one lets the API answer the bot's profile lookups.
  printf 'COMMUNITY_BOT_ENABLED=true\n'
} >>"$env_file"
say "Updated $env_file (backup kept beside it)"

# ── 4. build and start ─────────────────────────────────────────────────────
say "Building and starting the bot. The API restarts too, to pick up the new key."
cd "$repo_root"
docker compose --env-file "$env_file" -f "$compose_file" --profile community \
  up -d --build api community-bot

# ── 5. register the slash commands ─────────────────────────────────────────
# Once, not on every boot: a PUT replaces the whole command list, and a container that crash-loops
# would otherwise re-register twenty commands a minute against a shared rate limit.
say "Registering the slash commands with Discord"
docker compose --env-file "$env_file" -f "$compose_file" --profile community \
  run --rm --entrypoint node community-bot \
  --enable-source-maps services/community-bot/dist/scripts/register-commands.js

# ── 6. what is left for you ────────────────────────────────────────────────
# 1099780189270 = manage roles 268435456 + moderate members 1099511627776 + manage channels 16
#   + kick 2 + ban 4 + manage messages 8192 + view 1024 + send 2048 + embed 16384
#   + attach 32768 + read history 65536 + add reactions 64
invite="https://discord.com/api/oauth2/authorize?client_id=$application_id&scope=bot%20applications.commands&permissions=1099780189270"
cat <<DONE

$(printf '\033[1;32mDone.\033[0m') The bot is running. Two things left:

  1. Invite it to your server, if it is not already there:

     $invite

     That asks for: manage roles, manage channels, kick, ban, moderate members,
     manage messages, read and send messages, embed links, attach files and read
     history. It is what the ticket, moderation and role-menu commands need.

  2. In Discord, run these once:

       /ticket-setup category:<your tickets category> staff_role:<your staff role>
       /ticket-panel                     (in the channel members should use)
       /config modlog:#mod-log welcome:#welcome suggestions:#suggestions
       /automod invites:true spam:true   (start here; add links/caps if you want)

Everything else is optional and has a default. Run /help to see the lot.

To narrow the bot's database access to the nine tables it owns, see the
instructions at the top of infra/postgres/community-bot-role.sql. Worth doing,
not urgent.

Logs, if something looks wrong:
  sudo docker compose --env-file $env_file -f $compose_file logs -f community-bot

DONE
