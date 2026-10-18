import { describe, expect, it } from 'vitest';
import { canCreateItem, canListItems } from './policy.js';

describe('canCreateItem', () => {
  it('lets owners, organizers and members add items, never viewers', () => {
    expect(canCreateItem('owner')).toBe(true);
    expect(canCreateItem('organizer')).toBe(true);
    expect(canCreateItem('member')).toBe(true);
    expect(canCreateItem('viewer')).toBe(false);
  });
});

describe('canListItems', () => {
  it('lets every trip role list the items it may see', () => {
    for (const role of ['owner', 'organizer', 'member', 'viewer'] as const) {
      expect(canListItems(role)).toBe(true);
    }
  });
});
