import type { ModuleDb } from '@tribo/db';

/** The trips module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type TripsDb = ModuleDb<'trips'>;

/**
 * Locks the trip FOR SHARE until commit: concurrent writes under the trip proceed, while
 * archive and delete (which update the row) wait for them, so none lands after the trip
 * closed. Undefined when the trip does not exist.
 */
export function lockTripForWrite(db: TripsDb, tripId: string) {
  return db
    .selectFrom('tribo.trips')
    .select(['archived_at', 'deleted_at'])
    .where('id', '=', tripId)
    .forShare()
    .executeTakeFirst();
}
