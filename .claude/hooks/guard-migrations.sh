#!/bin/sh
# PreToolUse hook: refuse edits to a migration that is already on origin/main.
# A merged migration is never edited; a change goes in a new numbered file.
file=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
case "$file" in
  */packages/db/migrations/*) ;;
  *) exit 0 ;;
esac

root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
rel=${file#"$root"/}

if git -C "$root" cat-file -e "origin/main:$rel" 2>/dev/null; then
  echo "$rel is merged on origin/main and must not be edited. Add a new numbered migration in packages/db/migrations/ instead." >&2
  exit 2
fi
exit 0
