import type { ValueOf } from '@tribo/db';

type TripRole = ValueOf<'tribo.memberships.trip_role'>;

/** itinerary.get: owner, organizer, member, viewer (operations.csv). The story adds what a trip role can't say. */
const ITINERARY_GET_ROLES: ReadonlySet<TripRole> = new Set([
  'owner',
  'organizer',
  'member',
  'viewer',
]);

export function canGetItinerary(role: TripRole): boolean {
  return ITINERARY_GET_ROLES.has(role);
}
