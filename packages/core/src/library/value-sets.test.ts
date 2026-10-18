import { PlaceKind, VendorKind } from '@tribo/contract';
import { VALUE_SETS } from '@tribo/db';
import { describe, expect, it } from 'vitest';

// The database's CHECK lists own each closed set; the contract's enums must match them.
describe('library kinds', () => {
  it('PlaceKind is tribo.places.kind', () => {
    expect(PlaceKind.options).toEqual(VALUE_SETS['tribo.places.kind']);
  });

  it('VendorKind is tribo.vendors.kind', () => {
    expect(VendorKind.options).toEqual(VALUE_SETS['tribo.vendors.kind']);
  });
});
