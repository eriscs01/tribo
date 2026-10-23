# 0024. Expenses: shares, ownership, masking and the ledger's reads

- Date: 24 Oct 2026
- Status: accepted
- Source: B3 expenses (expenses.list, create, get, update, void)

## Context

The design says expenses are the trip's whole ledger (every member reads it, amounts masked
for a viewer without `can_view_costs`, `itemId` nulled when the item is hidden), that shares
are frozen by the largest-remainder method and sum to `trip_amount_minor` (R8, R11), that
members edit "their own" expenses, and that voiding is a soft delete. It leaves open which
member gets a leftover minor unit, what makes an expense a member's own, what a masked
expense looks like, when an edit refreezes the shares and among whom, what an edit does to
a link it cannot see, and in what order the ledger reads. It also left a cycle to break:
the trips service checked the currency lock (R9) by importing expenses, which now reads
trips.

## Decision

- **Ties go to the earliest membership.** The largest-remainder method gives each member
  the whole minor units of their quota and hands the units left over, one each, to the
  largest remainders; equal remainders (every equal split) go in ascending membership id
  order, which for UUIDv7 ids is the order members joined the trip. The same split over the
  same members always freezes the same shares, whatever order the body named them in. All
  arithmetic is integer minor units in BigInt; the ISO 4217 exponents are a static table
  (exponent 2 unless listed).
- **Drop B's limits are validation.** A currency other than the trip's is
  `validation_failed` at `/amount/currency`; the body has no FX fields, so sending one is
  `validation_failed` too; a `weight` split is `validation_failed` at `/split/method`. The
  stored rate is 1.
- **An expense is a member's own when they paid it.** Inside a trip a person is their
  membership (rule 3); `payer_membership_id` is the one membership on an expense, and
  `created_by` is an actor column, not ownership. The owner and organizers edit and void any
  expense, a member the ones they paid, and a viewer none even as payer (the design's
  matrix: viewers never edit expenses). The rule is `organizersOrOwningMember` in
  `roles.ts`; `itemManager` now uses it. It is not `itemOwnerOrOrganizer`, which lets an
  owner of any role in, so that rule keeps its name for B1 to rename.
- **Members named must be active.** The payer and every member a split names must be an
  active membership of the expense's trip, placeholders included. One of another trip, a
  removed one and one that does not exist answer the same `validation_failed`, with the same
  path and message, from the same one query.
- **Shares refreeze only when the money changes.** expenses.update recomputes the shares
  when its patch has `amount` or `split`: an equal split re-splits among the same members,
  itemised amounts must still sum to the new amount (else `validation_failed` at
  `/split/shares`), and a new split replaces the old one. Whenever shares are written, every
  member in them must be active, so an equal split that kept a member who has since left
  needs a new split with the new amount. An edit that changes neither leaves the frozen
  shares as they are, removed members included.
- **A hidden link stays.** `itemId: null` in a patch leaves a link to an item the caller
  cannot see as it is: their read showed null, so echoing it neither drops a link they never
  saw nor tells them it exists. Naming an item they see replaces it.
- **Masking is per amount.** For a viewer without the cost grant, `amount`, `tripAmount` and
  every share's `amount` read `{"masked": true}`; nothing else in an expense is an amount, so
  who paid, who shares, the split method and the rate still show. The one serializer is
  `expenseRecord` in the expenses service.
- **The ledger's reads.** expenses.list orders by `spent_on`, then id (the order recorded),
  with a keyset cursor over both. Voided expenses are in no read (get answers `not_found`),
  as soft-deleted rows elsewhere; history and restore arrive in 1b.
- **Void keeps the shares.** A void stamps the expense only; its shares stay, so a restore
  brings back what was frozen, and the currency lock still counts it (R9).
- **trips takes `moneyRecorded` as a port.** `createTripsService(db, write, moneyRecorded)`,
  as the members service takes `memberItems`: expenses reads trips and items, so the
  currency lock could no longer import expenses.

## Consequences

- Moving a member out of a trip never changes a frozen share; only an edit of that
  expense's money does, and then it must leave them out.
- Weight splits and FX entry, after the trip, add a `weight` branch to `ExpenseSplit`, FX
  fields to the input, and a rate other than 1 to the same `tripAmountMinor`; equal splits
  already run through the weighted largest-remainder code.
- A member who records an expense someone else paid cannot edit it afterwards; the payer, an
  organizer or the owner can.
