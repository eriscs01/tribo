# 0003. Restricted item fields: who sees them, who sets them, who owns the set

- Date: 19 Oct 2026
- Status: accepted
- Source: [#49](https://github.com/eriscs01/tribo/pull/49), raised in [#46](https://github.com/eriscs01/tribo/pull/46)

## Context

`items.restricted_fields` ("per-item tightening of field masking", `0001_init.sql`) had no
rule saying who the restriction hides a field from, who may change it, or which fields can
be named.

## Decision

- A restricted field is masked for everyone except the item's owner and the trip's owner and
  organizers.
- It is masked even when it holds nothing, so its absence never shows.
- Only those same people set it, through `items.create` and `items.update`. Anyone else
  changing it gets `forbidden`; anyone else writing a restricted field gets `masked_field_write`.
- The set is closed (`cost`, `bookingRef`, `cardLast4`) and owned by a CHECK constraint
  (`0002_items_restricted_fields.sql`). `VALUE_SETS` and the contract's `ItemMaskedField`
  are tested against it.
- Masking stays in one serializer (`itemRecord`), shared by every read.

## Consequences

- Adding a maskable field is a new migration that widens the CHECK, followed by the contract
  and `VALUE_SETS` changes the tests demand.
- Every new item read must use `itemRecord`; the leak harness (`maskProperty`) fails if one
  does not.
