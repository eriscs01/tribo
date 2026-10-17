# Tribo

Trip organizer platform. Design lives in `docs/design/` (Technical Design, Operation inventory, Sprint 0, PRD); read the relevant part before changing anything.

## The one-owner rule

Every fact has exactly one owner, and only that owner stores, changes, versions and enforces it. Rows are roots, owned rows, credentials or logs. The database declares what one row can express; the service's write path enforces anything that needs other rows, the caller or the clock. Inside a trip a person is their membership; outside it, their account. Derived state (archived, expired, sensitive, freshness) is computed, never stored. The header of `packages/db/migrations/0001_init.sql` is the authoritative statement of this rule and of which module owns which table.

## Repo layout

```
apps/server/       Fastify bootstrap, REST adapter, CLI (tribo admin|audit …), daily jobs
apps/web/          React SPA, service worker, generated API client
packages/contract/ Zod schemas, defineOperation, registry, error codes, OpenAPI generator; operations.csv
packages/platform/ request context, write-path wrapper, idempotency, logging, rate limits
packages/crypto/   app key loader, field and file envelopes
packages/db/       migrations/*.sql, runner, generated Kysely types
packages/core/<module>/  service.ts · repo.ts · policy.ts  (identity, trips, items, itinerary, expenses, documents, library, audit)
packages/testkit/  Testcontainers setup, factories, leak-test generators
deploy/            compose.yml, compose.dev.yml, .env.example, caddy/, backup/
docs/              design/, runbook.md
```

Boundary rule: a module's `repo.ts` gets a Kysely handle typed to its own tables only; other modules call its `service.ts`, never its repo or tables. dependency-cruiser enforces this in CI.

## Working rules

- One Sprint 0 task per branch, named `s0/<n>-<slug>`, and one PR per task. Stay inside the task's scope and meet its acceptance criteria in `docs/design/sprint-0.md` exactly.
- `main` is protected: changes land only through pull requests.
- Never edit a migration that has been merged. Add a new numbered file instead.
- Never commit secrets, `.env` files, database dumps or real trip data. Fixtures use invented people and trips.
- Run `pnpm lint && pnpm typecheck && pnpm test` before opening a PR, and list in the PR how each acceptance criterion is proven (test name or command).
- `pnpm dev:up` starts the local stack (PostgreSQL 18, the app in watch mode, Caddy) at https://tribo.localhost with a seeded demo trip; see `deploy/dev/README.md`.
- `pnpm test` runs three Vitest projects: `unit` (`*.test.ts`, no I/O), `integration` (`*.int.test.ts`) and `leak` (`*.leak.test.ts`). The last two start one PostgreSQL 18 container per run through Testcontainers, so they need Docker; run one with `pnpm test:unit`, `test:integration` or `test:leak`. Integration tests get a fresh migrated database from `createTestDatabase()` in `@tribo/testkit` and build data with its factories.
