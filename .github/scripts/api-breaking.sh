#!/usr/bin/env bash
# Compare two OpenAPI documents with oasdiff: the changelog goes to the job summary (or
# stdout), and a breaking change fails unless ALLOW_BREAKING=true.
# Usage: api-breaking.sh <base-openapi.json> <new-openapi.json>
set -euo pipefail

base=$1
new=$2
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}

{
  echo "## API changelog"
  echo
  changes=$(oasdiff changelog "$base" "$new" --format markdown)
  if [ -n "$changes" ]; then echo "$changes"; else echo "No API changes."; fi
} >>"$summary"

if breaking=$(oasdiff breaking "$base" "$new" --fail-on ERR 2>&1); then
  echo "No breaking API changes."
  exit 0
fi

echo "$breaking"
{
  echo
  echo "### Breaking changes"
  echo
  echo '```'
  echo "$breaking"
  echo '```'
} >>"$summary"

if [ "${ALLOW_BREAKING:-false}" = "true" ]; then
  echo "Breaking API changes allowed: the pull request carries the api-breaking label."
  exit 0
fi
echo "::error::Breaking API changes. Fix them, or label the pull request api-breaking if they are intended."
exit 1
