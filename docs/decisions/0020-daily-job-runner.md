# 0020. The daily job runner

- Date: 23 Oct 2026
- Status: accepted
- Source: B0 Drop B prerequisites

## Context

The design runs daily jobs in the app process, "a timer guarded by a Postgres advisory
lock", with no queue. It does not say when in the day a job runs, what the lock guards
against, how a run is told apart in the logs, or where jobs are registered. The deferred
follow-up from #48 asked the first job to bring a prefixed request id.

## Decision

- **The runner lives in `apps/server`** (`src/jobs/run.ts`), beside the CLI runner: both are
  process-level entry points. Jobs are registered in one list, `src/jobs/index.ts`, built
  from the composed services; a new job is a new entry.
- **Every job runs when the app starts and then every 24 hours**, one after another. There
  is no fixed hour: every job is safe to repeat (it acts on what is due), so a restart that
  runs them again costs nothing, and there is no schedule table to keep.
- **Each run takes the job's session advisory lock**, `hashtextextended('tribo.job:<name>', 0)`,
  on a connection of its own, with `pg_try_advisory_lock`. If another process holds it (two
  app containers during an upgrade), the run is skipped and logged as `job skipped`.
- **Each run mints `job-<uuid>`** as its request id, passed in the request context to every
  service it calls (so its audit events carry it) and bound to its log lines with the job's
  name. It logs `job started`, then `job finished` with its counts and duration or `job
failed` at error with the error. A failure never stops the process or the other jobs.
- The first job is `idempotency-keys`, which deletes keys past `expires_at`.

## Consequences

- An operator follows a run as a request: `tribo audit request job-<uuid>` lists what it
  changed (runbook, "Daily jobs").
- A job that must run at a fixed time of day, or less often than daily, needs a schedule of
  its own; none does in 1a.
- The file purge (B4) is a new entry in `src/jobs/index.ts`.
