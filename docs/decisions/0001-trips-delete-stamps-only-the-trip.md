# 0001. trips.delete stamps only the trip row

- Date: 18 Oct 2026
- Status: accepted
- Source: [#45](https://github.com/eriscs01/tribo/pull/45)

## Context

Deleting a trip must hide everything in it: items, expenses, documents, members' access.
Soft-deleting each child row would work, but it needs a delete method in every module that
owns children, and trips.restore (slice 1b) would have to undo each of those stamps.
`tribo.is_member` and `tribo.item_visible` already treat a member of a soft-deleted trip as
a non-member (R18 in `0001_init.sql`).

## Decision

`trips.delete` sets `trips.deleted_at` and nothing else. Children are hidden through
`is_member` and `item_visible`, never stamped. Any new read of a trip's children joins
`trips.deleted_at IS NULL` or goes through those predicates.

## Consequences

- The deletion is one fact with one owner (the one-owner rule); trips.restore has a single
  value to clear.
- No module gains a delete method for this, so trips never reaches into the tables of items,
  expenses or documents.
- A read of trip children that bypasses the predicates would leak a deleted trip's rows; the
  leak tests in `packages/testkit` cover items and must be extended for each new child read.
