# Slice 1a backlog

<!-- Generated from operations.csv by `pnpm backlog`; edit the CSV or the registry, not this file. -->

68 stories: 46 in Drop A, due Sun 1 Nov, and 22 in Drop B, due Sun 8 Nov. Start one with `pnpm new:op <id>`; it is done when it meets the 1a definition of done in [CONTRIBUTING.md](../CONTRIBUTING.md). A ticked story is `implemented` in the registry. Its tests carry the Vitest tag `drop-a` or `drop-b`: `pnpm vitest run --tags-filter drop-b`.

## Auth & identity

- [x] `auth.login` · Drop A · `POST /v1/auth/login`
  - Sign in with username + password (+ TOTP or recovery code); Lockout 5 fails/15 min; 10 logins/min per IP; No Idempotency-Key: a retried login is just another login (R2)
  - Roles: anyone. If-Match: `no`. Idempotency: never replayed.
- [x] `auth.logout` · Drop A · `POST /v1/auth/logout`
  - End the current session
  - Roles: self. If-Match: `no`. Idempotency: safe to repeat.
- [x] `auth.session` · Drop A · `GET /v1/auth/session`
  - Current session + CSRF token
  - Roles: self. If-Match: `no`. Idempotency: safe to repeat.
- [x] `auth.mfa.setup` · Drop A · `POST /v1/auth/mfa/totp`
  - Start TOTP enrolment (secret); Secret shown once; No Idempotency-Key: each call replaces the pending secret (R2)
  - Roles: self. If-Match: `no`. Idempotency: never replayed.
- [x] `auth.mfa.confirm` · Drop A · `POST /v1/auth/mfa/totp/confirm`
  - Confirm TOTP; returns 10 recovery codes; Codes shown once; Codes never stored for replay; a replay returns 200 with codes omitted and redacted = true (R2)
  - Roles: self. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [x] `auth.passwordReset` · Drop A · `POST /v1/auth/password-reset`
  - Use admin reset link {token, newPassword}; revokes all sessions and refresh tokens; Token in body, never URL; Single-use token makes it naturally idempotent: a repeat gets reset_link_used (R2)
  - Roles: anyone with link. If-Match: `no`. Idempotency: safe to repeat.

## Me

- [ ] `me.get` · Drop A · `GET /v1/me`
  - Caller account + own person profile; Own sensitive fields masked; reveal via library.people.reveal
  - Roles: self. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `me.update` · Drop A · `PATCH /v1/me`
  - Edit own profile (name, contacts, dietary, emergency contact, licence); masked_field_write on masked fields
  - Roles: self. If-Match: `version`. Idempotency: safe to repeat.
- [x] `me.password.change` · Drop A · `POST /v1/me/password`
  - Change own password; revokes other sessions; Decided (G1); Never replayed (rule 6)
  - Roles: self. If-Match: `no`. Idempotency: never replayed.
- [ ] `me.tasks` · Drop B · `GET /v1/me/tasks`
  - "My trip" tasks across trips + due-soon reminders; item_visible per trip; overlay reminders are own only
  - Roles: self. If-Match: `no`. Idempotency: safe to repeat.

## Trips

- [x] `trips.list` · Drop A · `GET /v1/trips`
  - Trips the caller belongs to; Membership only; admins get no implicit access
  - Roles: self (member trips). If-Match: `no`. Idempotency: safe to repeat.
