import type { ValueOf } from '@tribo/db';

type TripRole = ValueOf<'tribo.memberships.trip_role'>;

/** items.create: everyone but a viewer adds items, and owns what they add (rule 3). */
const ITEM_CREATORS: ReadonlySet<TripRole> = new Set(['owner', 'organizer', 'member']);

export function canCreateItem(role: TripRole): boolean {
  return ITEM_CREATORS.has(role);
}
