# 0030. Finding unreferenced blobs: a read-only command

- Date: 24 Oct 2026
- Status: accepted
- Source: Q3 tidy-up (follow-up from decision 0021)

## Context

Decision 0021 accepts that a crash can leave a blob no `files` row names, or a `.tmp/` partial,
and the runbook told the operator to `rm` a key copied from a log line. A crash leaves no log
line, so nothing found such a blob. The command that lists them is a new operator surface on
the uploads volume, which holds ciphertext under random keys and nothing else.

## Decision

`tribo admin blobs unreferenced [--older-than-hours <n>]` lists blob keys and `.tmp/` partials
on the volume that no `files` row names (purged tombstones keep their key and count as naming
it), with size, count and total bytes. It never deletes; the runbook says how to remove one.

- **Age cut-off, 24 hours by default.** An upload stores its blob before its row commits, so a
  young blob is indistinguishable from an orphan for a moment. `--older-than-hours 0` lists
  everything, for a volume with the app stopped.
- **Only what this store writes is named.** A directory entry is read with `opendir` (one entry
  at a time, so memory is bounded by a batch of 500 keys), taken only if it is a regular file
  (never a link) whose name has the shape of a blob key or of `<32 hex>.partial` under `.tmp/`.
  Anything else is counted as "ignored" and never printed, so no file name or path from outside
  the store reaches the terminal.
- **The documents module owns it** (`BlobStore.list`, `FilesService.unreferencedBlobs`), as it
  owns the table and the volume; the CLI only prints.

## Consequences

- A volume that holds something foreign shows as "unexpected entries ignored"; the operator
  looks by hand.
- Removal stays manual by design: the list is the evidence, the `rm` is the operator's.
