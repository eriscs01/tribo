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

| No.                                                 | Date        | Decision                                                               | Status   |
| --------------------------------------------------- | ----------- | ---------------------------------------------------------------------- | -------- |
| [0001](0001-trips-delete-stamps-only-the-trip.md)   | 18 Oct 2026 | trips.delete stamps only the trip row                                  | accepted |
| [0002](0002-items-delete-stamps-only-the-item.md)   | 19 Oct 2026 | items.delete stamps only the item row                                  | accepted |
| [0003](0003-restricted-fields-masking.md)           | 19 Oct 2026 | Restricted item fields: who sees them, who sets them, who owns the set | accepted |
| [0004](0004-one-pull-request-per-work-package.md)   | 18 Oct 2026 | One pull request per work package in slice 1a                          | accepted |
| [0005](0005-drop-a-is-api-only.md)                  | 18 Oct 2026 | Drop A is API only                                                     | accepted |
| [0006](0006-idempotency-key-only-where-honoured.md) | 19 Oct 2026 | Idempotency-Key in OpenAPI only where 1a honours it                    | accepted |
| [0007](0007-membership-roles-and-placeholders.md)   | 22 Oct 2026 | Membership roles, cost grants and placeholders                         | accepted |
