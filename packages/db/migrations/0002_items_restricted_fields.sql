-- Tribo — 0002_items_restricted_fields.sql
-- items.restricted_fields (0001_init.sql: "per-item tightening of field masking") holds
-- only the item's maskable field paths, as the API names them. The closed set is owned
-- here; VALUE_SETS and the contract's ItemMaskedField are tested against this CHECK.

ALTER TABLE tribo.items
  ADD CONSTRAINT items_restricted_fields
  CHECK (restricted_fields <@ ARRAY['cost', 'bookingRef', 'cardLast4']);
