# 0006. Idempotency-Key in OpenAPI only where 1a honours it

- Date: 19 Oct 2026
- Status: accepted
- Source: [#49](https://github.com/eriscs01/tribo/pull/49)

## Context

`operations.csv` marks 21 operations as taking an Idempotency-Key, but slice 1a honours it
on only two (`expenses.create`, `files.upload`). Declaring the header on the rest told
clients that replays are safe where they are not.

## Decision

The OpenAPI document declares `Idempotency-Key` only on operations for which
`honoursIdempotencyKey` holds. The list of those operations is owned by `@tribo/contract`
(`drop-limits.ts`); the generator, the backlog and the scaffold read it. `x-tribo.idempotent`
still shows the CSV value.

## Consequences

- The header appears on more operations as they gain support in 1b, by editing the one list.
- The API-breaking check treats the header's later appearance as an addition, not a break.
