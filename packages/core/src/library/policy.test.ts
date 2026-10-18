import { describe, expect, it } from 'vitest';
import { ownEditRefusal, placeholderEditRefusal } from './policy.js';

const ANA = 'ana';
const placeholder = { userId: null, createdBy: ANA, erased: false };

describe('placeholderEditRefusal', () => {
  it('lets the creator edit their placeholder', () => {
    expect(placeholderEditRefusal(placeholder, ANA)).toBeNull();
  });

  it('refuses anyone else, and an erased placeholder', () => {
    expect(placeholderEditRefusal(placeholder, 'ben')).toBe('forbidden');
    expect(placeholderEditRefusal({ ...placeholder, erased: true }, ANA)).toBe('forbidden');
  });

  it('sends account persons to me.update, including the caller', () => {
    expect(placeholderEditRefusal({ ...placeholder, userId: ANA }, ANA)).toBe('person_has_account');
    expect(placeholderEditRefusal({ ...placeholder, userId: 'ben' }, ANA)).toBe(
      'person_has_account',
    );
  });
});

describe('ownEditRefusal', () => {
  it('lets an account edit its own person, but not an erased one', () => {
    const own = { userId: ANA, createdBy: ANA, erased: false };
    expect(ownEditRefusal(own)).toBeNull();
    expect(ownEditRefusal({ ...own, erased: true })).toBe('forbidden');
  });
});
