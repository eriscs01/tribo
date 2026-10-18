import type { ErrorCode } from '@tribo/contract';
import type { ValueOf } from '@tribo/db';

type TripRole = ValueOf<'tribo.memberships.trip_role'>;

/** R29: an archived trip is read-only, except that it can still be deleted and restored. */
const WRITES_ON_ARCHIVED = new Set(['trips.delete', 'trips.restore']);
/** A deleted trip takes no writes but its own restore. */
const WRITES_ON_DELETED = new Set(['trips.restore']);

/** Why a write under this trip is refused, or null when the trip takes it. */
export function tripWriteRefusal(
  trip: { archived: boolean; deleted: boolean },
  operationId: string,
): ErrorCode | null {
  if (trip.deleted && !WRITES_ON_DELETED.has(operationId)) return 'not_found';
  if (trip.archived && !WRITES_ON_ARCHIVED.has(operationId)) return 'trip_archived';
  return null;
}

/** trips.create: the owner of a trip must have signed in with a second factor. */
export function tripCreateRefusal(caller: { mfaVerified: boolean }): ErrorCode | null {
  return caller.mfaVerified ? null : 'mfa_required';
}

/** trips.get: every member reads the trip, viewers included. */
const TRIP_READERS: ReadonlySet<TripRole> = new Set(['owner', 'organizer', 'member', 'viewer']);

export function canGetTrip(role: TripRole): boolean {
  return TRIP_READERS.has(role);
}
