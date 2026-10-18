#!/bin/sh
# The only thing the backup key may run on the host (runbook step 10). Its authorized_keys
# line forces this script:
#   restrict,command="/opt/tribo/backup/serve.sh" ssh-ed25519 AAAA… tribo-backup
# so a stolen backup key can read backups and nothing else: no shell, no sudo, no writes.
#
# Requests (SSH_ORIGINAL_COMMAND, sent by pull.sh):
#   status        prints TRIBO_VERSION=<tag> and uploads=yes|no
#   dump          writes `pg_dump -Fc` of the tribo database to stdout
#   rsync …       read-only rsync of the upload volume, through rrsync
set -eu

deploy_dir=${TRIBO_DEPLOY_DIR:-/opt/tribo}
# Compose names volumes <project>_<volume>; the project is `tribo` (compose.yml).
upload_dir=/var/lib/docker/volumes/tribo_uploads/_data

cd "$deploy_dir"

case ${SSH_ORIGINAL_COMMAND:-} in
  status)
    grep '^TRIBO_VERSION=' .env
    if sudo -n test -d "$upload_dir"; then echo uploads=yes; else echo uploads=no; fi
    ;;
  dump)
    # The superuser over the container's local socket: it reads every schema, and the dump
    # keeps each object's owner (tribo_owner) and tribo_app's grants for the restore.
    exec docker compose exec -T db pg_dump --username postgres --dbname tribo --format custom
    ;;
  'rsync --server --sender '*)
    # rrsync (shipped with rsync) checks the request and confines it to the volume, read-only.
    exec sudo -n --preserve-env=SSH_ORIGINAL_COMMAND /usr/bin/rrsync -ro "$upload_dir"
    ;;
  *)
    echo "tribo backup: refused '${SSH_ORIGINAL_COMMAND:-}'; this key only serves status, dump and rsync" >&2
    exit 1
    ;;
esac
