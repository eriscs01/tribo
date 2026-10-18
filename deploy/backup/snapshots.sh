# Sourced by pull.sh and restore.sh: what a snapshot directory is called, in one place.
# A snapshot is named by its Manila time, e.g. 2026-10-19T020000; an unfinished one ends in
# .partial.

snapshot_name() { TZ=Asia/Manila date +%Y-%m-%dT%H%M%S; }

# Complete snapshots in $1, oldest first.
list_snapshots() {
  find "$1" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]-*T*' ! -name '*.partial' | sort
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
