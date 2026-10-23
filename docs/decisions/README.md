# Decisions

A decision log for choices that the design docs do not settle, taken while building Tribo. The
design lives in [docs/design/](../design/); this folder holds what was decided _after_ it, and
why, so a later reader does not have to dig through pull request bodies.

Add an entry in the same pull request as the change whenever you decide something the docs
don't settle: a rule applied to more than one place, a choice between two workable designs,
a change to how the work is organised. A decision the design already states needs no entry.

## Format

One file per decision, named `NNNN-short-title.md` with the next free four-digit number.

```markdown
# NNNN. Title

- Date: 18 Oct 2026
- Status: accepted
- Source: pull request or who decided

## Context

What forced the choice, and what else was possible.

## Decision

What was decided, in the present tense.

## Consequences

What is now true, what it costs, and what to watch for.
```

Status is `accepted` or `superseded by NNNN`. An accepted file is never edited, except to
change its status to `superseded by NNNN` when a later decision replaces it. To change a
decision, add a new file that says which one it supersedes. Typos and broken links may be
fixed.

## Index

| No.                                                   | Date        | Decision                                                                 | Status   |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------ | -------- |
| [0001](0001-trips-delete-stamps-only-the-trip.md)     | 18 Oct 2026 | trips.delete stamps only the trip row                                    | accepted |
| [0002](0002-items-delete-stamps-only-the-item.md)     | 19 Oct 2026 | items.delete stamps only the item row                                    | accepted |
| [0003](0003-restricted-fields-masking.md)             | 19 Oct 2026 | Restricted item fields: who sees them, who sets them, who owns the set   | accepted |
| [0004](0004-one-pull-request-per-work-package.md)     | 18 Oct 2026 | One pull request per work package in slice 1a                            | accepted |
| [0005](0005-drop-a-is-api-only.md)                    | 18 Oct 2026 | Drop A is API only                                                       | accepted |
| [0006](0006-idempotency-key-only-where-honoured.md)   | 19 Oct 2026 | Idempotency-Key in OpenAPI only where 1a honours it                      | accepted |
| [0007](0007-membership-roles-and-placeholders.md)     | 22 Oct 2026 | Membership roles, cost grants and placeholders                           | accepted |
| [0008](0008-rate-limits-and-client-address.md)        | 22 Oct 2026 | Rate limits: what counts, against whom, which client address             | accepted |
| [0009](0009-units-and-the-assignment-board.md)        | 22 Oct 2026 | Units and the assignment board                                           | accepted |
| [0010](0010-dependency-graph-submitted-from-ci.md)    | 22 Oct 2026 | The dependency graph is submitted from CI                                | accepted |
| [0011](0011-invites-joins-and-removals.md)            | 22 Oct 2026 | Invite links, joins, claims and removals                                 | accepted |
| [0012](0012-itinerary-and-dashboard.md)               | 22 Oct 2026 | The itinerary and the dashboard in Drop A                                | accepted |
| [0013](0013-ci-path-rules-and-single-test-run.md)     | 22 Oct 2026 | CI path rules, step-level skips and one run of the tests                 | accepted |
| [0014](0014-published-images-are-the-scanned-ones.md) | 23 Oct 2026 | Published images are the scanned ones                                    | accepted |
| [0015](0015-reference-host-uses-acme-http.md)         | 23 Oct 2026 | The reference host uses acme-http                                        | accepted |
| [0016](0016-drop-b-is-api-only.md)                    | 23 Oct 2026 | Drop B is API only                                                       | accepted |
| [0017](0017-idempotency-key.md)                       | 23 Oct 2026 | Idempotency-Key: where it is claimed, what is kept, how a replay says so | accepted |
| [0018](0018-file-envelope.md)                         | 23 Oct 2026 | The file envelope: chunks of 64 KiB, AAD bound to file, index and end    | accepted |
| [0019](0019-blob-store-and-upload-ceiling.md)         | 23 Oct 2026 | The blob store and the upload ceiling                                    | accepted |
| [0020](0020-daily-job-runner.md)                      | 23 Oct 2026 | The daily job runner                                                     | accepted |
| [0021](0021-file-uploads.md)                          | 23 Oct 2026 | File uploads: the form, the type allowlist, names and no orphan blobs    | accepted |
