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

# nginx's configuration and the frontend bundle are bind-mounted, so changing either on disk gives
# compose no reason to recreate the container — and a container it does not recreate keeps serving
# whatever it parsed at startup. That is how a security header stayed stale through three deploys
# that all reported success. A reload costs nothing and picks the changes up; if the container was
# only just created and is not ready for a signal yet, recreating it does the same job.
docker compose --env-file "$env_file" -f "$compose_file" exec -T nginx nginx -s reload 2>/dev/null || docker compose --env-file "$env_file" -f "$compose_file" up -d --force-recreate nginx

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
