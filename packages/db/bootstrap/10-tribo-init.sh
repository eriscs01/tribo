#!/bin/bash
# Tribo database bootstrap for the postgres image's /docker-entrypoint-initdb.d.
# Runs once, as the superuser, on an empty data directory: 0000_bootstrap.sql (the two
# roles), their passwords from Docker secrets, then the tribo database. Everything else
# is created by the numbered migrations the app applies as tribo_owner.
#
# Mount this file in /docker-entrypoint-initdb.d and 0000_bootstrap.sql in a subdirectory
# (the entrypoint ignores subdirectories, so it never runs the SQL on its own).
set -euo pipefail

secrets_dir=${TRIBO_SECRETS_DIR:-/run/secrets}
bootstrap_sql=${TRIBO_BOOTSTRAP_SQL:-/docker-entrypoint-initdb.d/tribo/0000_bootstrap.sql}

read_secret() {
  local file="$secrets_dir/$1"
  if [[ ! -s $file ]]; then
    echo "tribo init: secret $1 is missing or empty in $secrets_dir" >&2
    exit 1
  fi
  if [[ ! -r $file ]]; then
    echo "tribo init: secret $1 is not readable by uid $(id -u); on the host the secret files must be mode 644 (docs/runbook.md, step 7)" >&2
    exit 1
  fi
  tr -d '\r\n' <"$file"
}

# Passed through the environment and read with \getenv, so they never appear in argv.
TRIBO_OWNER_PW=$(read_secret db_owner_password)
TRIBO_APP_PW=$(read_secret db_app_password)
export TRIBO_OWNER_PW TRIBO_APP_PW

psql=(psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "${POSTGRES_DB:-postgres}")

"${psql[@]}" --file "$bootstrap_sql"

"${psql[@]}" <<'SQL'
\getenv owner_pw TRIBO_OWNER_PW
\getenv app_pw TRIBO_APP_PW
ALTER ROLE tribo_owner PASSWORD :'owner_pw';
ALTER ROLE tribo_app PASSWORD :'app_pw';
CREATE DATABASE tribo OWNER tribo_owner ENCODING 'UTF8' TEMPLATE template0;
\c tribo
REVOKE ALL ON DATABASE tribo FROM PUBLIC;
GRANT CONNECT ON DATABASE tribo TO tribo_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL

unset TRIBO_OWNER_PW TRIBO_APP_PW
echo "tribo init: roles and database ready; the app applies migrations at start"
