#!/bin/sh
# Dev app process: install Linux deps into the node_modules volumes, build once, then keep
# rebuilding on change (tsc -b -w) and restart the server whenever its output changes.
set -eu
pnpm install --frozen-lockfile --prefer-offline
pnpm build
pnpm exec tsc -b -w --preserveWatchOutput &
exec node --watch apps/server/dist/main.js
