# 0007. Membership roles, cost grants and placeholders

- Date: 22 Oct 2026
- Status: accepted
- Source: P5 members (members.list, members.add, members.setRole)

## Context

The design says who may add members and set roles (the owner), that ownership goes only to a
member with MFA and demotes the old owner in the same write (G14), that `can_view_costs` is
"only meaningful for viewers", and that `members.add` takes placeholders only (R4). It does
not say which error each refusal returns, what happens to a cost grant when a viewer becomes
something else, or how `members.add` names its person.

## Decision

- **Cost grants are a viewer's alone.** `members.setRole` refuses `canViewCosts` with
  `validation_failed` at `/canViewCosts` when the resulting role is not viewer, and a viewer
  who moves to another role loses the grant (stored `false`), so it never comes back with a
  later move to viewer. Undeleting a placeholder in `members.add` also starts without one.
  Reads render the effective value: true for every role but viewer, which shows its grant.
- **Handover refusals.** Making a member owner when they have no account with MFA on is
  `mfa_required`; a placeholder has no account, so it gets the same answer. The owner
  changing their own role to anything but owner is `owner_transfer_required`: they step down
  only by handing over, which is the same rule that keeps an owner from leaving.
- **members.add names its person in one of two shapes**: `{personId}` for a library person or
  `{person: PersonInput}` for a new placeholder, with an optional non-owner `role` (default
  member). A `personId` the caller cannot see is `validation_failed` at `/personId`, the
  same answer as an id that does not exist, as body references are elsewhere (trip
  destinations, vendor places). A person already active in the trip is `already_member`.
- **Members show the person behind them**: `Member.person` is the library's `Person`, so the
  emergency contact is masked exactly as `library.people.get` masks it.
- **Identity's MFA check is passed in.** `createMembersService` takes identity's
  `accountHasMfa` as an argument, as services already take the write path, because the
  identity service reaches the write path and the write path reaches the trips service.

## Consequences

- `can_view_costs` is true only on viewer rows written from now on. Nothing constrains it in
  the schema; a CHECK would be a new migration, and the write path is the one writer.
- invites.accept (P7) moves a placeholder's membership with its role; the role a placeholder
  was added with is the role its claimer gets.
- The MCP approval that `members.setRole` declares arrives with MCP in 1b; the REST write
  needs none.
