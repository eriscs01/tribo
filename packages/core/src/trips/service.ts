import { TripInput } from '@tribo/contract';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import { ApiError, type RequestContext, type Tx, type WritePath } from '@tribo/platform';
import type { Kysely } from 'kysely';
import { accountPersonId } from '../library/service.js';
import { writeOperation } from '../write-operation.js';
import { tripCreateRefusal, tripWriteRefusal } from './policy.js';
import {
  countActiveMemberships,
  findActiveMembership,
  insertMembership,
  insertTrip,
  lockTripForWrite,
  type TripRole,
} from './repo.js';

export type { TripRole } from './repo.js';

/** A trip's status as the API shows it: `archived` is derived from archived_at (R40). */
export type TripStatus = ValueOf<'tribo.trips.status'> | 'archived';

export interface TripRecord {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  currency: string;
  timezone: string;
  status: TripStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The signed-in caller as trips.create needs them. */
export interface TripCreator {
  mfaVerified: boolean;
}

export interface TripsService {
  /** trips.create: the trip and the caller's owner membership, in one write. */
  create(ctx: RequestContext, caller: TripCreator, body: unknown): Promise<TripRecord>;
}

const tripsCreate = writeOperation('trips.create', TripInput);

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createTripsService(write: WritePath): TripsService {
  return {
    create: (ctx, caller, body) =>
      write(ctx, {
        operation: tripsCreate,
        target: null,
        body,
        ifMatch: undefined,
        authorize: () => {
          const refusal = tripCreateRefusal(caller);
          return refusal ? Promise.reject(new ApiError(refusal)) : Promise.resolve();
        },
        load: () => Promise.resolve({ tripId: null }),
        mutate: async (tx, c, _loaded, input) => {
          const userId = actingUser(c);
          const personId = await accountPersonId(tx, userId);
          if (personId === null) throw new ApiError('forbidden');
          const trips = forModule(tx, 'trips');
          const trip = await insertTrip(trips, { ...input, createdBy: userId });
          const owner = await insertMembership(trips, {
            tripId: trip.id,
            personId,
            role: 'owner',
            createdBy: userId,
          });
          const record = tripRecord(trip);
          return {
            action: 'create',
            aggregate: 'trip',
            entityId: trip.id,
            tripId: trip.id,
            version: trip.version,
            snapshot: {
              name: record.name,
              startDate: record.startDate,
              endDate: record.endDate,
              currency: record.currency,
              timezone: record.timezone,
              status: record.status,
            },
            result: record,
            related: [
              {
                action: 'create',
                aggregate: 'membership',
                entityId: owner.id,
                tripId: trip.id,
                version: owner.version,
                versionBefore: null,
                snapshot: {
                  personId: owner.person_id,
                  role: owner.trip_role,
                  canViewCosts: owner.can_view_costs,
                },
              },
            ],
          };
        },
      }),
  };
}

/** The write path's trip guard: the trip exists, is open to this operation and stays so until commit. */
export async function guardTrip(tx: Tx, tripId: string, operationId: string): Promise<void> {
  const trip = await lockTripForWrite(forModule(tx, 'trips'), tripId);
  const refusal = trip
    ? tripWriteRefusal(
        { archived: trip.archived_at !== null, deleted: trip.deleted_at !== null },
        operationId,
      )
    : 'not_found';
  if (refusal) throw new ApiError(refusal);
}

/** Inside a trip a person is their membership: the caller's active one, or null. */
export async function callerMembership(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
): Promise<{ id: string; role: TripRole } | null> {
  const personId = await accountPersonId(db, userId);
  if (personId === null) return null;
  const row = await findActiveMembership(forModule(db, 'trips'), tripId, personId);
  return row ? { id: row.id, role: row.trip_role as TripRole } : null;
}

/** True when every one of these is an active membership of the trip. */
export async function allActiveMemberships(
  db: Kysely<DB>,
  tripId: string,
  membershipIds: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(membershipIds)];
  return (await countActiveMemberships(forModule(db, 'trips'), tripId, unique)) === unique.length;
}

/** Writes need an account behind them; only system work runs without one. */
function actingUser(ctx: RequestContext): string {
  if (ctx.userId === null) throw new ApiError('unauthenticated');
  return ctx.userId;
}

function tripRecord(row: Awaited<ReturnType<typeof insertTrip>>): TripRecord {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    currency: row.currency,
    timezone: row.timezone,
    status: row.archived_at === null ? (row.status as TripStatus) : 'archived',
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
