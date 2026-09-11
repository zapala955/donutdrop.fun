#!/bin/sh
set -eu

read_secret() {
  secret_path=$1
  secret_name=$2
  if [ ! -r "$secret_path" ]; then
    echo "$secret_name secret is not readable" >&2
    exit 1
  fi
  secret_value=$(sed 's/\r$//' "$secret_path")
  case "$secret_value" in
    *'
'*)
      echo "$secret_name must contain exactly one line" >&2
      exit 1
      ;;
  esac
  if [ "${#secret_value}" -lt 32 ]; then
    echo "$secret_name must contain at least 32 characters" >&2
    exit 1
  fi
  printf '%s' "$secret_value"
}

superuser_password=$(read_secret /run/secrets/postgres_superuser_password postgres_superuser_password)
migrator_password=$(read_secret /run/secrets/postgres_migrator_password postgres_migrator_password)
runtime_password=$(read_secret /run/secrets/postgres_runtime_password postgres_runtime_password)
audit_password=$(read_secret /run/secrets/postgres_audit_password postgres_audit_password)
if [ "$superuser_password" = "$migrator_password" ] || \
   [ "$superuser_password" = "$runtime_password" ] || \
   [ "$superuser_password" = "$audit_password" ] || \
   [ "$migrator_password" = "$runtime_password" ] || \
   [ "$migrator_password" = "$audit_password" ] || \
   [ "$runtime_password" = "$audit_password" ]; then
  echo 'PostgreSQL migrator, runtime, and audit passwords must be distinct' >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=migrator_password="$migrator_password" \
  --set=runtime_password="$runtime_password" \
  --set=audit_password="$audit_password" \
  --set=database_name="$POSTGRES_DB" <<'SQL'
SELECT format(
  'CREATE ROLE donut_migrator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'migrator_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_migrator') \gexec
SELECT 'CREATE ROLE donut_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_api_runtime') \gexec
SELECT 'CREATE ROLE donut_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_audit_reader') \gexec
SELECT 'CREATE ROLE donut_api_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_api_login') \gexec
SELECT 'CREATE ROLE donut_audit_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'donut_audit_login') \gexec

SELECT format(
  'ALTER ROLE donut_migrator WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'migrator_password'
) \gexec
SELECT format(
  'ALTER ROLE donut_api_login WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'runtime_password'
) \gexec
SELECT format(
  'ALTER ROLE donut_audit_login WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
  :'audit_password'
) \gexec
ALTER ROLE donut_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE donut_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

GRANT donut_api_runtime TO donut_api_login;
GRANT donut_audit_reader TO donut_audit_login;
ALTER DATABASE :"database_name" OWNER TO donut_migrator;
ALTER SCHEMA public OWNER TO donut_migrator;
REVOKE CONNECT, TEMPORARY ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO donut_migrator, donut_api_runtime, donut_audit_reader;
REVOKE ALL ON SCHEMA public FROM donut_api_login, donut_audit_login;

ALTER ROLE donut_migrator SET statement_timeout = '5min';
ALTER ROLE donut_migrator SET idle_in_transaction_session_timeout = '1min';
ALTER ROLE donut_migrator SET search_path = public;
ALTER ROLE donut_api_login SET statement_timeout = '8s';
ALTER ROLE donut_api_login SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE donut_api_login SET search_path = public;
ALTER ROLE donut_audit_login SET statement_timeout = '30s';
ALTER ROLE donut_audit_login SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE donut_audit_login SET default_transaction_read_only = on;
ALTER ROLE donut_audit_login SET search_path = public;
SQL

touch "$PGDATA/.donut-security-bootstrap-v1"
