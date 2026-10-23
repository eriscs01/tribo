# 0017. Idempotency-Key: where it is claimed, what is kept, how a replay says so

- Date: 23 Oct 2026
- Status: accepted
- Source: B0 Drop B prerequisites

## Context

The design (API design, "Idempotency"; `0001_init.sql` rule 6 and `tribo.idempotency_keys`)
says a create that honours `Idempotency-Key` keeps the key, the request hash and the response
for 24 hours per caller, answers `422 idempotency_key_reused` to the same key with another
body, and never stores a shown-once secret. It leaves open where the key is claimed, how
concurrent requests are serialised, which header marks a replay, and what an anonymous
caller's key belongs to. Claiming in a separate transaction before the operation runs would
hold a second pooled connection for the whole request (a pool deadlock under load), and a
reservation row committed on its own would survive a crash and block the key.

## Decision

- **The REST adapter resolves the key, the write path claims it.** For an operation where
  `honoursIdempotencyKey` holds, the adapter puts `{ caller, key, operationId }` in the
  request context; the write path claims it right after authorizing and validating, inside
  the write's own transaction. A story only declares the operation in the registry and in
  `IDEMPOTENCY_KEY_OPERATIONS`.
- **The claim is an insert that waits.** `INSERT … ON CONFLICT DO NOTHING` waits while
  another transaction holding the same key is in flight. If that one commits, this request
  replays its response; if it rolls back, this one runs. The claim commits only with the
  write, so a failed request stores nothing and its retry runs again.
- **The request hash** is the SHA-256 of the canonical JSON (keys sorted) of the path
  parameters and the body the write path validates. The key is scoped to the caller; the
  same key on another operation or path is `idempotency_key_reused`, as the table's key is
  `(caller, key)`.
- **The response is stored right after it is sent** (Fastify `onSend`), 2xx only, with every
  field the output schema marks `secret()` dropped and `redacted: true` set. A replay answers
  that status and body with `Idempotent-Replayed: true`, and logs `idempotent replay`.
- **The caller is the account** (`user:<id>`; `pat:<id>` and `oauth:…` when those land in
  1b). An operation that honours a key must not take anonymous callers: the server refuses to
  start otherwise. The client address is not used as a caller, so no IP address is stored in
  the database (IPs live in the logs only).
- **A replay is authorized like a first request.** The claim comes after `authorize`, so a
  caller who has lost access since (removed from the trip, the trip deleted) gets that
  refusal, not the stored body. What a replay can return is only ever the caller's own
  earlier answer, already masked for them, so the 24 hours add nothing they did not see.
- **A response that cannot be stored** (the database fails in `onSend`) is logged as
  `idempotent response not stored` at error, and the caller still gets the answer of the
  write that committed.
- **A committed claim with no stored response** (that failure, or the process dying
  between commit and reply) never runs the write again. A retry under the key waits at most
  2 s for the response, then answers `500 internal_error` and logs `unhandled error` naming
  the operation. Once the key expires (24 hours) it behaves as a new key. The contract's
  closed error set has no "still pending" code, and adding one is a contract change left
  for 1b; the runbook tells the operator what to tell the user.
- Expired keys are deleted before a claim and by the daily job.

## Consequences

- Between the write's commit and the stored response there is a window of a few
  milliseconds. A concurrent repeat waits up to 2 s for the response.
- A replay sends the stored status and body only, not other headers the first answer had.
- `files.upload` reads its whole body before the write path runs, so a repeated upload is
  streamed and stored before the claim refuses or replays it: B4 deletes the blob of a
  request that does not commit.