- [x] `trips.create` · Drop A · `POST /v1/trips`
  - Create trip: dates, currency, tz, destinations; mfa_required if caller has no TOTP
  - Roles: self (MFA on; becomes owner). If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `trips.get` · Drop A · `GET /v1/trips/{tripId}`
  - Trip detail incl. destinations; Members only; ETag = SHA-256 of the representation (rule 4)
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `trips.update` · Drop A · `PATCH /v1/trips/{tripId}`
  - Edit fields, destinations, status transition; invalid_transition on bad status move; Status archived only via trips.archive; currency_locked once any expense or budget line exists (R9, write-path rule); trip_archived on archived trips (R29)
  - Roles: owner, organizer. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `trips.delete` · Drop A · `DELETE /v1/trips/{tripId}`
  - Soft-delete trip and children; Undo via trips.restore (1b); MCP approval; Allowed on archived trips; refused with trip_retired once the audit chain is retired (R29)
  - Roles: owner. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `trips.dashboard` · Drop A · `GET /v1/trips/{tripId}/dashboard`
  - Countdown, next item, open tasks, due soon, my share (sum of my expense shares; no balance or who-owes-whom, R36), warnings; Costs masked for viewers w/o canViewCosts; Poll with If-None-Match on the representation ETag (rule 4)
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `trips.offlineBundle` · Drop B · `GET /v1/trips/{tripId}/offline-bundle`
  - Read bundle for IndexedDB; Sensitive fields always masked; no revealed values; ETag = SHA-256 of the serialized per-caller bundle (R12)
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.

## Members & invites

- [ ] `members.list` · Drop A · `GET /v1/trips/{tripId}/members`
  - Members, roles, placeholders; Emergency contact masked; reveal per person
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `members.add` · Drop A · `POST /v1/trips/{tripId}/members`
  - Add placeholder traveller (new or visible library person); person_visible on personId; Person must have no account: person_has_account → send an invite (R4); A removed placeholder is undeleted rather than re-added; trip_archived on archived trips (R29)
  - Roles: owner. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `members.setRole` · Drop A · `PATCH /v1/trips/{tripId}/members/{membershipId}`
  - Change role or canViewCosts; Owner transfer to an MFA member demotes the old owner to organizer in the same write (G14); MCP approval; trip_archived on archived trips (R29)
  - Roles: owner. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `members.remove` · Drop A · `DELETE /v1/trips/{tripId}/members/{membershipId}`
  - Remove member (soft delete); ledger rows stay; MCP approval; Also deletes the member's allocations (bumps boardVersion of each item); trip_archived on archived trips (R29); Also soft-deletes the private items the member owns; rejoin undeletes them (R32)
  - Roles: owner; self (non-owner leaving, G14). If-Match: `version`. Idempotency: safe to repeat.
- [ ] `invites.list` · Drop A · `GET /v1/trips/{tripId}/invites`
  - Invite links with role, expiry, uses; Token never returned after create
  - Roles: owner. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `invites.create` · Drop A · `POST /v1/trips/{tripId}/invites`
  - Create link: role, expiry, maxUses, optional placeholder; Token shown once; placeholder invite single use; Secret omitted on idempotent replay (redacted = true): revoke and recreate (R2); Link format /join#<token> (fragment, never in proxy logs); Pre-linked person must be an active placeholder member of this trip (FK + check), else invite_invalid (R28); trip_archived on archived trips (R29)
  - Roles: owner. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `invites.revoke` · Drop A · `POST /v1/trips/{tripId}/invites/{inviteId}/revoke`
  - Revoke an invite link; Invites carry no version; trip_archived on archived trips (R29)
  - Roles: owner. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `invites.preview` · Drop A · `POST /v1/invites/preview`
  - Trip name, role, placeholder name for a token; Token in body; invite_invalid; Read only; no key (R2)
  - Roles: anyone with link. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `invites.accept` · Drop A · `POST /v1/invites/accept`
  - Join: new account (username+password) or signed-in; claims placeholder; username_taken, already_member, invite_invalid; Claim is per trip (R28): new account → its own person is created first; then only this trip's placeholder membership moves to the caller's person (tickets, allocations, shares follow the membership id); the placeholder never gains an account and stays in its other trips; when it has no membership rows left it is scrubbed, soft-deleted and mergedInto the caller; claim_conflict if the caller's person already has a row in this trip. Rejoin undeletes the caller's earlier membership in the trip. Anonymous Idempotency-Key caller = invite:<inviteId>; Set-Cookie never replayed
  - Roles: anyone with link. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.

## Items

