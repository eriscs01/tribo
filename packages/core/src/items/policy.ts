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
