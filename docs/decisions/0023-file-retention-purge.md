# 0023. The file retention purge: what is due, how a purge is written, what it leaves

- Date: 23 Oct 2026
- Status: accepted
- Source: B4 files

## Context

The design's retention rule: with `document_retention_days` = N (default 30), "a sensitive
file is due at trip end date + N days; any soft-deleted file, or a file of a deleted trip,
is due N days after its deletion". The daily job "deletes due blobs, sets `purged_at`,
replaces the filename with `purged` and writes a content-free `purge` event to the trip's
audit chain", and hard deletion "removes rows and snapshots". It does not say which deletion
a file of a deleted trip counts from, whether the purge goes through the write path, in what
order the blob and the row change, or what happens to the file's earlier snapshots.

## Decision

- **Due files** are those not yet purged where any of these holds, all measured by
  PostgreSQL's clock:
  - the file was soft-deleted at least N days ago;
  - its trip was soft-deleted at least N days ago (the trip's `deleted_at`, whatever the
    file's own state);
  - it is sensitive (`id`, `ticket`, `voucher`) and its trip's end date plus N days is
    before today.
- **The trips module answers for trips** (which are deleted or ended long enough ago) and
  identity for the setting; the documents module selects its own rows from those ids. No
  module reads another's table.
- **The purge is system work outside the write path.** The write path's trip guard refuses
  deleted and archived trips, which are exactly where purges happen, and the job has no
  account. Each file is purged in its own transaction, under its row lock:
  1. the row is checked to be still unpurged and still due;
  2. `purged_at` is set, `filename` becomes `purged`, `version` goes up by one;
  3. the file's earlier snapshots are deleted (they hold its name) and the tombstone is
     recorded as the new version's snapshot with a `purge` event on the trip's chain,
     carrying the job's `job-<uuid>` request id; neither holds a name or any content;
  4. the blob is deleted, last, then the transaction commits.
     A blob is deleted only by the key on the row being purged; nothing scans or globs the
     volume. If the blob delete fails, the transaction rolls back and the file is due again at
     the next run. If the commit fails after the delete, the row is still due and the next run
     completes it (deleting a missing blob is not an error).
- **A file that fails is logged and counted,** and the others still run: the job finishes
  with `due`, `purged` and `failed`, and each failure has a `file purge failed` line with
  the file id and the error.

## Consequences

- Nothing is due before mid-December for the first trip (its end date plus 30 days).
- After a purge, a file's history holds only its tombstone; `files.get` shows `purgedAt` and
  the name `purged` to whoever could see it, and `files.download` answers `file_purged`.
- A deleted trip's rows themselves stay until its audit chain retires (1b), as the design
  says; only the blobs and names go at N days.
