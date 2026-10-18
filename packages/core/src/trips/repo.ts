import type { ModuleDb, ValueOf } from '@tribo/db';
import { sql } from 'kysely';

/** The trips module's database handle: only the tables it owns compile. Other modules call service.ts. */
export type TripsDb = ModuleDb<'trips'>;
export type TripRole = ValueOf<'tribo.memberships.trip_role'>;

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

/** A trip as the API renders it: dates as text, so no driver turns them into local midnights. */
const TRIP_COLUMNS = [
  'id',
  'name',
  sql<string>`start_date::text`.as('start_date'),
  sql<string>`end_date::text`.as('end_date'),
  'currency',
  'timezone',
  'status',
  'archived_at',
  'version',
  'created_at',
  'updated_at',
] as const;

export function insertTrip(
  db: TripsDb,
  trip: {
    name: string;
    startDate: string;
    endDate: string;
    currency: string;
    timezone: string;
    createdBy: string;
  },
) {
  return db
    .insertInto('tribo.trips')
    .values({
      name: trip.name,
      start_date: trip.startDate,
      end_date: trip.endDate,
      currency: trip.currency,
      timezone: trip.timezone,
      created_by: trip.createdBy,
      updated_by: trip.createdBy,
    })
    .returning(TRIP_COLUMNS)
    .executeTakeFirstOrThrow();
}

export type TripRow = Awaited<ReturnType<typeof insertTrip>>;

/** A trip that is not deleted, or undefined. */
export function findTrip(db: TripsDb, tripId: string): Promise<TripRow | undefined> {
  return db
    .selectFrom('tribo.trips')
    .select(TRIP_COLUMNS)
    .where('id', '=', tripId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
}

/** Locks a trip that is not deleted FOR UPDATE until commit, or undefined. */
export function lockTrip(db: TripsDb, tripId: string): Promise<TripRow | undefined> {
  return db
    .selectFrom('tribo.trips')
    .select(TRIP_COLUMNS)
    .where('id', '=', tripId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
}

export interface TripFields {
  name: string;
  startDate: string;
  endDate: string;
  currency: string;
  timezone: string;
  status: ValueOf<'tribo.trips.status'>;
}

/** Writes the trip's fields and bumps its version. */
export function updateTrip(db: TripsDb, tripId: string, fields: TripFields, updatedBy: string) {
  return db
    .updateTable('tribo.trips')
    .set((eb) => ({
      name: fields.name,
      start_date: fields.startDate,
      end_date: fields.endDate,
      currency: fields.currency,
      timezone: fields.timezone,
      status: fields.status,
      version: eb('version', '+', 1),
      updated_at: sql<Date>`now()`,
      updated_by: updatedBy,
    }))
    .where('id', '=', tripId)
    .returning(TRIP_COLUMNS)
    .executeTakeFirstOrThrow();
}

/** Replaces the trip's destinations (owned rows) with these places, in this order. */
export async function replaceDestinations(
  db: TripsDb,
  tripId: string,
  placeIds: readonly string[],
): Promise<void> {
  await db.deleteFrom('tribo.trip_destinations').where('trip_id', '=', tripId).execute();
  if (placeIds.length === 0) return;
  await db
    .insertInto('tribo.trip_destinations')
    .values(placeIds.map((placeId, position) => ({ trip_id: tripId, place_id: placeId, position })))
    .execute();
}

/** Each trip's destination place ids, in travel order; trips without any are absent. */
export async function listDestinations(
  db: TripsDb,
  tripIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byTrip = new Map<string, string[]>();
  if (tripIds.length === 0) return byTrip;
  const rows = await db
    .selectFrom('tribo.trip_destinations')
    .select(['trip_id', 'place_id'])
    .where('trip_id', 'in', tripIds)
    .orderBy('trip_id')
    .orderBy('position')
    .execute();
  for (const row of rows)
    byTrip.set(row.trip_id, [...(byTrip.get(row.trip_id) ?? []), row.place_id]);
  return byTrip;
}

/**
 * One page of the trips this account is an active member of (tribo.is_member, so deleted
 * trips drop out), latest start first, then by id. `after` is the last row's sort key.
 */
export function listMemberTrips(
  db: TripsDb,
  userId: string,
  page: { limit: number; after: { startDate: string; id: string } | null },
) {
  let query = db
    .selectFrom('tribo.trips')
    .select(TRIP_COLUMNS)
    .where(sql<boolean>`tribo.is_member(${userId}, id)`);
  if (page.after) {
    query = query.where(
      sql<boolean>`(start_date, id) < (${page.after.startDate}::date, ${page.after.id}::uuid)`,
    );
  }
  return query.orderBy('start_date', 'desc').orderBy('id', 'desc').limit(page.limit).execute();
}

export function insertMembership(
  db: TripsDb,
  membership: { tripId: string; personId: string; role: TripRole; createdBy: string },
) {
  return db
    .insertInto('tribo.memberships')
    .values({
      trip_id: membership.tripId,
      person_id: membership.personId,
      trip_role: membership.role,
      created_by: membership.createdBy,
      updated_by: membership.createdBy,
    })
    .returning(['id', 'trip_id', 'person_id', 'trip_role', 'can_view_costs', 'version'])
    .executeTakeFirstOrThrow();
}

/** The person's active membership in a trip that is not deleted (R18), or undefined. */
export function findActiveMembership(db: TripsDb, tripId: string, personId: string) {
  return db
    .selectFrom('tribo.memberships as m')
    .innerJoin('tribo.trips as t', 't.id', 'm.trip_id')
    .select(['m.id', 'm.trip_role'])
    .where('m.trip_id', '=', tripId)
    .where('m.person_id', '=', personId)
    .where('m.deleted_at', 'is', null)
    .where('t.deleted_at', 'is', null)
    .executeTakeFirst();
}

/** How many of these memberships are active in the trip; the caller compares with its count. */
export async function countActiveMemberships(
  db: TripsDb,
  tripId: string,
  membershipIds: readonly string[],
): Promise<number> {
  if (membershipIds.length === 0) return 0;
  const row = await db
    .selectFrom('tribo.memberships')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('trip_id', '=', tripId)
    .where('id', 'in', membershipIds)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
