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
"${compose[@]}" config --quiet

# Preserve the exact images currently serving traffic. If the new API never becomes ready they
# are retagged under their original Compose names and restarted. Migrations are forward-only and
# additive by policy; the update wrapper separately restores the checked-out static frontend.
rollback_file="$(mktemp)"
trap 'rm -f "$rollback_file"' EXIT
for service in api maintenance minecraft-bot; do
  container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$container_id" ]]; then
    continue
  fi
  image_ref="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
  rollback_ref="donutdrop-rollback-${service}:previous"
  docker image tag "$(docker inspect --format '{{.Image}}' "$container_id")" "$rollback_ref"
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
    docker image tag "$rollback_ref" "$image_ref"
    "${compose[@]}" up -d --no-build --no-deps --force-recreate "$service"
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
