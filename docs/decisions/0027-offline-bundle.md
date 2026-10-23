# 0027. The offline bundle: who serves it, what is in it, and how it stays fresh

- Date: 24 Oct 2026
- Status: accepted
- Source: B5 offline bundle (trips.offlineBundle)

## Context

The design says "Save trip offline" fetches `GET /v1/trips/{id}/offline-bundle` ("my and group
itinerary, item details, contacts, file metadata") into IndexedDB, that sensitive fields are
masked in it because IndexedDB is not encrypted, that revealed values are never cached offline,
that the client polls it with `If-None-Match` on a SHA-256 ETag of the per-caller representation
(R12), and that a member offline opens "the itinerary, room and e-bike assignments, contacts and
the tickets they marked for offline". It does not say which module serves it, what each
collection holds for each role, what marks a ticket for offline (no column does), whether
overlays are in it, which cache headers it carries, how large it may grow, or how the client
learns that something is gone.

## Decision

- **The itinerary module serves it**, as it serves the dashboard (decision 0012): items depend on
  trips, so trips cannot compose items. It reads each part through its owner's service, never a
  table: the trip and the caller's membership (`memberTrip`) and the members (`tripMembers`, with
  the library's persons) from trips; items, units and boards (`tripItems`, `itemBoards`) and the
  caller's tickets and overlays (`ownTickets`, `ownOverlays`) from items; the ledger
  (`tripExpenses`) from expenses; file metadata (`tripFiles`) from documents. Each of these
  whole-trip reads takes the caller's active membership and runs the same visibility predicate
  and the same serializer as its per-resource read, in one query or a fixed few, so a bundle is
  a fixed number of queries whatever the trip holds and never N+1.
- **What is in it**, for every role, exactly as each read shows it to the caller: the trip; the
  caller's membership id; the trip's active members with their person (contacts as members.list
  shows them, emergency contact masked); every item the caller sees (masked as items.list
  masks); the units of those items (rates masked as units.list masks); each of those items' whole
  board (as items.assignments.get answers it); the group and the caller's own itinerary (days and
  warnings, as itinerary.get with `view=group` and `view=me`, the items not repeated); the
  caller's own tickets; the caller's own overlays; the live ledger (amounts masked for a viewer
  without the grant, a hidden item's link nulled); and the files the one file predicate allows,
  metadata only (a purged file as `purged`). Children of a hidden item (its units, board,
  tickets, overlays, files) are never in it, and an expense on one names no item.
- **"Tickets they marked for offline" are the caller's own tickets.** Nothing stores a mark, so
  the bundle carries every live ticket whose passenger is the caller's membership, on an item
  they see. Other passengers' tickets, which tickets.list shows online, are left out: the
  offline copy is the caller's own boarding pass, not the group's. A per-ticket mark, if one is
  ever wanted, is an additive column and an additive filter.
- **Overlays are the caller's own**, on items they see, and a viewer's none, as overlays.get
  says; another member's overlay is never read.
- **Nothing revealed, nothing sealed.** Booking refs, card last-4, ticket numbers and emergency
  contacts show only as `{"masked": true}` (or null when none is stored); the bundle reads no
  sealed column and no blob. The bytes of files a user marks for offline copy (design, "Web
  app") are fetched through files.download, which still answers `private, no-store`; how the
  web app keeps them is the web app's story.
- **Headers.** The registry declares `etag: 'representation'`: the ETag is the SHA-256 of the
  body sent to that caller, and a matching `If-None-Match` answers `304` with no body. Both
  answers carry `Cache-Control: private, no-store`: the bundle is per caller and holds what
  only they may read, so no HTTP cache (shared or the browser's) keeps it; the client keeps it
  in IndexedDB itself and revalidates with the ETag.
- **Deterministic.** Every collection is in a fixed order (id, which is UUIDv7, for all but the
  ledger, which goes by day spent then id, and overlays and boards, which go by item), and every
  object is built by one view with fixed keys, so an unchanged bundle keeps its ETag and two
  callers who read differently never share one.
- **A ceiling of 2000 rows per collection.** Each read asks for one row more than that; a
  collection that holds more is cut to its first 2000 and the bundle says `truncated: true`.
  The children of an item left out are left out with it. A trip of this product holds a few
  hundred items, so the ceiling is a bound, not a page size.
- **Removals.** The bundle is the caller's whole view each time, not a delta: whatever the next
  bundle lacks (deleted, voided, hidden, made private, its passenger removed, the caller
  removed) the client drops. A caller removed from the trip, or a deleted trip, gets
  `not_found`, the client's cue to delete the copy.
- **Refusals.** Every role may read it; anyone else gets `not_found`, with the same queries as
  for a trip that does not exist. It is a read, so an archived trip and a retired one still
  answer, and it writes no audit event.
- **`tripItems` now returns the units of the items it reads and each board row's unit**, read in
  the one units query it already ran (vehicles only before), so the itinerary and the dashboard
  cost what they did.

## Consequences

- Every record in the bundle carries its counter (`version`, an item's `boardVersion`), so
  release 3's offline outbox has the If-Match each edit needs; an overlay create needs
  `If-None-Match: *` (decision 0025).
- A new collection in the bundle is a whole-trip service read in its owner module with the same
  predicate and serializer as its per-resource read, plus the leak property's oracle for it.
- A bundle of a trip with a few hundred items is one fixed set of about twenty queries; the
  ceiling keeps an outlier bounded.
