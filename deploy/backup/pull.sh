#!/bin/sh
# Nightly backup, run on the operator's own machine (runbook step 10): pulls a database dump
# and the upload volume from the host over SSH into a dated snapshot on a disk you own, then
# keeps the newest TRIBO_BACKUP_KEEP snapshots. The host holds no credentials to that disk;
# its backup key can only run serve.sh.
#
#   sh deploy/backup/pull.sh          settings from ~/.config/tribo/backup.env (backup.env.example)
#
# A snapshot is a directory named by its Manila time, e.g. 2026-10-19T020000:
#   tribo.dump   pg_dump -Fc of the tribo database
#   uploads/     the upload volume (only once the host has one), hard-linked to the previous
#                snapshot where files are unchanged
#   manifest     time, release tag, dump size and SHA-256
# It appears under its final name only when complete; a failed run leaves a .partial
# directory that the next run deletes.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=snapshots.sh
. "$here/snapshots.sh"

config=${TRIBO_BACKUP_CONFIG:-$HOME/.config/tribo/backup.env}
# shellcheck source=/dev/null
[ -f "$config" ] && . "$config"

host=${TRIBO_BACKUP_HOST:?set TRIBO_BACKUP_HOST (an ssh destination, e.g. tribo-backup) in $config}
dir=${TRIBO_BACKUP_DIR:?set TRIBO_BACKUP_DIR (a directory on a disk you own) in $config}
keep=${TRIBO_BACKUP_KEEP:-7}
rsync=${TRIBO_RSYNC:-rsync}
ssh="ssh -o BatchMode=yes -o ServerAliveInterval=30"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') tribo backup: $*"; }
fail() {
  say "FAILED: $*" >&2
  exit 1
}

case $keep in '' | *[!0-9]* | 0) fail "TRIBO_BACKUP_KEEP must be a positive number, not '$keep'" ;; esac
[ -d "$dir" ] || fail "$dir does not exist; is the backup disk mounted?"

# One run at a time: a slow upload sync must not overlap the next night's run.
lock=$dir/.lock
mkdir "$lock" 2>/dev/null || fail "another run holds $lock (remove it if no run is active)"
trap 'rm -rf "$lock"' EXIT
rm -rf "$dir"/*.partial

stamp=$(snapshot_name)
work=$dir/$stamp.partial
mkdir "$work"
previous=$(list_snapshots "$dir" | tail -n 1)

status=$($ssh "$host" status) || fail "ssh $host status"
version=$(echo "$status" | sed -n 's/^TRIBO_VERSION=//p')
uploads=$(echo "$status" | sed -n 's/^uploads=//p')

say "dumping the database from $host (release ${version:-unknown})"
$ssh "$host" dump >"$work/tribo.dump" || fail "pg_dump on $host"
# Every custom-format dump starts with this magic; anything else is an error message.
[ "$(head -c 5 "$work/tribo.dump")" = PGDMP ] || fail "$work/tribo.dump is not a pg_dump archive"

if [ "$uploads" = yes ]; then
  say "syncing the upload volume"
  # The host's rrsync accepts only rsync 3's request syntax; macOS's own openrsync sends
  # another and is refused.
  "$rsync" --version 2>&1 | head -n 1 | grep -q '^rsync  *version' ||
    fail "$rsync is not rsync 3 (macOS ships openrsync): brew install rsync, then TRIBO_RSYNC=/opt/homebrew/bin/rsync"
  link=
  [ -n "$previous" ] && [ -d "$previous/uploads" ] && link="--link-dest=$previous/uploads"
  # -rlt, not -a: owners and groups are the host's uids, which mean nothing here; the restore
  # sets them. The trailing slashes copy the volume's contents, not the directory. No
  # --delete: the snapshot starts empty, and rrsync -ro refuses every delete option.
  # shellcheck disable=SC2086
  $rsync -rlt $link -e "$ssh" "$host:./" "$work/uploads/" || fail "rsync of uploads"
fi

{
  echo "created=$(manila_time '+%Y-%m-%dT%H:%M:%S%z')"
  echo "host=$host"
  echo "tribo_version=$version"
  echo "dump_bytes=$(wc -c <"$work/tribo.dump" | tr -d ' ')"
  echo "dump_sha256=$(sha256 "$work/tribo.dump")"
  echo "uploads=${uploads:-no}"
} >"$work/manifest"

mv "$work" "$dir/$stamp"
say "snapshot $dir/$stamp complete"

# Newest first; everything after the first $keep goes.
list_snapshots "$dir" | sort -r |
  tail -n +"$((keep + 1))" | while read -r old; do
  say "removing old snapshot $old"
  rm -rf "$old"
done
