#!/bin/sh
# PreToolUse hook: refuse `gh pr create` until the PR body reports both reviews the working
# rules ask for: the `## Design principles` and `## Test-driven development` sections of
# .github/pull_request_template.md, whether the body is passed inline (--body, -b, a heredoc
# on --body-file -) or as a file.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
case "$cmd" in
  *"gh pr create"*) ;;
  *) exit 0 ;;
esac

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

# A body file: --body-file <path>, --body-file=<path>, -F <path>; "-" means stdin (in the command).
body_file=
file=$(printf '%s\n' "$cmd" | sed -nE "s/.*(--body-file[= ]|-F )[\"']?([^\"' ]+).*/\2/p" | head -n 1)
if [ -n "$file" ] && [ "$file" != "-" ]; then
  case "$file" in
    /*) body_file=$file ;;
    *) body_file="${cwd:-.}/$file" ;;
  esac
fi

# The heading on a line of its own, or as the first line of an inline --body "…" (after its
# opening quote), in the command text itself or in the body file.
has_section() {
  heading='(^|["'"'"'])## '"$1"'[[:space:]]*$'
  if printf '%s\n' "$cmd" | grep -Eq "$heading"; then return 0; fi
  [ -n "$body_file" ] && [ -f "$body_file" ] && grep -Eq "$heading" "$body_file"
}

missing=0
if ! has_section 'Design principles'; then
  missing=1
  cat >&2 <<'MSG'
Missing `## Design principles`. Review the branch against the design principles:
1. Run the design-principles skill over `git diff origin/main...HEAD`.
2. Fix each finding in this branch, or keep it as a follow-up.
3. Fill the PR body's `## Design principles` section (.github/pull_request_template.md)
   with each finding and how it was handled (or "No findings").
MSG
fi
if ! has_section 'Test-driven development'; then
  missing=1
  cat >&2 <<'MSG'
Missing `## Test-driven development`. Review the branch's tests:
1. Run the test-driven-development skill over `git diff origin/main...HEAD`: every behaviour
   change has a test that was seen failing first, and every module boundary it crosses has a
   test through the real services against PostgreSQL.
2. Run `pnpm test:coverage`; it must pass its floors. Read what is left uncovered and add a
   test only where a rule is unproven, never just to raise the number.
3. Fill the PR body's `## Test-driven development` section (.github/pull_request_template.md)
   with the boundaries proven, each finding and how it was handled, and the coverage summary.
MSG
fi
if [ "$missing" -eq 0 ]; then exit 0; fi
echo 'Then run `gh pr create` again.' >&2
exit 2