- [ ] `items.list` · Drop A · `GET /v1/trips/{tripId}/items`
  - All types; ?type, ?from&to, ?assignee=me; item_visible; viewers masked; costs per canViewCosts
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [x] `items.create` · Drop A · `POST /v1/trips/{tripId}/items`
  - Create any item type; visibility + sharedWith; Wall-clock + tz input; warnings[] returned; trip_archived on archived trips (R29); sharedWith = membership ids of the trip; owner = callers membership (rule 3)
  - Roles: owner, organizer, member (owns it). If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [x] `items.get` · Drop A · `GET /v1/items/{itemId}`
  - Item detail (?view=summary|full); bookingRef, cardLast4 masked for all; restrictedFields
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `items.update` · Drop A · `PATCH /v1/items/{itemId}`
  - Merge-patch item, visibility, sharedWith; masked_field_write; going private: item owner or organizer; If-Match = item version; board saves and RSVPs never conflict; trip_archived on archived trips (R29); sharedWith = membership ids of the trip; owner = callers membership (rule 3)
  - Roles: owner, organizer, member (own/assigned). If-Match: `version`. Idempotency: safe to repeat.
- [ ] `items.delete` · Drop A · `DELETE /v1/items/{itemId}`
  - Soft-delete item and children; Undo via items.restore (1b); MCP approval; trip_archived on archived trips (R29)
  - Roles: owner, organizer, member (own). If-Match: `version`. Idempotency: safe to repeat.
- [ ] `items.rsvp` · Drop A · `PUT /v1/items/{itemId}/rsvp`
  - Set caller's own RSVP yes|no|maybe; Item lock + boardVersion bump (item version untouched); touches only caller's attendee row; trip_archived on archived trips (R29)
  - Roles: owner, organizer, member (self). If-Match: `no`. Idempotency: safe to repeat.
- [ ] `items.reveal` · Drop A · `POST /v1/items/{itemId}/reveal`
  - Plaintext of bookingRef, cardLast4; Audited reveal (field paths only); never cached offline; write scope (G15); MCP approval (1b); No Idempotency-Key: each call is its own audited reveal (R2); MCP: tool returns approvalId, after approval the client calls again with approvalId within 10 min, single use (R15); Allowed on archived trips (a read, audited); refused with trip_retired after retirement
  - Roles: owner, organizer, member (own items). If-Match: `no`. Idempotency: never replayed.
- [ ] `overlays.get` · Drop B · `GET /v1/items/{itemId}/overlay`
  - Caller's private note, reminder, checklist; Always private to caller
  - Roles: self (not viewer). If-Match: `no`. Idempotency: safe to repeat.
- [ ] `overlays.put` · Drop B · `PUT /v1/items/{itemId}/overlay`
  - Create or replace own overlay; reminderAt feeds due-soon; If-Match when one exists, If-None-Match: * to create (G3); trip_archived on archived trips (R29)
  - Roles: self (not viewer). If-Match: `version_or_new`. Idempotency: safe to repeat.
- [ ] `overlays.delete` · Drop B · `DELETE /v1/items/{itemId}/overlay`
  - Remove own overlay; trip_archived on archived trips (R29)
  - Roles: self. If-Match: `version`. Idempotency: safe to repeat.

## Units & assignments & tickets

- [ ] `units.list` · Drop A · `GET /v1/items/{itemId}/units`
  - Rooms of a lodging, vehicles of a rental; Rates masked per canViewCosts
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `units.create` · Drop A · `POST /v1/items/{itemId}/units`
  - Add room or vehicle: label, capacity, rate; trip_archived on archived trips (R29)
  - Roles: item owner, organizer, owner. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `units.update` · Drop A · `PATCH /v1/units/{unitId}`
  - Edit unit; capacity_exceeded if below occupants; trip_archived on archived trips (R29)
  - Roles: item owner, organizer, owner. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `units.delete` · Drop A · `DELETE /v1/units/{unitId}`
  - Remove unit and its allocations; Deletes its allocations explicitly (units are soft-deleted, nothing cascades); bumps boardVersion; trip_archived on archived trips (R29)
  - Roles: item owner, organizer, owner. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `items.assignments.get` · Drop A · `GET /v1/items/{itemId}/assignments`
  - Whole board: RSVPs, occupants, drivers, passengers, assignees; Follows item_visible; ETag = boardVersion
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `items.assignments.replace` · Drop A · `PUT /v1/items/{itemId}/assignments`
  - Save whole board; capacity checked on final state; capacity_exceeded, room_double_booked, driver_taken; If-Match on boardVersion; trip_archived on archived trips (R29)
  - Roles: item owner, organizer, owner. If-Match: `board_version`. Idempotency: safe to repeat.
