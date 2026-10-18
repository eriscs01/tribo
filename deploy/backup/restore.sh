#!/bin/sh
# Restore check (runbook step 11), run on a machine with Docker, never on the production host:
# brings up the scratch Compose project tribo-restore from a snapshot pull.sh made, restores
# the dump and the uploads into it, then runs `tribo audit verify`.
#
#   sh deploy/backup/restore.sh [snapshot dir]    the newest snapshot by default
#   sh deploy/backup/restore.sh --down            deletes the scratch project, its volumes and
#                                                 its copy of the app key
#
# Settings come from ~/.config/tribo/backup.env (backup.env.example). The scratch project has
# its own volumes, network and passwords; it publishes only 127.0.0.1:TRIBO_RESTORE_PORT and
# serves https://restore.tribo.localhost:<port> with Caddy's internal CA.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=snapshots.sh
. "$here/snapshots.sh"

config=${TRIBO_BACKUP_CONFIG:-$HOME/.config/tribo/backup.env}
# shellcheck source=/dev/null
[ -f "$config" ] && . "$config"

project=tribo-restore
deploy=$(dirname "$here")
port=${TRIBO_RESTORE_PORT:-8443}
work=${TRIBO_RESTORE_WORK:-$HOME/.local/state/tribo-restore}

say() { echo "tribo restore: $*"; }
fail() {
  say "FAILED: $*" >&2
  exit 1
}
compose() {
  docker compose --project-name "$project" --project-directory "$deploy" --env-file "$work/restore.env" \
    -f "$deploy/compose.yml" -f "$here/compose.restore.yml" "$@"
}

# The scratch project is meant for your own machine; on a Docker engine that also runs the
# production project it would compete with it for memory and disk.
if [ -n "$(docker ps --all --quiet --filter label=com.docker.compose.project=tribo)" ]; then
  fail "this Docker engine runs the production project 'tribo'; run the restore check elsewhere"
fi

if [ "${1:-}" = --down ]; then
  [ -f "$work/restore.env" ] || fail "no scratch project to delete ($work/restore.env is missing)"
  compose down --volumes --remove-orphans
  rm -rf "$work"
  say "scratch project $project deleted"
  exit 0
fi

snapshot=${1:-}
if [ -z "$snapshot" ]; then
  dir=${TRIBO_BACKUP_DIR:?set TRIBO_BACKUP_DIR in $config or pass a snapshot directory}
  snapshot=$(list_snapshots "$dir" | tail -n 1)
  [ -n "$snapshot" ] || fail "no snapshot in $dir"
fi
snapshot=$(cd "$snapshot" && pwd)
manifest=$snapshot/manifest
[ -f "$manifest" ] || fail "$snapshot has no manifest; it is not a complete snapshot"
value() { sed -n "s/^$1=//p" "$manifest"; }

app_key=${TRIBO_APP_KEY_FILE:?set TRIBO_APP_KEY_FILE to your copy of the app key (runbook step 7)}
[ -s "$app_key" ] || fail "$app_key is missing or empty"
version=${TRIBO_RESTORE_VERSION:-$(value tribo_version)}
[ -n "$version" ] || fail "the manifest names no release; set TRIBO_RESTORE_VERSION"

say "checking $snapshot"
[ "$(sha256 "$snapshot/tribo.dump")" = "$(value dump_sha256)" ] || fail "tribo.dump does not match its manifest checksum"

# Start from nothing: the previous check's volumes and passwords go first.
if [ -f "$work/restore.env" ]; then compose down --volumes --remove-orphans; fi
rm -rf "$work"
# Compose bind-mounts file secrets with their host permissions (it ignores uid and mode
# outside Swarm), so the files are readable by the container users and the directory by
# you alone.
mkdir -p "$work/secrets"
chmod 700 "$work"
for name in db_superuser_password db_owner_password db_app_password; do
  openssl rand -hex 32 >"$work/secrets/$name"
done
cp "$app_key" "$work/secrets/app_key"
chmod 644 "$work/secrets"/*
cat >"$work/restore.env" <<EOF
TRIBO_VERSION=$version
TRIBO_PUBLIC_URL=https://restore.tribo.localhost:$port
TRIBO_TLS_MODE=internal
TRIBO_TRUSTED_PROXIES=none
COMPOSE_PROFILES=
TRIBO_RESTORE_PORT=$port
TRIBO_RESTORE_SECRETS=$work/secrets
EOF

say "starting the database of $project (release $version)"
compose pull --quiet
# The init script creates the roles and an empty database; the app is not started yet, so
# it cannot migrate the database before the dump is in.
compose up --detach --wait db
compose exec -T db bash -c "$(cat "$here/restore-db.sh")" restore-db.sh <"$snapshot/tribo.dump"

if [ -d "$snapshot/uploads" ]; then
  compose config --volumes | grep -qx uploads ||
    fail "the snapshot has uploads but compose.yml at $deploy has no uploads volume"
  say "restoring the uploads"
  compose create app
  # The app runs as node (uid 1000); the snapshot's owners are this machine's.
  docker run --rm --user 0 --platform linux/amd64 --entrypoint sh \
    -v "${project}_uploads:/data" -v "$snapshot/uploads:/src:ro" \
    "ghcr.io/eriscs01/tribo-app:$version" -c 'cp -R /src/. /data/ && chown -R 1000:1000 /data'
fi

say "starting the app and the proxy"
compose up --detach --wait
say "verifying every audit chain"
compose exec -T app tribo audit verify || fail "tribo audit verify found a broken chain"

say "passed. Open https://restore.tribo.localhost:$port, sign in and open a trip."
say "Delete the scratch project afterwards: sh $here/restore.sh --down"
