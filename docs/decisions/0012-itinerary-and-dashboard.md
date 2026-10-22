# 0012. The itinerary and the dashboard in Drop A

- Date: 22 Oct 2026
- Status: accepted
- Source: P8 itinerary-dashboard pull request (slice 1a, Drop A: itinerary.get, trips.dashboard)

## Context

The design gives the itinerary (dated items the caller can see, each in its own zone, a stay
as check-in, nights and check-out), the closed set of rule codes, and the dashboard's
contents (countdown, next item, open tasks, due soon, my share, warnings). It leaves open
what `view=me` keeps, which rules Drop A can check, how a warning names its items without
naming hidden ones, which module serves the dashboard, and what "open tasks" and "due soon"
are before typed item details, overlays and `me.tasks` land in Drop B.

## Decision

- **`view=me`** keeps the items the caller's membership owns, and those it has any row on
  the board of (attendee, occupant, driver, passenger, assignee), except an attendee who
  answered "no". `view=group` keeps every item the caller can see (`tribo.item_visible`).
- **Days are local.** Each item is bucketed by its own start and end zones; an item on one
  day shows `whole`, a longer one `start` and `end`, a stay `check_in`, one `staying` line
  for each night between, and `check_out`. `from`/`to` keep the days of that inclusive range
  (and the items those days name); without them every dated item shows. Undated items are on
  no day.
- **Rules checked in Drop A** are the ones stored data supports:
  - `overlap`: two items of a type someone attends for its length (transport, activity,
    meal), timed with an end, not cancelled, whose times overlap (touching is not), with at
    least one membership on both boards (an attendee's "no" does not count). One warning per
    pair, `itemId` the lower id and `withItemId` the other.
  - `no_licensed_driver`, P6's board rule (`boardWarnings`) run on every visible rental's
    vehicles.
  - `missing_transfer`, `non_refundable`, `non_changeable`, `deposit_due` and
    `missing_add_on` need typed item details, places on items and tickets, none of which the
    API writes yet. They join with those stories; the codes are already in `WarningCode`.
- **Warnings see only what the caller sees.** Every rule runs on the caller's visible items
  and their boards alone, so a warning can never name, count or hint at a hidden item (no
  clash with a private item, no driver warning on a hidden rental). The leak properties prove
  it by reading again with every hidden item deleted and getting the same answer.
- **`Warning` gains `itemId` and `withItemId`** (optional, additive), for reads that cover
  many items.
- **The dashboard is served by the itinerary module**, the read-only engine over the other
  modules (Sprint 0 layout), and mounted as `trips.dashboard`. The trips module cannot
  serve it: items already depend on trips, so trips depending on items would be a cycle. It
  reads the trip through the trips service, items through the items service and my share
  through the expenses service, never their tables.
- **Dashboard contents in Drop A:**
  - Countdown: the trip's dates, days until it starts (0 once it has), and whether it is
    upcoming, underway or over, by today in the trip's time zone.
  - Next item: the first visible item, not a task, note or document and not cancelled or
    done, that starts after now (a timed item) or today or later (an all-day one).
  - Open tasks: visible task items, not done or cancelled, assigned to the caller, or owned
    by the caller with nobody assigned, by due then id. A task's due is its `start` until
    typed details give tasks their own due date.
  - Due soon: those open tasks due within the next 7 days or overdue. Drop B adds overlay
    `reminder_at` entries (overlays) and the cross-trip list (`me.tasks`); each entry names
    its `kind` so they can join without a breaking change.
  - My share: the sum of the caller's shares on the trip's expenses that are not voided,
    in the trip currency (R36: no balance, no who-owes-whom); zero with no expenses.
  - Warnings: the group itinerary's warnings over the whole trip.
- **Money on the dashboard masks as the ledger does**: my share is masked, zero or not, for a
  viewer without `canViewCosts`; items mask as `items.list` does, through the one serializer.
- **The dashboard's ETag is the representation's** (rule 4): the registry declares
  `etag: 'representation'`, so the countdown changing at midnight changes the tag too.

## Consequences

- Drop B's overlays story adds `reminder` entries to `dueSoon`; `me.tasks` reuses the open
  task rule across trips. The per-type detail stories add their rule checks to the itinerary
  engine (`itinerary/timeline.ts`), which every summary read shares.
- Both reads run a fixed number of queries whatever the trip holds; a test pins that.
- A dashboard poll costs a full build; the 304 saves only the transfer. A trip of a few
  hundred items builds well inside the 300 ms read target.