- [ ] `tickets.list` · Drop B · `GET /v1/items/{itemId}/tickets`
  - Per-passenger tickets of a transport item; ticketNo masked for all; follows item_visible
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `tickets.create` · Drop B · `POST /v1/items/{itemId}/tickets`
  - Add ticket: passenger, seat, ticketNo, baggage; trip_archived on archived trips (R29)
  - Roles: item owner, organizer, owner (G4). If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `tickets.update` · Drop B · `PATCH /v1/tickets/{ticketId}`
  - Edit ticket; masked_field_write; trip_archived on archived trips (R29)
  - Roles: item owner, organizer, owner; member own seat/baggage (G4). If-Match: `version`. Idempotency: safe to repeat.
- [ ] `tickets.delete` · Drop B · `DELETE /v1/tickets/{ticketId}`
  - Remove ticket; trip_archived on archived trips (R29)
  - Roles: item owner, organizer, owner. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `tickets.reveal` · Drop B · `POST /v1/tickets/{ticketId}/reveal`
  - Plaintext ticketNo; Audited reveal; never cached offline; write scope (G15); MCP approval (1b); No Idempotency-Key: each call is its own audited reveal (R2); MCP: tool returns approvalId, after approval the client calls again with approvalId within 10 min, single use (R15); Allowed on archived trips (a read, audited); refused with trip_retired after retirement
  - Roles: owner, organizer, member (own ticket). If-Match: `no`. Idempotency: never replayed.

## Itinerary

- [ ] `itinerary.get` · Drop A · `GET /v1/trips/{tripId}/itinerary`
  - Day timeline ?view=me|group&from&to, with warnings; item_visible; local times per item tz
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.

## Expenses

- [ ] `expenses.list` · Drop B · `GET /v1/trips/{tripId}/expenses`
  - Trip ledger; All members; itemId nulled if item hidden; amounts masked for viewers w/o canViewCosts; Record only: no balances, debts or settle-up (R36)
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `expenses.create` · Drop B · `POST /v1/trips/{tripId}/expenses`
  - Record expense: payer, amount, FX, members included and split equal|weight|itemised (one share per included member); Shares frozen, largest remainder; tripAmountMinor = max(1, round half-up(amount × fxRate × 10^(e_trip − e_orig))), fxRate per major unit, static ISO 4217 exponent table (R8); write path guarantees shares sum to tripAmountMinor (R11, rule 2); trip_archived on archived trips (R29)
  - Roles: owner, organizer, member. If-Match: `no`. Idempotency: creates (key).
  - Limit: Honours Idempotency-Key: 24 h per caller, the same key with a different body is idempotency_key_reused.
  - Limit: Trip currency only: fx_rate = 1; FX entry follows after the trip.
  - Limit: Splits are equal or itemised only; weight follows after the trip.
- [ ] `expenses.get` · Drop B · `GET /v1/expenses/{expenseId}`
  - Expense with shares; As expenses.list
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `expenses.update` · Drop B · `PATCH /v1/expenses/{expenseId}`
  - Edit expense; shares recomputed; Same FX rule and share-sum check as create; trip_archived on archived trips (R29)
  - Roles: owner, organizer, member (own). If-Match: `version`. Idempotency: safe to repeat.
  - Limit: Trip currency only: fx_rate = 1; FX entry follows after the trip.
  - Limit: Splits are equal or itemised only; weight follows after the trip.
- [ ] `expenses.void` · Drop B · `DELETE /v1/expenses/{expenseId}`
  - Void (soft delete, audited); trip_archived on archived trips (R29)
  - Roles: owner, organizer, member (own). If-Match: `version`. Idempotency: safe to repeat.

## Files

