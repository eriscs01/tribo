import { ItemMaskedField } from '@tribo/contract';
import { VALUE_SETS } from '@tribo/db';
import { describe, expect, it } from 'vitest';

// The database's CHECK owns the closed set; the contract's enum must match it.
describe('item maskable fields', () => {
  it('ItemMaskedField is tribo.items.restricted_fields', () => {
    expect(ItemMaskedField.options).toEqual(VALUE_SETS['tribo.items.restricted_fields']);
  });
});
