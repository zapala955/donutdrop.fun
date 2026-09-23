#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
compose_file="$repo_root/infra/docker/compose.yml"

if [[ ! -f "$env_file" ]]; then
  echo "Missing production environment file: $env_file" >&2
  exit 1
fi

cd "$repo_root"
compose=(docker compose --env-file "$env_file" -f "$compose_file")

# The vault bot sits behind a compose profile, so without this flag every deploy would treat a
# running vault as an orphan and remove it -- `--remove-orphans` below is not optional, it is what
# keeps a renamed service from lingering. Deciding from the environment rather than asking means
# nobody has to remember a flag on the one command that must not be got wrong.
if grep -q '^VAULT_BOT_ID=' "$env_file"; then
  compose+=(--profile vault)
  echo "Vault bot configured; deploying it too."
fi
# Same reasoning for the community bot: without its profile, `--remove-orphans` below would treat
# a running community bot as a leftover and delete it on the next ordinary deploy.
if grep -q '^COMMUNITY_APPLICATION_ID=.\+' "$env_file"; then
  compose+=(--profile community)
  echo "Community bot configured; deploying it too."
fi

# ── the API mounts the community key whether or not the bot is running ─────────────────────────
# A compose secret is a bind mount, and a bind mount whose source is missing stops the container
# being created -- so an api service that LISTS this secret cannot start until the file exists,
# even with COMMUNITY_BOT_ENABLED=false. Compose has no way to attach a secret conditionally, so
# the file is made unconditionally instead.
#
# A random value is the right placeholder: the gateway treats "enabled with no key" and "wrong
# key" identically, and a fixed placeholder shared across deployments would be a key an attacker
# could simply look up here. add-community-bot.sh reuses whatever this wrote.
community_hmac_file="${COMMUNITY_BOT_HMAC_KEY_FILE:-/opt/donutdrop/shared/secrets/community-bot-hmac-key}"
if [[ ! -s "$community_hmac_file" ]]; then
  secrets_dir="$(dirname "$community_hmac_file")"
  # Created if missing, mode left alone if not: it already holds every other secret.
  [[ -d "$secrets_dir" ]] || install -d -m 0700 "$secrets_dir"
  # printf, not echo: the loader rejects a secret file carrying anything but one line.
  printf '%s' "$(openssl rand -hex 32)" >"$community_hmac_file"
  # 0444 owned by root, matching every other secret here. The 0700 directory is what keeps them
  # private; the files inside are readable so any container user can mount them.
  chown 0:0 "$community_hmac_file"
  chmod 0444 "$community_hmac_file"
  echo "Generated $community_hmac_file (the API mounts it whether or not the bot runs)."
fi

"${compose[@]}" config --quiet

# Preserve the exact images currently serving traffic. If the new API never becomes ready they
# are retagged under their original Compose names and restarted. Migrations are forward-only and
# additive by policy; the update wrapper separately restores the checked-out static frontend.
rollback_file="$(mktemp)"
trap 'rm -f "$rollback_file"' EXIT
#
# EVERY STEP HERE IS BEST-EFFORT, ON PURPOSE.
#
# The first version tagged the running image with no guard, under `set -e`. A container whose image
# id no longer resolves in the local store — pruned, or rebuilt under the same tag and since
# collected — made `docker image tag` exit non-zero, and that killed the deploy before a single
# container had been touched:
#
#     Error response from daemon: No such image: sha256:c043e7d15bec...
#
# A rollback aid that can refuse a deploy is worse than no rollback aid at all. Losing the snapshot
# for one service costs the ability to roll THAT service back automatically; refusing to deploy
# costs the release. Each service is skipped with a line on stderr and the deploy carries on.
for service in api maintenance minecraft-bot minecraft-bot-vault; do
  # `head -n 1` because a scaled service prints several ids and `docker inspect` wants one.
  container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null | head -n 1 || true)"
  if [[ -z "$container_id" ]]; then
    continue
  fi
  image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || true)"
  image_id="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
  rollback_ref="donutdrop-rollback-${service}:previous"
  if [[ -z "$image_ref" || -z "$image_id" ]] \
    || ! docker image inspect "$image_id" >/dev/null 2>&1 \
    || ! docker image tag "$image_id" "$rollback_ref" 2>/dev/null; then
    echo "No rollback snapshot for $service; deploying without one." >&2
    continue
  fi
  printf '%s|%s|%s\n' "$service" "$image_ref" "$rollback_ref" >>"$rollback_file"
done

"${compose[@]}" up -d --build --remove-orphans

# nginx is recreated, not reloaded, and the difference matters.
#
# Its two config files are bind-mounted individually, and a single-file bind mount pins the inode.
# git does not edit a file in place — it writes a replacement and renames it — so after a pull the
# host has a new inode while the container is still looking at the old one. The file on disk is
# correct, `nginx -s reload` re-reads it, and nginx serves the previous contents anyway, because
# from inside the container nothing changed. A reload cannot fix this; only re-resolving the mount
# can, which means a new container.
#
# The frontend does not have this problem: it is mounted as a directory, and directory mounts
# track their contents.
"${compose[@]}" up -d --force-recreate nginx

for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error http://127.0.0.1:8080/health/ready >/dev/null; then
    echo "Donut Drop is ready behind the local TLS proxy on 127.0.0.1:8080"
    exit 0
  fi
  sleep 2
done

"${compose[@]}" ps >&2
"${compose[@]}" logs --tail=100 api nginx >&2
echo "Deployment did not become ready within 120 seconds" >&2

if [[ -s "$rollback_file" ]]; then
  echo "Restoring the previous service images..." >&2
  while IFS='|' read -r service image_ref rollback_ref; do
    # Same reasoning as the snapshot above: one service that cannot be restored must not abandon
    # the rest of the rollback half-finished.
    if ! docker image tag "$rollback_ref" "$image_ref" 2>/dev/null; then
      echo "Could not restore the previous image for $service." >&2
      continue
    fi
    "${compose[@]}" up -d --no-build --no-deps --force-recreate "$service" || true
  done <"$rollback_file"
  "${compose[@]}" up -d --no-build --no-deps --force-recreate nginx
  for attempt in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:8080/health/ready >/dev/null; then
      echo "Previous service images restored. The update wrapper will restore static files." >&2
      exit 1
    fi
    sleep 2
  done
  echo "Previous images were restored but did not become ready." >&2
fi
exit 1
