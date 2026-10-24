# 0028. Revealing a person's emergency contact: who may, which chain, which refusal

- Date: 24 Oct 2026
- Status: accepted
- Source: B5 people reveal (library.people.reveal)

## Context

The design says sensitive person fields go "only to the person and the owners and organizers
of a shared trip", that a reveal returns the plaintext and writes a `reveal` event naming the
field paths, never the values, that reveals are never cached offline or replayed (R2), and that
reveals need the write scope (G15). The CSV moves the emergency contact's reveal into Drop B so
organizers can reach it during the trip. It does not say what makes a trip "shared" (a removed
membership, a deleted, archived or retired trip), what anyone else is told, which audit chain
holds the event of a person who belongs to no single trip, or how the library, which trips
already depends on, learns the caller's roles.

## Decision

- **Who may.** The person themself (their account), or an account that is owner or organizer
  of a trip in which both hold an active membership, the trip not deleted and its audit chain
  not retired. Any one such trip is enough. An archived trip still grants (a reveal is a read,
  as items.reveal and tickets.reveal allow on archived trips); a retired one does not, since
  the trip is frozen for good. A placeholder's creator is not its "self" and reveals only as an
  organizer; a placeholder is revealed by the organizers of its trips.
- **Everyone else is told the person does not exist.** A plain member or a viewer of a shared
  trip, the placeholder's creator, a stranger, a deleted person and an unknown id all get
  `not_found`, and the same three queries run for each (the person, the caller's person, the
  shared roles), so neither the answer nor its cost says whether a contact is stored or which
  trips the two share. The body is validated only after that, so a refused caller learns
  nothing from a bad body either.
- **A merged placeholder's id resolves to the survivor**, as library.people.get does, and the
  survivor's contact is what is revealed and audited.
- **The answer and the event.** The body is `{"fields": ["emergencyContact"]}` (ID and passport
  join `PersonRevealField` in 1b) and the answer `{"emergencyContact": {...}}`, null when none is
  stored, with `Cache-Control: private, no-store`. Each call writes one `reveal` event on
  `person` with reason `/emergencyContact`, before the value is opened and in the same
  transaction, so a contact that does not open for its person (moved or tampered with) rolls
  the event back and answers `internal_error`. The event goes to the `platform` chain with no
  trip id: a person is outside any one trip (the migration header routes people there), so no
  trip's retirement can refuse it. It takes no Idempotency-Key.
- **Where it lives.** The reveal is its own small library service, `createPersonRevealService`,
  given the trips module's `sharedTripRoles` as a port (trips imports the library, so the
  library cannot import trips), as members are given `memberItems`. It is the first piece of
  the people part the library service is to be split into (follow-up from #43).
- **One reveal path.** The event is written by `recordReveal` (audit), which items.reveal,
  tickets.reveal and this reveal share, and the one transaction by `inTransaction`, now one
  function in core instead of a copy in documents and tickets.

## Consequences

- "Who looked at this person's emergency contact" is `tribo audit` on the person id in the
  platform chain, whichever trip granted it.
- Adding ID or passport is a value in `PersonRevealField`, its sealed column read in the reveal,
  and the leak test's markers extended; the grant stays the same rule.
- An organizer who leaves the trip, or whose traveller leaves it, loses the reveal at once.