- [ ] `files.list` · Drop B · `GET /v1/trips/{tripId}/files`
  - File metadata; File visibility AND item_visible(parent)
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `files.upload` · Drop B · `POST /v1/trips/{tripId}/files`
  - Multipart upload ≤ 25 MB; kind, visibility, itemId; file_too_large, file_type_not_allowed; id/ticket/voucher sensitive; trip_archived on archived trips (R29); Owner = callers membership (rule 3)
  - Roles: owner, organizer, member. If-Match: `no`. Idempotency: creates (key).
  - Limit: Honours Idempotency-Key: 24 h per caller, the same key with a different body is idempotency_key_reused.
- [ ] `files.get` · Drop B · `GET /v1/files/{fileId}`
  - File metadata; As files.list; purged shows purgedAt
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `files.update` · Drop B · `PATCH /v1/files/{fileId}`
  - Rename, relink item, change visibility; trip_archived on archived trips (R29)
  - Roles: file owner, organizer, owner. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `files.delete` · Drop B · `DELETE /v1/files/{fileId}`
  - Soft-delete file; Blob kept until purge; Blob purged document_retention_days after deletion; trip_archived on archived trips (R29)
  - Roles: file owner, organizer, owner. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `files.download` · Drop B · `GET /v1/files/{fileId}/content`
  - Stream decrypted bytes; Permission re-checked each request; no-store; file_purged
  - Roles: owner, organizer, member, viewer. If-Match: `no`. Idempotency: safe to repeat.

## Library

- [ ] `library.search` · Drop A · `GET /v1/library/search`
  - Search people, places, vendors (trigram); People limited by person_visible
  - Roles: any signed-in user. If-Match: `no`. Idempotency: safe to repeat.
- [x] `library.people.create` · Drop A · `POST /v1/library/people`
  - Create placeholder person
  - Roles: any signed-in user. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `library.people.get` · Drop A · `GET /v1/library/people/{personId}`
  - Person detail; person_visible; emergency contact masked; Merged id resolves to the survivor
  - Roles: any signed-in user. If-Match: `no`. Idempotency: safe to repeat.
- [ ] `library.people.update` · Drop A · `PATCH /v1/library/people/{personId}`
  - Edit person; masked_field_write; Placeholders only (account persons use me.update); ID/passport fields join in 1b and need recorded consent; Emergency contact stored encrypted (emergency_contact_enc, R5)
  - Roles: creator (placeholders only); own person via me.update. If-Match: `version`. Idempotency: safe to repeat.
- [ ] `library.places.create` · Drop A · `POST /v1/library/places`
  - Add place (kind, lat/lng, hours, links); Audited on platform chain (G11)
  - Roles: any signed-in user. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `library.vendors.create` · Drop A · `POST /v1/library/vendors`
  - Add vendor (kind, contacts, links); Audited on platform chain (G11)
  - Roles: any signed-in user. If-Match: `no`. Idempotency: creates (key).
  - Limit: Takes no Idempotency-Key in 1a: only expenses.create and files.upload honour it; this create follows in 1b.
- [ ] `library.people.reveal` · Drop B · `POST /v1/library/people/{personId}/reveal`
  - Plaintext emergency contact; ID/passport in 1b; Audited reveal; write scope (G15); MCP approval (1b); No Idempotency-Key: each call is its own audited reveal (R2); MCP: tool returns approvalId, after approval the client calls again with approvalId within 10 min, single use (R15); Moved to Drop B so organizers can reach emergency contacts during the trip
  - Roles: self; owner, organizer of a shared trip. If-Match: `no`. Idempotency: never replayed.

## Health/meta

- [x] `meta.liveness` · Drop A · `GET /healthz`
  - Liveness for Compose/Caddy: 200 when DB reachable; No details returned; Decided (G13)
  - Roles: anyone. If-Match: `no`. Idempotency: safe to repeat.
- [x] `meta.openapi` · Drop A · `GET /v1/openapi.json`
  - Generated OpenAPI 3.1 document; Decided (G13)
  - Roles: any signed-in user. If-Match: `no`. Idempotency: safe to repeat.
