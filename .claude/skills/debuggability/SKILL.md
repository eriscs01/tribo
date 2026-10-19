---
name: debuggability
description: Keep a production service easy to diagnose from one request id, with logs that never leak. Use when adding or changing an entry point, an error path, a refusal, a background job, a command-line command, a retry, a timeout or anything that can fail at run time; when touching logging, error handling, request context or start-up; when reviewing a change for operability; or when the user asks about logging, observability, tracing, incidents, debugging production or runbooks.
---

# Debuggability: diagnose a production problem from one request id

When something goes wrong in production, the operator usually has one thing: the reference
a user quotes, which is the request id. Every change must leave behind enough that, from
that id alone, the operator can find what was asked, which operation ran, who it ran as,
what it refused or how it failed, how long it took, which release served it and what it
changed, without a debugger, without reproducing it and without reading a single value the
caller sent.

The project's own rules come first. Read its instructions file and the design documents it
points to for what the operations design allows (log format, where logs go, how long they
are kept, what is forbidden: a metrics server, a hosted log service, anything that leaves
the host) and which fields are sensitive. Where they are explicit, they win.

## 1. One id, end to end

- **Every unit of work has a request id**, minted at its entry or accepted from a trusted
  hop in front: an HTTP request, a command-line run, a scheduled job run, a message handled.
  Work that no user started (jobs, commands, start-up) mints its own, with a prefix that
  names its kind, so a reader can tell a job's lines from a user's.
- **The id travels with the work.** Pass it in the request context across module
  boundaries, into the transaction and into every record the work writes (audit events,
  history, outbound calls), so the logs and the stored records join on it. Work that
  continues out of band (a callback, a deferred task, a retry) carries the id it was given;
  it never takes a fresh one silently.
- **The caller gets it back.** Every response carries the id, in a header and in every error
  body, and the user interface shows it next to any failure, so a user can quote it.
- **Every log line about the work carries the id**, through a child logger bound once at the
  entry, not by passing it to each call by hand.

## 2. Say what happened, as fields

- **One line per outcome.** Each finished unit of work leaves one line naming the operation
  (its stable id from the contract, not only the path), its status and its duration. A
  refusal adds its stable error code; a failure adds the error with its stack.
- **Refusals are visible.** An expected refusal (a validation failure, a denied permission,
  a conflict) is logged at info or warn with its error code and the operation, never at
  error, and never silently. A spike in one code is how most production problems show up.
- **Failures are loud, once.** An unexpected error is logged at error with its stack exactly
  where it is turned into a generic answer; it is never logged and re-thrown at every layer,
  and never logged at a level that hides it.
- **Structured fields over messages.** The message is a short fixed phrase you can search
  for ("request refused", "slow request", "job finished"); everything variable goes in named
  fields (codes, ids, counts, durations, statuses). Never build a message by interpolating
  values.
- **Name the release.** The start-up line, and ideally every line, says which version and
  commit is running, and an operator can read it without a shell in the container (a command
  or an admin-only page). Public health checks stay detail-free.
- **Slowness is an event.** When the design states latency budgets, a request that exceeds
  its budget logs a warn line with its duration and the budget, so a slow path is found by
  searching, not by guessing.

## 3. Never lose an error

- **No swallowed errors.** A `catch` either handles the error completely (and the outcome
  is logged or returned), translates it into the contract's error type, or lets it through.
  An empty catch, a catch that only returns a default, or a promise nobody awaits is a bug.
- **Process-level failures are logged, then fatal.** An uncaught exception or unhandled
  rejection is logged with the request id when one is in scope, then the process exits with
  a failure code so the supervisor restarts it into a known state. It never keeps serving in
  an unknown one.
- **Expected degradation is logged once, not per call.** A dropped connection or an
  unavailable dependency the service recovers from logs a warn line naming the dependency
  and the error code.
- **Start-up fails with a name.** A bad configuration value or a missing secret stops the
  process with the variable or file it is about, never the value.

## 4. Log nothing sensitive

- **Ids and codes, never values.** Log identifiers, error codes, field paths, counts and
  durations. Never request or response bodies, field values the caller sent, query strings
  that can carry tokens, or anything the data model marks sensitive.
- **Redact by name, centrally.** Credentials, cookies, tokens, codes and secrets are redacted
  by the logger's configuration wherever they appear in a logged object, and a test proves
  each name is redacted. A new secret-bearing field is added to that list in the same change.
- **Errors can leak too.** A database or library error can quote the value that failed; log
  its code and constraint, and never send its message to the caller.
- **Nothing leaves the host** unless the design says so. Logs go to the process's standard
  output in the agreed format, and the platform's log driver keeps and rotates them.

## 5. Leave the operator a path

- **A runbook entry for every new failure mode, job or command**: what its log lines say,
  how to find them by request id, what the operator does about each, and how to confirm it
  is fixed.
- **Join logs and stored records from one id.** Where the work writes audit or history
  records, an operator command or admin page lists them by request id, so the log lines and
  what changed can be read side by side.
- **Make the log level a switch.** The level is configuration, raisable for a while without
  a rebuild, and debug lines are written so that turning them on is safe (still no values).

## How to use this skill

**When writing code:** for each entry point, error path, job or command you add or change,
answer: what id does it carry, what line does it leave on success, refusal and failure, at
what level, with which fields, and what does the runbook say about it? Prove the answers
with tests that read the captured log lines: the line exists, carries the id, the operation
and the code, and contains none of the values sent.

**When reviewing:** report only findings that would change the code, the tests or the
runbook, each as

```
<file>:<line> — <gap>: <what an operator could not see or what leaks> → <change>
```

ordered by impact: a leaked secret or value first, then a swallowed error or a failure with
no log line, then a broken id (work that loses or replaces its request id), then a refusal
logged at the wrong level or without its code, then a missing runbook entry, then message
and field style.
