import {
  anyMember,
  contributors,
  itemManager,
  ownerOrOrganizer,
  organizers,
  type ItemEditor,
} from '../roles.js';

export type { ItemEditor } from '../roles.js';

/** items.create: everyone but a viewer adds items, and owns what they add (rule 3). */
export const canCreateItem = contributors;

/** items.list: every role reads the trip's items; visibility and masking narrow what it sees. */
export const canListItems = anyMember;

/** items.update: owners and organizers edit any item; members only their own or assigned ones. */
export function canUpdateItem(editor: ItemEditor): boolean {
  return organizers(editor.role) || (editor.role === 'member' && (editor.owns || editor.assigned));
}

/**
 * Taking an item away from the group (private, or selected members only) is for its owner
 * or an organizer; anyone who may edit it may share it with everyone again.
 */
export const canNarrowVisibility = ownerOrOrganizer;

/**
 * An item's restricted fields: its owner and the trip's owners and organizers read and
 * write them, and only they change which fields are restricted. Being assigned is not enough.
 */
export const seesRestrictedFields = ownerOrOrganizer;

/** items.delete: owners and organizers delete any item; members only their own (an assignee may not). */
export const canDeleteItem = itemManager;

/** items.rsvp: everyone but a viewer answers for themself; the service only ever touches their own row. */
export const canRsvpItem = contributors;

/**
 * items.reveal: owners and organizers reveal any item's sensitive fields, members only on
 * items they own (being assigned is not enough); never viewers.
 */
export const canRevealItem = itemManager;

/** units.list: every role reads the units of an item it can see; masking narrows the rates. */
export const canListUnit = anyMember;

/**
 * units.create, units.update, units.delete and items.assignments.replace: the item's owner
 * and the trip's owners and organizers manage its units and board; never a viewer, and
 * being assigned is not enough.
 */
export const canManageBoard = itemManager;

/** items.assignments.get: every role reads the board of an item it can see. */
export const canReadBoard = anyMember;

/**
 * overlays.get and overlays.put: everyone but a viewer keeps a private note, reminder and
 * checklist of their own (the design's matrix: viewers keep none).
 */
export const canGetOverlay = contributors;
export const canPutOverlay = contributors;
