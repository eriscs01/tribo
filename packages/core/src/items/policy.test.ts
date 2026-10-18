import { describe, expect, it } from 'vitest';
import { canCreateItem } from './policy.js';

describe('canCreateItem', () => {
  it('lets owners, organizers and members add items, never viewers', () => {
    expect(canCreateItem('owner')).toBe(true);
    expect(canCreateItem('organizer')).toBe(true);
    expect(canCreateItem('member')).toBe(true);
    expect(canCreateItem('viewer')).toBe(false);
  });
});
