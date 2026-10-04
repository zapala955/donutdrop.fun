#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
compose_file="$repo_root/infra/docker/compose.yml"
cd "$repo_root"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing to deploy over tracked local changes." >&2
  exit 1
fi

previous_commit="$(git rev-parse HEAD)"
git fetch origin main
git merge --ff-only origin/main
next_commit="$(git rev-parse HEAD)"

if COMPOSE_ENV_FILE="$env_file" "$repo_root/infra/vps/deploy.sh"; then
  echo "Deployed $next_commit (previous $previous_commit)."
  exit 0
fi

echo "Deployment failed; restoring repository and static frontend to $previous_commit." >&2
git reset --hard "$previous_commit"
docker compose --env-file "$env_file" -f "$compose_file" up -d --force-recreate --no-deps nginx

for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8080/health/ready >/dev/null; then
    echo "Rollback to $previous_commit is healthy." >&2
    exit 1
  fi
  sleep 2
done

echo "Automatic rollback also failed. Inspect docker compose logs immediately." >&2
exit 2
