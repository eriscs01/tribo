#!/bin/sh
# Refuses a Docker Engine or Compose older than docker-minimum.env, which compose.yml needs.
# Run it before `docker compose up` on install and on every upgrade (docs/runbook.md).
set -eu
. "$(dirname "$0")/docker-minimum.env"

# Exits non-zero when $2 (installed) sorts before $1 (minimum) as a version.
at_least() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]; }

engine=$(docker version --format '{{.Server.Version}}')
compose=$(docker compose version --short)
compose=${compose#v}
status=0
if at_least "$DOCKER_ENGINE_MIN" "$engine"; then
  echo "Docker Engine $engine (at least $DOCKER_ENGINE_MIN)"
else
  echo "Docker Engine $engine is older than $DOCKER_ENGINE_MIN; upgrade docker-ce (runbook step 4)" >&2
  status=1
fi
if at_least "$DOCKER_COMPOSE_MIN" "$compose"; then
  echo "Docker Compose $compose (at least $DOCKER_COMPOSE_MIN)"
else
  echo "Docker Compose $compose is older than $DOCKER_COMPOSE_MIN; upgrade docker-compose-plugin (runbook step 4)" >&2
  status=1
fi
exit "$status"
