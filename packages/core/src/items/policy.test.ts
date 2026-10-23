import { describe, expect, it } from 'vitest';
import {
  canCreateItem,
  canGetOverlay,
  canPutOverlay,
  canDeleteItem,
  canListItems,
  canNarrowVisibility,
  canRevealItem,
  canRsvpItem,
  canListUnit,
  canManageBoard,
  canReadBoard,
  canUpdateItem,
} from './policy.js';

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

const editor = (
  role: 'owner' | 'organizer' | 'member' | 'viewer',
  owns = false,
  assigned = false,
) => ({
  role,
  owns,
  assigned,
});

describe('canUpdateItem', () => {
  it('lets owners and organizers edit any item, members their own or assigned, never viewers', () => {
    expect(canUpdateItem(editor('owner'))).toBe(true);
    expect(canUpdateItem(editor('organizer'))).toBe(true);
    expect(canUpdateItem(editor('member'))).toBe(false);
    expect(canUpdateItem(editor('member', true))).toBe(true);
    expect(canUpdateItem(editor('member', false, true))).toBe(true);
    expect(canUpdateItem(editor('viewer', false, true))).toBe(false);
  });
});

describe('canNarrowVisibility', () => {
  it('is for the item owner or an organizer, not an assignee', () => {
    expect(canNarrowVisibility(editor('member', true))).toBe(true);
    expect(canNarrowVisibility(editor('organizer'))).toBe(true);
    expect(canNarrowVisibility(editor('owner'))).toBe(true);
    expect(canNarrowVisibility(editor('member', false, true))).toBe(false);
  });
});

describe('canDeleteItem', () => {
  it('lets owners and organizers delete any item, members only their own, never viewers', () => {
    expect(canDeleteItem(editor('owner'))).toBe(true);
    expect(canDeleteItem(editor('organizer'))).toBe(true);
    expect(canDeleteItem(editor('member', true))).toBe(true);
    expect(canDeleteItem(editor('member', false, true))).toBe(false);
    expect(canDeleteItem(editor('viewer', true))).toBe(false);
  });
});

describe('canRsvpItem', () => {
  it('lets owners, organizers and members answer for themselves, never viewers', () => {
    expect(canRsvpItem('owner')).toBe(true);
    expect(canRsvpItem('organizer')).toBe(true);
    expect(canRsvpItem('member')).toBe(true);
    expect(canRsvpItem('viewer')).toBe(false);
  });
});

describe('canRevealItem', () => {
  it('lets owners and organizers reveal any item, members only their own, never viewers', () => {
    expect(canRevealItem(editor('owner'))).toBe(true);
    expect(canRevealItem(editor('organizer'))).toBe(true);
    expect(canRevealItem(editor('member', true))).toBe(true);
    expect(canRevealItem(editor('member', false, true))).toBe(false);
    expect(canRevealItem(editor('viewer', true))).toBe(false);
  });
});

describe('canListUnit', () => {
  it('lets every trip role list the units of an item it may see', () => {
    for (const role of ['owner', 'organizer', 'member', 'viewer'] as const) {
      expect(canListUnit(role)).toBe(true);
    }
  });
});

describe('canManageBoard', () => {
  it("lets owners and organizers manage any item's units and board, members their own, never viewers", () => {
    expect(canManageBoard(editor('owner'))).toBe(true);
    expect(canManageBoard(editor('organizer'))).toBe(true);
    expect(canManageBoard(editor('member', true))).toBe(true);
    expect(canManageBoard(editor('member'))).toBe(false);
    expect(canManageBoard(editor('member', false, true))).toBe(false);
    expect(canManageBoard(editor('viewer', true))).toBe(false);
  });
});

describe('canReadBoard', () => {
  it('lets every trip role read the board of an item it may see', () => {
    for (const role of ['owner', 'organizer', 'member', 'viewer'] as const) {
      expect(canReadBoard(role)).toBe(true);
    }
  });
});

describe('canGetOverlay', () => {
  it('lets owners, organizers and members keep a private overlay, never viewers', () => {
    expect(canGetOverlay('owner')).toBe(true);
    expect(canGetOverlay('organizer')).toBe(true);
    expect(canGetOverlay('member')).toBe(true);
    expect(canGetOverlay('viewer')).toBe(false);
  });
});

describe('canPutOverlay', () => {
  it('lets owners, organizers and members keep a private overlay, never viewers', () => {
    expect(canPutOverlay('owner')).toBe(true);
    expect(canPutOverlay('organizer')).toBe(true);
    expect(canPutOverlay('member')).toBe(true);
    expect(canPutOverlay('viewer')).toBe(false);
  });
});
