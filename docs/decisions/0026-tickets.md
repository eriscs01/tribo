# 0026. Tickets: the sealed number, who edits what, and which refusal says what

- Date: 24 Oct 2026
- Status: accepted
- Source: B2 tickets (tickets.list, create, update, delete, reveal)

## Context

The design gives a ticket `seat`, a sealed `ticket_no_enc` and `baggage`, says children follow
their item's visibility (G4: the item's owner and the trip's owners and organizers manage
tickets, a member edits the seat and baggage of their own), that the number is masked for
everyone and revealed through an audited call, and that board saves never touch tickets. It
leaves open which closed code answers a ticket on a non-transport item, a passenger who is not
in the trip and a second ticket for one passenger; what the sealed number is bound to; whether
a ticket of a passenger who has left still exists; what a member who cannot reveal a ticket is
told; and whether `tickets.create` takes an Idempotency-Key (the CSV marks it `key`, decision
0006 declared the header only where it is honoured).

## Decision

- **The number is sealed per ticket and masked by one serializer.** `ticket_no_enc` holds the
  field envelope bound to `tickets.ticket_no_enc` and the ticket's own id (AAD), so a sealed
  number copied to another ticket does not open. The id is minted before the insert for that.
  Every read answers `ticketNo` as `{"masked": true}` when one is stored and `null` when none is,
  for everyone, the passenger and the item's owner included; the read queries do not select the
  column at all (only whether it is set), and only `tickets.reveal` reads it.
- **Snapshots hold the sealed bytes, never the plaintext.** A ticket's `entity_versions`
  snapshot carries `ticketNoEnc` (base64 of the sealed value), as the item's snapshot carries
  `bookingRefEnc`, so a restore can copy a ticket forward and the number still opens for that
  ticket id. Audit events hold ids, counters and, for a reveal, the field path `/ticketNo`.
- **Refusals use the closed set.** A ticket on any item type but `transport`, a passenger who is
  not an active membership of the item's trip (another trip's, a removed one, an unknown id: one
  message), and a second live ticket for a passenger on an item (checked by the unique index
  `tickets_item_member_key`, so a race loses the same way) are all `validation_failed`, at
  `/itemId` or `/passenger`, as a unit label clash is. A member sending `ticketNo` or
  `passenger` on their own ticket, and anyone sending a masked `ticketNo` back, get
  `masked_field_write`.
- **A placeholder's membership is a passenger** (decision 0007); a ticket follows its membership
  id when an invite claim moves the membership to an account.
- **A ticket of a passenger who has left does not exist.** Every ticket read and write looks the
  passenger's membership up and answers `not_found` once it is removed; a rejoin (which undeletes
  the membership) brings the ticket back. Removing a member therefore does not touch the tickets.
- **One answer for what the caller may not know of.** Every ticket-by-id operation looks the
  ticket up, then its item through `tribo.item_visible`, then the caller's membership, then the
  passenger's, running all four queries whatever the first finds (the sentinel of decision 0024),
  so an unknown ticket, a deleted one, one on a hidden or deleted item, one of a removed
  passenger and one in a trip the caller is not in are the same `not_found` at the same cost. The
  role weighs in only after that.
- **Edit scope (G4).** `tickets.update` changes everything for whoever manages the item's tickets
  (the trip's owners and organizers, and a member on an item they own); a member changes only
  `seat` and `baggage` of a ticket that is theirs; nobody else, and no viewer, changes anything
  (`forbidden`). Being assigned to the item is not enough. `tickets.create` and `tickets.delete`
  are for the managers alone. The patch is a merge patch (absent keeps, null clears; baggage merges
  key by key); an empty patch still bumps the version, as `units.update` does.
- **Reveal.** The trip's owners and organizers reveal any ticket's number, a member only their own
  ticket's (owning the item is not enough). A viewer is `forbidden`, even for their own ticket.
  Another member's ticket is `not_found` to a member: their reach ends at their own ticket, so
  the refusal cannot tell them whether one exists or whose it is. A reveal takes `{fields:
["ticketNo"]}` (the design's `{fields}` shape) and answers `{ticketNo}`, `null` when none is
  stored, with `Cache-Control: private, no-store`. Each call writes one `reveal` event on
  `ticket` with reason `/ticketNo` before the number is opened, in the same transaction, so a
  number that fails to open (tampered or moved) rolls the event back and answers `internal_error`.
  It takes no Idempotency-Key and is allowed on archived trips; a retired trip is
  `trip_retired`.
- **`tickets.create` honours Idempotency-Key** (decision 0017), added to
  `IDEMPOTENCY_KEY_OPERATIONS`. A replay is the caller's own earlier answer, the number masked in
  it, and is authorized again like a first request. `docs/runbook.md`, `CONTRIBUTING.md` and the
  generated limit sentence name the three operations.
- **Lists.** `tickets.list` is every role's, keyed by ticket id (creation order). A page whose
  rows belong to passengers who have left is filtered after the page is cut, so it can hold fewer
  than `limit` rows while its cursor still advances.

## Consequences

- Erasure (R20) can find a person's tickets by membership id and scrub `seat`, `ticket_no_enc`
  and `baggage` and the ticket snapshots, with no new column.
- B5's offline bundle reads `tickets.list` per item (masked), marks only the caller's own tickets
  for offline, and never carries or caches a reveal.
- A restore of a deleted ticket (1b) copies the snapshot's `ticketNoEnc` forward unchanged.
- Adding a ticket field to the reveal is a change to `TicketRevealField` and the sealed column
  set, with the leak tests' markers extended.
