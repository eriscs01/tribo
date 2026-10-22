# 0013. CI path rules and one run of the tests

- Date: 22 Oct 2026
- Status: accepted
- Source: package C1 CI speed (branch `chore/ci-speed`)

## Context

A pull request's CI took about 14 runner minutes (5 minutes of wall time), and a pull request
that changed only a document paid all of it. The unit, integration and leak tests ran once in
their own jobs and again, with coverage, in the Coverage job. The required checks on ruleset
25300365 must each report, so a job cannot simply be left out.

## Decision

**Path rules.** Job "Changes" (`packages/story-kit/src/scripts/ci-changes.ts`, rules in
`ci-changes.ts`, tested) lists the files a pull request changes against its base and sets
`code=false` only when every one of them is documentation: prose under `docs/` (not
`docs/backlog.md`, which `backlog.test.ts` compares with the registry), the root `CLAUDE.md`,
`CONTRIBUTING.md`, `SECURITY.md` and `LICENSE`, `packages/*/README.md` and the Markdown under
`.claude/skills/`. Everything else counts as code, so the rule fails towards running everything:
`.github/**` (workflows, actions, scripts), `deploy/**` (including its READMEs), migrations,
the lockfile, every `package.json`, `.nvmrc`, all test and lint configuration (vitest, eslint,
prettier, tsconfig, knip, squawk, gitleaks, dependency-cruiser, osv-scanner, Trivy) and any
file the rules do not name. An empty change counts as no code. A push to `main`, a tag, the
nightly run and Publish always run everything.

**Step-level skips.** Unit, Integration, Leak properties, Coverage, Typecheck, the lockfile
scan, the image builds and scans, and End to end gate each step on
`needs.changes.outputs.code != 'false'`, never the job, so each still reports success. An empty
output (the Changes job failed) runs everything. Lint and format, Secret scan, API breaking
changes and CodeQL always run in full, so formatting, secrets, the contract diff and code
scanning are never skipped.

**One run of the tests.** Unit, Integration and Leak properties run once, with V8 coverage and
the blob reporter, and upload their blob reports. Coverage downloads the three, merges them
(`vitest --merge-reports --coverage`, no PostgreSQL) and enforces the floors in
`vitest.config.ts` unchanged. It fails unless all three jobs succeeded. Under `--coverage` the
tests import the TypeScript source, so these jobs no longer run `pnpm build`; the built `dist`
is still exercised by Typecheck, the web build and End to end.

**Caches.** The TypeScript build state (`tsconfig.tsbuildinfo` and `dist`) is cached for
Typecheck and End to end, keyed on the lockfile and tsconfig files; a miss is a full build.
ESLint is not cached: its type-aware rules (`strictTypeChecked`) read other files' types, and
`--cache` keys a result on the linted file alone, so a change to a dependency's types could pass
a file that now fails. A cache that is correct only when keyed on every source file would never
hit.

**Leak suite.** Measured at about 75 s of tests in CI and not on the critical path (Build and
scan, then End to end, take longer), so it is not sharded: a shard pays the checkout, install
and PostgreSQL start again for no wall-time gain on the critical path, and "Leak properties"
would become a matrix whose check names differ from the ruleset's. The world count is
unchanged on every event; the nightly run still uses a random seed.

**Images.** Build and scan builds each image as End to end runs it (same tag, release build
arguments), scans it, and passes it on as an artifact; End to end loads it instead of
rebuilding. What Trivy scanned is what the walking skeleton tests.

## Consequences

Documentation-only pull requests finish in the time of the Changes job plus the always-on jobs.
A new kind of file that should count as documentation is added to the rules with a test; a
path nobody listed runs everything. A new required check must follow the same step-level
pattern. The runbook explains how to tell a skipped run from a real one.
