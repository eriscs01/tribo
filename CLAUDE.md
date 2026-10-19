# Tribo

Trip organizer platform. Design lives in `docs/design/` (Technical Design, Operation inventory, Sprint 0, PRD); read the relevant part before changing anything. Decisions taken while building, that the design docs don't settle, are in `docs/decisions/`.

## The one-owner rule

Every fact has exactly one owner, and only that owner stores, changes, versions and enforces it. Rows are roots, owned rows, credentials or logs. The database declares what one row can express; the service's write path enforces anything that needs other rows, the caller or the clock. Inside a trip a person is their membership; outside it, their account. Derived state (archived, expired, sensitive, freshness) is computed, never stored. The header of `packages/db/migrations/0001_init.sql` is the authoritative statement of this rule and of which module owns which table.

## Repo layout

```
apps/server/       Fastify bootstrap, REST adapter, CLI (tribo admin|audit …), daily jobs
apps/web/          React SPA, service worker, generated API client
apps/e2e/          Playwright walking-skeleton test against a running Compose stack
packages/contract/ Zod schemas, defineOperation, registry, error codes, OpenAPI generator; operations.csv
packages/platform/ request context, write-path wrapper, idempotency, logging, rate limits
packages/crypto/   app key loader, field and file envelopes
packages/db/       migrations/*.sql, runner, generated Kysely types
packages/core/<module>/  service.ts · repo.ts · policy.ts  (identity, trips, items, itinerary, expenses, documents, library, audit)
packages/testkit/  Testcontainers setup, factories, leak-test generators
tools/pr-watch/    dev-only: the orchestrator PR watcher (docs/decisions/0007)
deploy/            compose.yml, compose.dev.yml, .env.example, caddy/, backup/
docs/              design/, runbook.md
```

Boundary rule: a module's `repo.ts` gets a Kysely handle typed to its own tables only; other modules call its `service.ts`, never its repo or tables. dependency-cruiser enforces this in CI.

## Working rules

- One Sprint 0 task per branch, named `s0/<n>-<slug>`, and one PR per task. Stay inside the task's scope and meet its acceptance criteria in `docs/design/sprint-0.md` exactly.
- `main` is protected: changes land only through pull requests.
- A decision the docs don't settle gets an entry in `docs/decisions/` in the same PR (format in its README).
- Never edit a migration that has been merged. Add a new numbered file instead.
- Never commit secrets, `.env` files, database dumps or real trip data. Fixtures use invented people and trips.
- Run `pnpm lint && pnpm typecheck && pnpm test` before opening a PR, and list in the PR how each acceptance criterion is proven (test name or command).
- Apply the `design-principles` skill while writing code. Before opening a PR, review the branch diff (`git diff origin/main...HEAD`) with it: fix each finding, or list it in the PR as a follow-up. The PR body follows `.github/pull_request_template.md`, including its `## Design principles` section; a hook refuses `gh pr create` without that section.
- Apply the `test-driven-development` skill: write each test first and see it fail, and prove every module boundary a change crosses with an integration test that goes through the real services (composed by `composeServices` in `apps/server/src/runtime.ts`, served by `buildApp` in `apps/server/src/app.ts`) against PostgreSQL. Cross-module and adapter tests live beside the existing `*.int.test.ts` files in `packages/testkit` and `apps/server`; privacy properties go in `*.leak.test.ts`. Before opening a PR, review the branch's tests with the skill and fill the PR body's `## Test-driven development` section; the same hook refuses `gh pr create` without it.
- Apply the `debuggability` skill: a production problem must be diagnosable from the request id a user quotes. Every refusal and failure leaves a log line with the request id, the operation id and the error code (never values or secrets), no error is swallowed, the request id crosses every module and job boundary, and a new failure mode, job or command gets a runbook entry. Prove log lines with tests that read the captured output. Before opening a PR, review the branch diff with the skill and fill the PR body's `## Debuggability` section; the same hook refuses `gh pr create` without it.
- `pnpm lint` also runs squawk over the migrations from 0002 on (`.squawk.toml`) and knip for unused files, exports and dependencies (`knip.jsonc`); an exclusion or ignore carries its reason. CI also checks the OpenAPI diff against the base branch (a breaking change needs the `api-breaking` label), the initial JS budget (`pnpm check:bundle`) and gitleaks over the PR's commits.
- `pnpm test:coverage` runs all three projects against the TypeScript source with V8 coverage (local, no external service); CI job "Coverage" fails below the floors in `vitest.config.ts`. Read the uncovered lines as a list of rules that may be unproven: add a test only where one is, asserting that rule, never to move the number. Raise a floor when coverage rises; never lower one to merge.
- `pnpm dev:up` starts the local stack (PostgreSQL 18, the app in watch mode, Caddy) at https://tribo.localhost with a seeded demo trip; see `deploy/dev/README.md`.
- `pnpm test` runs three Vitest projects: `unit` (`*.test.ts`, no I/O), `integration` (`*.int.test.ts`) and `leak` (`*.leak.test.ts`). The last two start one PostgreSQL 18 container per run through Testcontainers, so they need Docker; run one with `pnpm test:unit`, `test:integration` or `test:leak`. Integration tests get a fresh migrated database from `createTestDatabase()` in `@tribo/testkit` and build data with its factories.
- `pnpm test:e2e` runs the Playwright walking-skeleton test (`apps/e2e`) against a stack that is already up: `pnpm dev:up` by default, or the one `COMPOSE_FILE` names (CI job "End to end" uses `deploy/compose.yml`). Run `pnpm build` first, and `pnpm --filter @tribo/e2e exec playwright install chromium` once.
