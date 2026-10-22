# 0011. Invite links, joins, claims and removals

- Date: 22 Oct 2026
- Status: accepted
- Source: P7 invites (invites.list, .create, .revoke, .preview, .accept, members.remove)

## Context

The design fixes the invite link (`/join#<token>`, a 256-bit token kept as SHA-256), the
per-trip claim (R28), what a removal takes with it (R32) and who may leave (G14). It does
not say how invite writes are audited, which role a placeholder invite gives, how every
dead link answers, how a join names its account, how a rejoin finds the items its removal
took, or what a claim does to the trip's other links to the same placeholder.

## Decision

- **Invites are credentials** (0001_init.sql, rule 1): they have no version and no
  snapshot. invites.create, .revoke and each use of an invite by invites.accept record one
  metadata-only audit event (`create`, `revoke`, `update` on `invite`). Their writes run in
  one transaction in the write path's order (role check, body, trip guard, change, event)
  rather than through the snapshotting write path. Revoking a revoked invite answers it
  unchanged and records nothing.
- **invites.create** takes either an open invite (`role`, `expiresAt`, optional
  `maxUses` up to 1000) or a placeholder invite (`personId`, `expiresAt`, optional
  `role`). The expiry must lie ahead (`validation_failed` at `/expiresAt`). A placeholder
  invite is single use and gives the placeholder's own role unless it names one; the
  claimer gets the invite's role, and keeps a viewer's cost grant only if that role is
  viewer. This refines decision 0007's note that the claimer gets the placeholder's role:
  by default they still do. The response carries `token` and `link` once, with
  `redacted: false`, as `auth.mfa.confirm` does for its codes.
- **Every dead link is the same `invite_invalid`.** Unknown, expired, revoked and used-up
  tokens, and tokens of an archived or deleted trip all fail the same single statement
  (`findLiveInvite`), with the same body. Revocation is the one owner of "dead link": a
  placeholder invite whose placeholder left the trip is revoked by the removal itself, in
  its transaction, so the statement needs no join to memberships (_amended in Q1_).
  An accept on an archived trip is therefore `invite_invalid`, not `trip_archived`: the
  trip guard's answer would tell that token apart. invites.create and .revoke, which the
  owner calls on their own trip, refuse `trip_archived` as usual. Preview is a POST, so the
  per-address write limit (decision 0008) caps guessing.
- **A claim closes the trip's other links to the same placeholder** (revoked, with an
  event each): their pre-link follows the membership to the claimer through the foreign
  key's `ON UPDATE CASCADE`, so they could only ever fail, and a preview would otherwise
  name the claimer.
- **invites.accept names its account in one of two ways.** A body with `account`
  (username, password, optional display name) makes a new account, which the join signs in
  with a session cookie; its person is named by the display name, else the placeholder it
  claims, else the username. A body with the token alone joins the signed-in caller. Both at
  once is `validation_failed` at `/account`; neither is `unauthenticated`. The password is
  hashed before the transaction, for every token alike. The answer is
  `{ member, session }`, `session` null for a signed-in joiner. Every write in a join is
  recorded with the joiner as actor, which is why accept runs its own transaction: the
  actor exists only once the account does.
- **Public operations that also take a session** (`invites.accept`) act as the signed-in
  caller when the cookie is live and as nobody otherwise; they never refuse at
  authentication. CSRF holds for any request that carries a cookie.
- **The placeholder merge** clears what `persons_merged_scrubbed` names (contacts,
  dietary, emergency contact, ID and passport), keeps the display name, soft-deletes the
  row and points `merged_into` at the claimer's person; its snapshot adds `mergedInto`. A
  removed membership row elsewhere still counts as a row, so the placeholder stays.
- **members.remove revokes the removed placeholder's open invites**, with a `revoke` event
  each, in the same transaction (`revokePlaceholderInvites`, as a claim does for the others).
  Without that, `invites.list` showed them `active` and a `members.add` re-adding the
  placeholder made an old link work again with nobody acting on it (_amended in Q1_).
- **members.remove** is the owner removing anyone but themself, or a non-owner removing
  themself; the owner leaving is `owner_transfer_required` (as for stepping down in
  members.setRole), anyone else's removal by a non-owner is `forbidden`. The member leaves
  every board of the trip, deleted items and items the caller cannot see included, and only
  their `private` items are soft-deleted (`selected` items are seen by others and stay).
- **A rejoin finds what its removal took by the removal's request id.** The audit
  service answers which items the request that last deleted the membership also deleted
  (`deletedWithEntity`), and those that are still the member's own private items come
  back with a `restore` each. A rejoin is invites.accept with an open link, or members.add
  re-adding a removed placeholder.
- **`can_view_costs` is constrained in the schema** (migration 0003): invites.accept is the
  second writer the follow-up waited for.
- **Opaque tokens** (`newToken`, `tokenHash`) move to `@tribo/crypto`, shared by sessions,
  reset links and invites.

## Consequences

- A user whose link fails cannot learn why from the API; the owner's invite list shows each
  link's status, and the runbook says what to tell them.
- Restoring items on a rejoin depends on the removal's audit events. Retention (1b) retires
  a trip's chains only after the trip is archived or deleted, and such a trip takes no
  joins, so a rejoin always finds them (_corrected in Q1_).
- A merged placeholder's earlier snapshots in `entity_versions` still hold the fields the
  merge cleared; erasure (1b) is the flow that deletes snapshots.
- The Idempotency-Key and its `invite:<inviteId>` caller arrive in 1b; until then a retried
  accept is a second join and is refused as one (`already_member`, or `invite_invalid` for
  a used-up link).
