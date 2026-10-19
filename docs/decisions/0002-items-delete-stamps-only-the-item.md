# 0002. items.delete stamps only the item row

- Date: 19 Oct 2026
- Status: accepted
- Source: [#46](https://github.com/eriscs01/tribo/pull/46); follows [0001](0001-trips-delete-stamps-only-the-trip.md)

## Context

An item owns rows of its own (allocations, shares, RSVPs, attachments). Deleting an item
could stamp or remove them, as 0001 considered for a trip's children.

## Decision

`items.delete` sets `items.deleted_at` and bumps `version`. The item's children are hidden
because `tribo.item_visible` is false for a deleted item; none is stamped. Owners and
organizers delete any item, a member only their own. The operation takes no body.

## Consequences

- A restore of an item clears one value.
- Reads of an item's children must go through `item_visible` or join `items.deleted_at IS NULL`.
- Removing a member (`members.remove`, R32) still needs its own items-service method to
  soft-delete that member's private items; this decision does not provide it.
