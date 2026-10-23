# Contributing to Tribo

Read [CLAUDE.md](CLAUDE.md) first: the one-owner rule, the repo layout and the working rules
(one task per branch and PR, `main` protected, merged migrations never edited) apply to every
change. The design lives in [docs/design/](docs/design/); decisions taken while building that
it does not settle are in [docs/decisions/](docs/decisions/), and a PR that makes one adds its entry.

## Slice 1a stories

Slice 1a is 68 operations from `packages/contract/operations.csv`: 46 in Drop A (due Sun 1 Nov)
and 22 in Drop B (due Sun 8 Nov). [docs/backlog.md](docs/backlog.md) lists them by module,
tagged by drop; it is generated, so never edit it by hand.

One story is one operation, on one branch and one PR. Start it with:

```bash
pnpm new:op items.update
```

The scaffold reads the operation's registry entry and adds what is missing:

| Part                 | Where                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| Input, Patch, Output | `packages/contract/src/<resource>.ts`; existing schemas are reused         |
| Registry entry       | `packages/contract/src/operations/<module>.ts`, set to `implemented`       |
| Policy row           | `packages/core/src/<module>/policy.ts`, from the CSV's trip roles          |
| Handler              | `apps/server/src/handlers/<module>.ts`, a stub answering `not_implemented` |
| Integration test     | `packages/testkit/src/<id>.int.test.ts`, tagged `drop-a` or `drop-b`       |
| Leak registration    | `packages/testkit/src/<id>.leak.test.ts` (list reads), via `listProperty`  |

It then formats those files and regenerates `openapi.json`, the web client and the backlog. It never
overwrites: each part it finds already present is kept, so rerunning it after hand edits is
safe. The service and repository methods are the story's own work, in
`packages/core/src/<module>/service.ts` and `repo.ts`.

The scaffold is a starting point, not a finished story. The handler answers
`not_implemented`, the integration test is a list of todos, and the leak test fails until its
`read` calls the service.

Run one drop's tests with `pnpm vitest run --tags-filter drop-b`.

### Drop B limits

Slice 1a ships some operations narrower than their CSV row. Each limit is written into the
stories it binds, in the backlog and in the scaffolded tests:

- **Idempotency-Key** is honoured only on `expenses.create`, `files.upload` and
  `tickets.create`. The other
  creates the CSV marks `key` take no Idempotency-Key in 1a; they get it in 1b.
- **FX:** expenses are in the trip currency only, so `fx_rate` = 1.
- **Splits** are equal or itemised only; weight splits come after the trip.

### Follow-ups

Follow-ups a pull request raises but does not do are triaged into
[docs/follow-ups.md](docs/follow-ups.md): deferred ones with the slice they wait for, dropped
ones with the reason. Check it before raising one again.

### Definition of done

A 1a story is done when all of these hold:

- [ ] The registry entry's status is `implemented`, its handler is real (it no longer
      answers `not_implemented`), and `pnpm backlog` has ticked it.
- [ ] The `openapi.json` diff has been reviewed. The PR says what changed in the contract, and
      the committed file matches `pnpm --filter @tribo/contract openapi`.
- [ ] Tests exist and pass for the policy (each role the CSV allows and refuses, and
      `not_found` outside the trip), for leaks (list reads registered through `listProperty`
      against the oracle in `packages/testkit/src/leak.ts`), and for the audit event (each write
      records its event and `entity_versions` snapshot in the same transaction). None of the
      scaffold's todos are left.
- [ ] Errors use the closed enum in `packages/contract/src/errors.ts` only: no new codes in
      the story, no free-text errors, and no internal messages in responses.
- [ ] If-Match follows the CSV's `if_match` column: `no` takes none; `version`,
      `board_version` and `budget_version` require that counter (`if_match_required` when
      missing, `version_conflict` when stale); `version_or_new` creates with
      `If-None-Match: *` and replaces with If-Match.
- [ ] The Drop B limits above hold for this operation.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass, and the PR follows
      `.github/pull_request_template.md`.
