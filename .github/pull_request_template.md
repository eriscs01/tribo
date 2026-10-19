<!-- One Sprint 0 task per PR (CLAUDE.md, "Working rules"). Keep every heading below. -->

## What changes

<!-- The task (number and name) and what this PR adds, in a few bullets. -->

## How each acceptance criterion is proven

| Criterion | Proof (test name or command) |
| --------- | ---------------------------- |
|           |                              |

## Design principles

<!--
Review `git diff origin/main...HEAD` with the design-principles skill
(.claude/skills/design-principles). List each finding as
`<file>:<line> — <principle>: <what is wrong> → <change>` and say how it was handled:
fixed in this PR, or a follow-up (with its issue or PR). Write "No findings" if there are none.
-->

- [ ] The diff was reviewed with the design-principles skill
- [ ] Each finding is fixed here or listed as a follow-up

## Test-driven development

<!--
Review the branch's tests with the test-driven-development skill
(.claude/skills/test-driven-development). List each module boundary the change crosses and
the test that crosses it through the real services, then each finding as
`<file>:<line> — <gap>: <what is unproven or wrong> → <test to add or change>` and how it was
handled: fixed in this PR, or a follow-up. Write "No findings" if there are none.
Paste the summary of `pnpm test:coverage`, and say whether a floor in vitest.config.ts was
raised. A test added only to raise coverage, with no rule to assert, is a finding.
-->

- [ ] Each behaviour change started as a test that was seen failing for the right reason
- [ ] Each module boundary the change crosses has a test through the real services
- [ ] `pnpm test:coverage` passes its floors, and no test exists only to raise the number

## Debuggability

<!--
Review `git diff origin/main...HEAD` with the debuggability skill (.claude/skills/debuggability).
For each entry point, error path, job or command the change adds or alters, say what a
production problem would leave behind: its request id, the log line on success, refusal and
failure (operation id, error code, level), and the test that reads that line. List each
finding as `<file>:<line> — <gap>: <what an operator could not see or what leaks> → <change>`
and how it was handled: fixed in this PR, or a follow-up. Name the runbook section added or
changed for a new failure mode, job or command. Write "No findings" if there are none.
-->

- [ ] Every refusal and failure the change adds leaves a log line with the request id, the operation id and the error code, and no values or secrets
- [ ] No error is swallowed, and the request id is carried across every module or job boundary crossed
- [ ] The runbook covers any new failure mode, job or command

## Checks

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
