import type { ValueOf } from '@tribo/db';

type TripRole = ValueOf<'tribo.memberships.trip_role'>;

/** items.create: everyone but a viewer adds items, and owns what they add (rule 3). */
const ITEM_CREATORS: ReadonlySet<TripRole> = new Set(['owner', 'organizer', 'member']);

export function canCreateItem(role: TripRole): boolean {
  return ITEM_CREATORS.has(role);
}

/** items.list: every role reads the trip's items; visibility and masking narrow what it sees. */
const ITEMS_LIST_ROLES: ReadonlySet<TripRole> = new Set(['owner', 'organizer', 'member', 'viewer']);

export function canListItems(role: TripRole): boolean {
  return ITEMS_LIST_ROLES.has(role);
}

/** Where the caller stands on one item: their trip role, and whether they own it or are its assignee. */
export interface ItemEditor {
  role: TripRole;
  owns: boolean;
  assigned: boolean;
}

/** Owners and organizers edit every item they can see. */
const ITEM_EDITORS: ReadonlySet<TripRole> = new Set(['owner', 'organizer']);

/** items.update: owners and organizers edit any item; members only their own or assigned ones. */
export function canUpdateItem(editor: ItemEditor): boolean {
  if (ITEM_EDITORS.has(editor.role)) return true;
  return editor.role === 'member' && (editor.owns || editor.assigned);
}

/**
 * Taking an item away from the group (private, or selected members only) is for its owner
 * or an organizer; anyone who may edit it may share it with everyone again.
 */
export function canNarrowVisibility(editor: ItemEditor): boolean {
  return editor.owns || ITEM_EDITORS.has(editor.role);
}

/**
 * An item's restricted fields: its owner and the trip's owners and organizers read and
 * write them, and only they change which fields are restricted. Being assigned is not enough.
 */
export function seesRestrictedFields(editor: Pick<ItemEditor, 'role' | 'owns'>): boolean {
  return editor.owns || ITEM_EDITORS.has(editor.role);
}

/** items.delete: owners and organizers delete any item; members only their own (an assignee may not). */
export function canDeleteItem(editor: ItemEditor): boolean {
  if (ITEM_EDITORS.has(editor.role)) return true;
  return editor.role === 'member' && editor.owns;
}

/** items.rsvp: everyone but a viewer answers for themself; the service only ever touches their own row. */
const ITEMS_RSVP_ROLES: ReadonlySet<TripRole> = new Set(['owner', 'organizer', 'member']);

export function canRsvpItem(role: TripRole): boolean {
  return ITEMS_RSVP_ROLES.has(role);
}

/**
 * items.reveal: owners and organizers reveal any item's sensitive fields, members only on
 * items they own (being assigned is not enough); never viewers.
 */
export function canRevealItem(editor: ItemEditor): boolean {
  if (ITEM_EDITORS.has(editor.role)) return true;
  return editor.role === 'member' && editor.owns;
}

/** units.list: every role reads the units of an item it can see; masking narrows the rates. */
const UNITS_LIST_ROLES: ReadonlySet<TripRole> = new Set(['owner', 'organizer', 'member', 'viewer']);

export function canListUnit(role: TripRole): boolean {
  return UNITS_LIST_ROLES.has(role);
}

/**
 * units.create, units.update, units.delete and items.assignments.replace: the item's owner
 * and the trip's owners and organizers manage its units and board; never a viewer, and
 * being assigned is not enough.
 */
export function canManageBoard(editor: ItemEditor): boolean {
  if (ITEM_EDITORS.has(editor.role)) return true;
  return editor.role === 'member' && editor.owns;
}
