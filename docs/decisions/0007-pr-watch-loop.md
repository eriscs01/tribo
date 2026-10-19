# 0007. The PR watch loop: Auto-fix in package sessions, one watcher in the orchestrator

- Date: 19 Oct 2026
- Status: accepted
- Source: the chore/pr-watch pull request; the user approved the watcher ("OK: build the
  orchestrator-side PR watcher as proposed, with decision entry 0007.")

## Context

Package sessions open one pull request each (0004). The desktop app's Auto-fix wakes a
session on CI failures, merge conflicts and review comments, but sends nothing when a PR
becomes ready to merge, merges or closes. A probe PR (#52) confirmed this: all checks passed
and it was closed, and neither woke the session. So nobody learnt a PR was ready or merged
unless someone polled. The app's guidance forbids sessions from polling CI themselves.

Options considered:

- **An MCP channel server pushing events into the session.** The app starts each session's
  CLI without `--channels` or `--dangerously-load-development-channels`, and nothing else
  turns channels on, so desktop sessions can't receive channel events.
- **A watcher in each package session.** One loop per PR on the same token, polling inside
  every session, against the guidance.
- **The Monitor tool.** It expires after at most 30 minutes, so a quiet day costs a turn every
  half hour.
- **A GitHub Actions comment when ready.** It covers only ready (not merged or closed), costs
  CI minutes and adds noise to the PR.
- **Auto-merge.** Ruled out: the user merges with `--admin` after a last look, and the
  ruleset's last-push approval would block it anyway.

What does wake an idle session in the app is a background Bash command that exits: the
harness re-invokes the session with the command's output.

## Decision

The **package session** opens its PR, then calls ccd_pr `get_status` (and `bind_pr` if
`bound` is false) and `set_monitor auto_fix:true`. On a `<ci-monitor-event>` it fixes,
verifies and pushes. It never polls CI or GitHub.

The **orchestrator** runs one watcher for all package PRs: `node tools/pr-watch/src/main.ts
--all`, started with one Bash `run_in_background` call. The watcher prints one line per event
and exits:

| Line                     | Meaning                                                                                            | The orchestrator                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PR #n ready <sha>`      | Every required check passed on the head, no unresolved review thread, no conflict, not behind main | Asks the user to merge: "PR #n ready to merge"                                                           |
| `PR #n behind <sha>`     | Ready except that main moved on (the ruleset requires an up-to-date branch)                        | Tells the owning session to bring the branch up to date with main and push                               |
| `PR #n ready-lost <sha>` | A push replaced a head that was ready                                                              | Nothing to relay; a later `ready` follows                                                                |
| `PR #n merged`           | Merged                                                                                             | Tells the owning session to clean up (Docker, branches, scratch files, worktree on main) and report done |
| `PR #n closed`           | Closed without merge                                                                               | Tells the owning session; the session reports                                                            |
| `no events`              | Its cap (8 hours) passed quietly                                                                   | Restarts it                                                                                              |

After every event line the orchestrator relays the event and restarts the watcher.

The watcher is level-triggered. On every pass it recomputes each PR's state and compares it
with a state file (`~/.cache/tribo-pr-watch/<owner>-<repo>.json`) of what was already emitted
per PR and head sha. So a Mac that slept, or a restart, recovers missed events and never
repeats one. Its requests and logging:

- conditional requests (ETag; a 304 does not count against the rate limit), at least 60
  seconds apart per PR;
- check runs only until they all pass for a head;
- review threads (GraphQL) only once the checks pass;
- the required check names read from the ruleset;
- the token read once from `gh auth token`, held in memory and redacted from every log line.

The watcher is dev-only tooling, in `tools/pr-watch/`, outside the product's `apps/` and
`packages/`. It uses no runtime dependencies beyond Node.

## Consequences

- This is a GitHub polling loop under a session, which the app's guidance advises against.
  The user accepted it explicitly because the app offers no event for ready, merged or closed
  and no other way to wake a session. It stays within that guidance's intent: one loop for
  all PRs instead of one per session, conditional requests, at least a minute apart, and
  package sessions never poll.
- The watcher runs only while the orchestrator session, the app and the Mac are up. Missed
  time is caught up on the next pass, not lost.
- Two GitHub limits stay outside the watcher: approval (last-push approval, dismissed on every
  push) and the merge itself. Both stay with the user.
- If the app ever sends an event for green, merged or closed, or passes channel flags to its
  sessions, this decision should be revisited and the watcher retired.
- Operating it (start, restart, state, logs) is in the runbook, "PR watcher".
