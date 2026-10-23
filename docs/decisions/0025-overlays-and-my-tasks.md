# 0025. Overlays, preconditions and the due-soon list

- Date: 24 Oct 2026
- Status: accepted
- Source: B1 overlays and my tasks (overlays.get, put, delete, me.tasks and the dashboard's due soon)

## Context

The design says an overlay is always private to its membership, that it is created with
`If-None-Match: *` and replaced with `If-Match` (G3), that viewers keep none, and that task due
dates and overlay `reminder_at` times feed a "Due soon" list on the dashboard and in
`/v1/me/tasks`, nothing pushed until release 2. It leaves open which codes the preconditions
answer, what a viewer's stale overlay does, the due-soon window for a reminder, which trips
`me.tasks` covers, what an overlay snapshot may be read as, and how the two due-soon reads
share one rule.

## Decision

- **One overlay per member and item; the item names it.** An overlay has no id in the API:
  `/v1/items/{itemId}/overlay` is the caller's own, and every query takes the caller's
  membership, so another member's can neither be read nor written. It is a root with a
  `version`, a snapshot of aggregate `overlay` and an audit event whose row holds ids and
  counters only, never the note, the checklist or the reminder.
- **Hidden items answer as unknown ones.** The item is looked up through `tribo.item_visible`
  before the caller's role is weighed, so an item they cannot see is `not_found` whatever their
  role; a viewer who sees the item gets `forbidden` from get and put.
- **The preconditions of put.** With no overlay, `If-None-Match: *` creates it; `If-Match`
  alone is `version_conflict` (there is nothing to match) and neither header is
  `if_match_required`. With an overlay, `If-None-Match: *` is `version_conflict` (it exists),
  `If-Match` replaces it when it names the version and is `version_conflict` otherwise, and
  neither header is `if_match_required`. Two creates racing for one overlay are decided by the
  unique index: the loser gets `version_conflict`. `If-None-Match` with any value but `*` is
  treated as absent. A put replaces the whole overlay: a field left out is emptied. Both a
  create and a replace answer 200 with the overlay, whose `version` tells them apart.
- **Delete is for every role.** `overlays.delete` is "self", so a viewer removes an overlay
  kept from before they were demoted, though they can no longer read or write it. It soft-deletes
  the row under `If-Match`; a new overlay may follow (the unique index counts live rows only).
  The caller with no overlay, whoever else has one, gets `not_found`.
- **A viewer's reminder is not read.** Viewers keep no overlay, so a reminder left from before a
  demotion shows in neither due-soon list.
- **The due-soon window.** The design settles 7 days for a task ("due within 7 days or
  overdue", decision 0012). A reminder has no done state to clear it, so it counts within 7 days
  either side of now: one set 3 days ago still shows, one 10 days ago does not, and putting an
  overlay without `reminderAt` clears it earlier. A task keeps the rule of 0012: due by the
  seventh day from today in its trip's zone, overdue included.
- **One rule, one reminders read.** `itinerary/tasks.ts` holds the open-task and due-soon rules
  (`openTasks`, `dueSoon`, `reminderWindow`) as pure functions, and the items service holds the
  one query of the caller's own reminders (`ownReminders`); the dashboard and `me.tasks` both
  call them, with their trips' zones. The list is the tasks due, in due order, then the
  reminders, soonest first. A reminder entry carries `reminderAt`, the caller's own time.
- **me.tasks covers the trips the caller is in, archived ones aside.** Deleted trips and
  memberships they left contribute nothing. An archived trip is over and read-only, so it holds
  nothing to do; its own dashboard still reads as before. The tasks are the same open tasks as
  the dashboard's (assigned to the caller, or owned by them with nobody assigned) among those
  `tribo.item_visible` lets them see, with the trip's name; the answer is not paged.
- **Overlay snapshots are private.** `entity_versions` holds the overlay's content, so any
  history or audit read that arrives with 1b (`items.history`, the audit list) must leave out
  aggregate `overlay` for everyone but its membership, and an overlay's audit event too, since
  its existence is as private as its content (`docs/follow-ups.md`).

## Consequences

- `DueSoonKind` gains `reminder` and `DueSoon` an optional `reminderAt`: an additive change to
  the dashboard's output, and `me.tasks` joins the registry with `MyTasks`.
- `overlays.put` declares an `If-None-Match` header (`*`); `callerTrips` is a new read of the
  trips service for any read across all of a caller's trips.
- The leak harness seeds an overlay for every membership on every item of a world
  (`seedOverlays`), without changing the worlds it generates.
- Pushing a reminder (release 2) reads the same rows by membership; no schema change is needed.
