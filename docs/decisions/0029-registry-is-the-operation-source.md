# 0029. The registry is the one source of the operation list

- Date: 24 Oct 2026
- Status: accepted
- Source: Q3 tidy-up (R1 review, B4)

## Context

`packages/contract/operations.csv` and the registry (`src/operations/*.ts`) stored the same
fourteen fields for each of the 130 operations. A test kept them equal and an import script
generated registry files from the CSV, but refused to touch a file once a story had marked an
operation `implemented`. With every Drop A and Drop B file hand-owned, the CSV was a second owner
of the same fact.

## Decision

The registry is the one source. `operations.csv`, its parser, the row mapper, the import script
and the registry-against-CSV test are deleted. Every field the CSV carried (drop, slice, notes,
MCP tool, roles, flags) was already an `Operation` field, so `pnpm backlog` and `pnpm new:op`
read the registry unchanged and `docs/backlog.md` regenerates byte-identical. The design docs
that called the CSV the source now say the registry is.

`operationHandlers` also refuses two handlers for one operation id, so a `new:op` stub left in a
module file other than the one that holds the real handler fails at start-up instead of
shadowing it with a 501.

## Consequences

- A story edits only the registry file of its module; there is no CSV to keep in step.
- Nothing checks the registry against an outside list any more. The OpenAPI diff in CI (which
  carries roles, auth, `ifMatch` and idempotency per operation) is what shows an operation's
  contract changing.
- Schema-review and sprint documents dated before this change still mention the CSV as it was.
