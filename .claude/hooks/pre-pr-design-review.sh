#!/bin/sh
# PreToolUse hook: refuse `gh pr create` until the PR body reports a design-principles review.
# The body must hold the `## Design principles` section of .github/pull_request_template.md,
# whether it is passed inline (--body, -b, a heredoc on --body-file -) or as a file.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
case "$cmd" in
  *"gh pr create"*) ;;
  *) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
# A line of its own, or the first line of an inline --body "…" (after its opening quote).
heading='(^|["'"'"'])## Design principles[[:space:]]*$'

# Inline bodies and heredocs are part of the command text itself.
if printf '%s\n' "$cmd" | grep -Eq "$heading"; then exit 0; fi

# A body file: --body-file <path>, --body-file=<path>, -F <path>; "-" means stdin (checked above).
file=$(printf '%s\n' "$cmd" | sed -nE "s/.*(--body-file[= ]|-F )[\"']?([^\"' ]+).*/\2/p" | head -n 1)
if [ -n "$file" ] && [ "$file" != "-" ]; then
  case "$file" in
    /*) path=$file ;;
    *) path="${cwd:-.}/$file" ;;
  esac
  if [ -f "$path" ] && grep -Eq "$heading" "$path"; then exit 0; fi
fi

cat >&2 <<'MSG'
Before opening this PR, review the branch against the design principles:
1. Run the design-principles skill over `git diff origin/main...HEAD`.
2. Fix each finding in this branch, or keep it as a follow-up.
3. Write the PR body from .github/pull_request_template.md and fill its `## Design principles`
   section with each finding and how it was handled (or "No findings").
Then run `gh pr create` again.
MSG
exit 2
