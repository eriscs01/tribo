#!/bin/sh
# Creates random dev secrets in deploy/secrets/dev/ on first run; never overwrites.
# Dev only: files are world-readable so the postgres and app containers can read the bind
# mounts. Production secrets are created by the runbook with mode 600.
set -eu
dir="$(dirname "$0")/../secrets/dev"
mkdir -p "$dir"
for name in db_superuser_password db_owner_password db_app_password; do
  [ -s "$dir/$name" ] || openssl rand -hex 24 >"$dir/$name"
done
[ -s "$dir/app_key" ] || openssl rand -out "$dir/app_key" 32
chmod 644 "$dir"/*
