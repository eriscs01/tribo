# 0009. Units and the assignment board

- Date: 22 Oct 2026
- Status: accepted
- Source: P6 units-board pull request (slice 1a, Drop A)

## Context

The design gives units (rooms, vehicles), the board, its `boardVersion` and the hard
invariants (capacity, one room per member per night, one driver per vehicle), but leaves
open: which items take which units, how unit rates mask, where "the same night" is looked
for, what tag `items.assignments.get` sends, and how a board row that breaks a row rule is
refused.

## Decision

- **A room belongs to a lodging, a vehicle to a ground rental.** Any other pairing is
  `validation_failed` at `/kind`; a vehicle takes no bed type. A unit's kind never changes.
- **A unit's rate masks exactly as its item's cost does** (`moneyView`): masked for a viewer
  without `canViewCosts` when a rate is stored, and, once the item restricts `cost`, for
  everyone but the item's owner and the trip's owner and organizers, stored or not
  (decision 0003). A rate written back masked is `masked_field_write`.
- **A label is unique among an item's live units**; a clash is `validation_failed` at
  `/label`, not a conflict code (the closed enum has none for it).
- **`room_double_booked`** is a member in two rooms of the item being saved, or in a live
  room of another live stay of the trip _that the caller can see_ (`tribo.item_visible`)
  sharing a night with it. A stay's nights run from its check-in day to its check-out day,
  each in its own zone, so checking out the day another stay checks in is no clash; an
  undated stay shares no night. Stays hidden from the caller are left out so the refusal
  never reveals a private booking. Only the saved item's lock is held, so two concurrent
  saves of _different_ stays can both pass; the next save of either sees the clash.
- **The board's ETag is its `boardVersion`**, quoted (`"3"`), the same counter
  `items.assignments.replace` takes as If-Match, so a client sends back the tag it read. The
  registry's `etag` gains a `board_version` kind beside `representation`; If-None-Match
  answers 304 for both.
- **Row rules are `validation_failed` with the row's path** (`/allocations/<i>/…`): a
  membership of another trip or a removed one, a unit not live on this item or of the wrong
  kind, a role held twice, a second seat for one member. Hard invariants keep their own
  codes. Every check runs on the final state, rows first.
- **`units.delete` always bumps `boardVersion`** and records the `item_board` change as a
  second event and snapshot of the same write (the board left behind), whether or not the
  unit held anyone.

## Consequences

- P7 `members.remove` deletes the leaving member's allocations and bumps each affected
  item's `boardVersion` the same way `units.delete` does, recording one `item_board` event
  per item.
- A later item type with units (a ferry's cabins) is one entry in `UNIT_KIND` and, if it
  needs a new kind, a migration widening `units.kind`.
- The warnings array is the design's closed set of rule codes; the board reports only
  `no_licensed_driver`. P8's itinerary reuses `Warning`.
