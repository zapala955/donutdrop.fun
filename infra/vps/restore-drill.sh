#!/usr/bin/env bash
set -euo pipefail

backup_env="${BACKUP_ENV_FILE:-/opt/donutdrop/shared/backup.env}"
if [[ ! -f "$backup_env" ]]; then
  echo "Missing backup settings: $backup_env" >&2
  exit 1
fi
if ! command -v restic >/dev/null 2>&1; then
  echo "restic is required" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$backup_env"
set +a
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY in backup.env}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE in backup.env}"

image='postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0'
container="donutdrop-restore-drill-$(date -u +%Y%m%d%H%M%S)-$$"
password="$(openssl rand -hex 24)"

cleanup() {
  if [[ "$container" == donutdrop-restore-drill-* ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker run --detach --name "$container" \
  --env POSTGRES_PASSWORD="$password" --env POSTGRES_DB=donut_upgrader_restore \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=2g \
  "$image" >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d donut_upgrader_restore >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo "Temporary restore database did not start" >&2
    exit 1
  fi
  sleep 1
done

restic dump latest /postgres/donut_upgrader.dump | \
  docker exec -i "$container" pg_restore \
    --username postgres --dbname donut_upgrader_restore --no-owner --no-privileges --exit-on-error

docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d donut_upgrader_restore -c \
  "SELECT public.donut_schema_ready_v41();
   SELECT count(*) AS users FROM users;
   SELECT count(*) AS ledger_rows FROM wallet_transactions;
   SELECT count(*) AS audit_rows FROM audit_log;" >/dev/null

echo "Restore drill passed in isolated container $container; production was not touched."
