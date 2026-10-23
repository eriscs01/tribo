import type { TripRole } from '@tribo/db';

/**
 * The few rules trip roles reduce to (R1 B3). Each module's policy names its operations'
 * rules after the operation and aliases one of these, so the name documents intent and a
 * role change is made here once.
 */

/** Every role, viewers included: reads that visibility and masking narrow further. */
export function anyMember(_role: TripRole): boolean {
  return true;
}

/** Everyone but a viewer: those who add things and answer for themselves. */
export function contributors(role: TripRole): boolean {
  return role !== 'viewer';
}

/** The owner and organizers: they edit everything in the trip they can see. */
export function organizers(role: TripRole): boolean {
  return role === 'owner' || role === 'organizer';
}

/** The trip's owner alone. */
export function ownerOnly(role: TripRole): boolean {
  return role === 'owner';
}

/** Where the caller stands on one item: their trip role, and whether they own it or are its assignee. */
export interface ItemEditor {
  role: TripRole;
  owns: boolean;
  assigned: boolean;
}

/** Organizers, or a member on an item they own; being assigned is not enough, and never a viewer. */
export function itemManager(editor: ItemEditor): boolean {
  return organizers(editor.role) || (editor.role === 'member' && editor.owns);
}

/** The item's owner, whatever their role is now, or organizers. */
export function itemOwnerOrOrganizer(editor: Pick<ItemEditor, 'role' | 'owns'>): boolean {
  return editor.owns || organizers(editor.role);
}
