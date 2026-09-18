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
docker compose --env-file "$env_file" -f "$compose_file" config --quiet
docker compose --env-file "$env_file" -f "$compose_file" up -d --build --remove-orphans

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
docker compose --env-file "$env_file" -f "$compose_file" up -d --force-recreate nginx

for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error http://127.0.0.1:8080/health/ready >/dev/null; then
    echo "Donut Drop is ready behind the local TLS proxy on 127.0.0.1:8080"
    exit 0
  fi
  sleep 2
done

docker compose --env-file "$env_file" -f "$compose_file" ps >&2
docker compose --env-file "$env_file" -f "$compose_file" logs --tail=100 api nginx >&2
echo "Deployment did not become ready within 120 seconds" >&2
exit 1
