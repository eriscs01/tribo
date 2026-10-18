#!/bin/bash
# Restores a pg_dump -Fc archive into the tribo database, inside a db container whose init
# script has just run (runbook step 11; restore.sh and the backup integration test run it):
#
#   restore-db.sh /path/to/tribo.dump      or the archive on stdin
#
# The bootstrap already made what a dump does not carry: the two roles with this instance's
# passwords, the database and its CONNECT grant. The archive brings every object with its
# owner (tribo_owner), tribo_app's grants and schema_migrations, so the app finds nothing to
# migrate. It refuses a database that is not empty, so it can never merge into live data.
set -euo pipefail

psql=(psql -v ON_ERROR_STOP=1 --no-psqlrc --username postgres --dbname tribo --tuples-only --no-align)

tables=$("${psql[@]}" -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
if [[ $tables != 0 ]]; then
  echo "tribo restore: the tribo database already has $tables tables; restore only into a fresh one" >&2
  exit 1
fi

# One transaction: a failed restore leaves the database empty, not half-restored.
pg_restore --username postgres --dbname tribo --exit-on-error --single-transaction "$@"

echo "tribo restore: restored $("${psql[@]}" -c "SELECT count(*) FROM audit.audit_events") audit events"
