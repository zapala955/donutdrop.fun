#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${COMPOSE_ENV_FILE:-/opt/donutdrop/shared/donutdrop.env}"
backup_env="${BACKUP_ENV_FILE:-/opt/donutdrop/shared/backup.env}"
compose_file="$repo_root/infra/docker/compose.yml"

if [[ ! -f "$env_file" || ! -f "$backup_env" ]]; then
  echo "Missing $env_file or $backup_env" >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$backup_env")" != "600" ]]; then
  echo "$backup_env must have mode 0600" >&2
  exit 1
fi
if ! command -v restic >/dev/null 2>&1; then
  echo "restic is required (it encrypts and uploads the backup)" >&2
  exit 1
fi

set -a
# This file is root-owned and mode 0600. It contains only RESTIC_* assignments.
# shellcheck disable=SC1090
source "$backup_env"
set +a
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY in backup.env}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE in backup.env}"

compose=(docker compose --env-file "$env_file" -f "$compose_file")
"${compose[@]}" exec -T postgres sh -euc '
  export PGPASSWORD="$(cat /run/secrets/postgres_superuser_password)"
  pg_dump --username postgres --dbname donut_upgrader --format=custom --compress=9
' | restic backup --stdin --stdin-filename /postgres/donut_upgrader.dump \
  --tag donutdrop --tag postgres

# A database restored without the data-encryption and audit keys is incomplete. Store the secret
# directory in the same encrypted repository, never in an unencrypted tarball on the VPS.
restic backup /opt/donutdrop/shared/secrets \
  --tag donutdrop --tag secrets \
  --exclude /opt/donutdrop/shared/secrets/minecraft-auth

restic check --read-data-subset=2%
restic forget --tag donutdrop --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune
echo "Encrypted off-host database and secret backup completed."
