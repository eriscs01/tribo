import { SplitMethod } from '@tribo/contract';
import { VALUE_SETS } from '@tribo/db';
import { describe, expect, it } from 'vitest';

// The database's CHECKs own the closed sets; the contract's enums must match them.
describe('expense value sets', () => {
  it('SplitMethod is tribo.expenses’ CHECK', () => {
    expect(SplitMethod.options).toEqual(VALUE_SETS['tribo.expenses.split_method']);
  });
});
