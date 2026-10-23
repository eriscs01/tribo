import {
  decodeTypeId,
  ID_PREFIX,
  NoBody,
  TripCursorKey,
  TripInput,
  TripPatch,
  type PageQuery,
} from '@tribo/contract';
import { forModule, type DB, type TripRole, type ValueOf } from '@tribo/db';
import {
  actingUser,
  ApiError,
  decodeCursor,
  invalidCursor,
  onConstraint,
  page,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { accountPersonId } from '../library/service.js';
import { writeOperation } from '../write-operation.js';
import {
  callerMembership,
  membershipSnapshot,
  requireRole,
  type CallerMembership,
} from './membership.js';
import {
  canDeleteTrip,
  canGetTrip,
  canUpdateTrip,
  statusMoveRefusal,
  tripCreateRefusal,
} from './policy.js';
import {
  findTrip,
  insertMembership,
  insertTrip,
  listDestinations,
  listMemberTrips,
  listPersonTrips,
  lockTrip,
  replaceDestinations,
  softDeleteTrip,
  tripsPastRetention as tripsPastRetentionRows,
  updateTrip,
  type TripFields,
  type TripRow,
} from './repo.js';

export { guardTrip } from './trip-guard.js';
export {
  createInvitesService,
  type CreatedInvite,
  type InvitePreviewRecord,
  type InviteRecord,
  type InvitesService,
} from './invites.js';
export type { AcceptedInvite } from './join.js';
export { createMembersService, type MembersService } from './members.js';
export {
  allActiveMemberships,
  callerMembership,
  licensedMemberships,
  type CallerMembership,
  type MemberItems,
  type MemberMove,
  type MemberRecord,
} from './membership.js';

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
  /** Place ids in travel order. */
  destinations: string[];
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
  /** trips.list: the trips the caller is a member of; admins get no implicit access. */
  list(
    userId: string,
    page: PageQuery,
  ): Promise<{ items: TripRecord[]; nextCursor: string | null }>;
  /** trips.get: any member of the trip; not_found to everyone else. */
  get(userId: string, tripId: string): Promise<TripRecord>;
  /** trips.update: owner or organizer, under If-Match on the trip's version. */
  update(
    ctx: RequestContext,
    tripId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<TripRecord>;
  /**
   * trips.delete: the owner soft-deletes the trip under If-Match, archived or not; what it
   * holds drops out with it, and trips.restore (1b) brings both back.
   */
  delete(
    ctx: RequestContext,
    tripId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<void>;
}

const tripsCreate = writeOperation('trips.create', TripInput);
const tripsUpdate = writeOperation('trips.update', TripPatch);
const tripsDelete = writeOperation('trips.delete', NoBody);

/**
 * A trip as one of its members reads it, with the caller's membership, resolved once: a
 * read that needs both (trips.get, trips.dashboard) asks here rather than twice. Anyone
 * outside the trip, a removed member or a deleted trip is not_found; a role `allowed`
 * refuses is forbidden.
 */
export async function memberTrip(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
  allowed: (role: TripRole) => boolean,
): Promise<{ trip: TripRecord; viewer: CallerMembership }> {
  const viewer = await callerMembership(db, userId, tripId);
  if (viewer === null) throw new ApiError('not_found');
  if (!allowed(viewer.role)) throw new ApiError('forbidden');
  const trips = forModule(db, 'trips');
  const row = await findTrip(trips, tripId);
  if (!row) throw new ApiError('not_found');
  const destinations = await listDestinations(trips, [tripId]);
  return { trip: tripRecord(row, destinations.get(tripId) ?? []), viewer };
}

/** One of the caller's trips as a read across all of them needs it: where, and the caller's seat. */
export interface CallerTrip {
  tripId: string;
  name: string;
  timezone: string;
  archived: boolean;
  viewer: CallerMembership;
}

/**
 * Every trip the caller is an active member of, deleted trips left out, archived ones marked
 * and ordered by start: one query, whatever their number. Members only and the trip's own
 * data: what a trip holds is for its module to say.
 */
export async function callerTrips(db: Kysely<DB>, userId: string): Promise<CallerTrip[]> {
  const personId = await accountPersonId(db, userId);
  if (personId === null) return [];
  const rows = await listPersonTrips(forModule(db, 'trips'), personId);
  return rows.map((row) => {
    const role = row.trip_role as TripRole;
    return {
      tripId: row.trip_id,
      name: row.name,
      timezone: row.timezone,
      archived: row.archived_at !== null,
      viewer: {
        id: row.membership_id,
        role,
        canViewCosts: role !== 'viewer' || row.can_view_costs,
      },
    };
  });
}

/**
 * The trip's currency (R9): what every amount in the trip currency is in. It locks once
 * money is recorded, so a reader may take it beside the amounts it names.
 */
export async function tripCurrency(db: Kysely<DB>, tripId: string): Promise<string> {
  const row = await findTrip(forModule(db, 'trips'), tripId);
  if (!row) throw new ApiError('not_found');
  return row.currency;
}

/**
 * The trips the file retention purge acts on, `days` being document_retention_days:
 * soft-deleted at least that long ago, or ended (end date plus days) before today.
 */
export function tripsPastRetention(
  db: Kysely<DB>,
  days: number,
): Promise<{ deleted: string[]; ended: string[] }> {
  return tripsPastRetentionRows(forModule(db, 'trips'), days);
}

/**
 * The expenses side of the currency lock (R9), as the trips service takes it: whether the
 * trip has money recorded. A port, as MemberItems is: expenses reads trips, so trips
 * importing expenses would be a cycle.
 */
export type MoneyRecorded = (db: Kysely<DB>, tripId: string) => Promise<boolean>;

/**
 * `write` is core's write path (writePath in write-path.ts) and `moneyRecorded` the
 * expenses service's, passed in to keep imports acyclic.
 */
export function createTripsService(
  db: Kysely<DB>,
  write: WritePath,
  moneyRecorded: MoneyRecorded,
): TripsService {
  return {
    async list(userId, query) {
      const after = query.cursor === undefined ? null : tripCursor(query.cursor);
      const rows = await listMemberTrips(forModule(db, 'trips'), userId, {
        limit: query.limit + 1,
        after,
      });
      const shown = page(rows, query.limit, (r) => [r.start_date, r.id]);
      const destinations = await listDestinations(
        forModule(db, 'trips'),
        shown.rows.map((r) => r.id),
      );
      return {
        items: shown.rows.map((r) => tripRecord(r, destinations.get(r.id) ?? [])),
        nextCursor: shown.nextCursor,
      };
    },

    async get(userId, tripId) {
      return (await memberTrip(db, userId, tripId, canGetTrip)).trip;
    },

    update: (ctx, tripId, body, ifMatch) =>
      write(ctx, {
        operation: tripsUpdate,
        target: { tripId },
        body,
        ifMatch,
        authorize: (tx, c, target) => requireRole(tx, actingUser(c), target.tripId, canUpdateTrip),
        load: async (tx, target) => {
          const row = await lockTrip(forModule(tx, 'trips'), target.tripId);
          if (!row) throw new ApiError('not_found');
          return { tripId: row.id, counter: row.version, row };
        },
        mutate: async (tx, c, loaded, patch) => {
          const fields = await patchedFields(tx, loaded.row, patch, moneyRecorded);
          const trips = forModule(tx, 'trips');
          const row = await updateTrip(trips, loaded.tripId, fields, actingUser(c));
          if (patch.destinations) {
            const placeIds = patch.destinations.map((id) => decodeTypeId(ID_PREFIX.place, id));
            await placesChecked(() => replaceDestinations(trips, loaded.tripId, placeIds));
          }
          const destinations = await listDestinations(trips, [loaded.tripId]);
          const record = tripRecord(row, destinations.get(loaded.tripId) ?? []);
          return {
            action: 'update',
            aggregate: 'trip',
            entityId: record.id,
            tripId: record.id,
            version: record.version,
            snapshot: tripSnapshot(record),
            result: record,
          };
        },
      }),

    delete: (ctx, tripId, body, ifMatch) =>
      write(ctx, {
        operation: tripsDelete,
        target: { tripId },
        body,
        ifMatch,
        authorize: (tx, c, target) => requireRole(tx, actingUser(c), target.tripId, canDeleteTrip),
        load: async (tx, target) => {
          const row = await lockTrip(forModule(tx, 'trips'), target.tripId);
          if (!row) throw new ApiError('not_found');
          return { tripId: row.id, counter: row.version };
        },
        mutate: async (tx, c, loaded) => {
          const trips = forModule(tx, 'trips');
          const row = await softDeleteTrip(trips, loaded.tripId, actingUser(c));
          const destinations = await listDestinations(trips, [loaded.tripId]);
          const record = tripRecord(row, destinations.get(loaded.tripId) ?? []);
          return {
            action: 'delete',
            aggregate: 'trip',
            entityId: record.id,
            tripId: record.id,
            version: record.version,
            snapshot: tripSnapshot(record),
            result: undefined,
          };
        },
      }),

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
          const { destinations = [], ...fields } = input;
          const trip = await insertTrip(trips, { ...fields, createdBy: userId });
          const placeIds = destinations.map((id) => decodeTypeId(ID_PREFIX.place, id));
          await placesChecked(() => replaceDestinations(trips, trip.id, placeIds));
          const owner = await insertMembership(trips, {
            tripId: trip.id,
            personId,
            role: 'owner',
            createdBy: userId,
          });
          const record = tripRecord(trip, placeIds);
          return {
            action: 'create',
            aggregate: 'trip',
            entityId: trip.id,
            tripId: trip.id,
            version: trip.version,
            snapshot: tripSnapshot(record),
            result: record,
            related: [
              {
                action: 'create',
                aggregate: 'membership',
                entityId: owner.id,
                tripId: trip.id,
                version: owner.version,
                versionBefore: null,
                snapshot: membershipSnapshot(owner),
              },
            ],
          };
        },
      }),
  };
}

/**
 * The trip's fields with the patch merged in, refused when the merge breaks a rule that
 * needs more than the patch: a backward status move, dates out of order, or a currency
 * change once money is recorded in the old one (R9).
 */
async function patchedFields(
  tx: Tx,
  row: TripRow,
  patch: TripPatch,
  moneyRecorded: MoneyRecorded,
): Promise<TripFields> {
  const current = row.status as TripFields['status'];
  const status = patch.status ?? current;
  const moveRefusal = statusMoveRefusal(current, status);
  if (moveRefusal) {
    throw new ApiError(moveRefusal, { detail: `a ${current} trip cannot become ${status}` });
  }
  const fields: TripFields = {
    name: patch.name ?? row.name,
    startDate: patch.startDate ?? row.start_date,
    endDate: patch.endDate ?? row.end_date,
    currency: patch.currency ?? row.currency,
    timezone: patch.timezone ?? row.timezone,
    status: status as TripFields['status'],
  };
  if (fields.endDate < fields.startDate) {
    throw new ApiError('validation_failed', {
      errors: [{ path: '/endDate', message: 'the trip ends before it starts' }],
    });
  }
  if (fields.currency !== row.currency && (await moneyRecorded(tx, row.id))) {
    throw new ApiError('currency_locked');
  }
  return fields;
}

/** A destination must name a place in the library; the foreign key is what knows. */
function placesChecked(write: () => Promise<void>): Promise<void> {
  return write().catch((error: unknown) =>
    onConstraint(error, {
      trip_destinations_place_id_fkey: () =>
        new ApiError('validation_failed', {
          errors: [{ path: '/destinations', message: 'not a place in the library' }],
        }),
    }),
  );
}

/** A trips.list cursor's sort key; anything else is refused before it reaches SQL. */
function tripCursor(cursor: string): { startDate: string; id: string } {
  const key = TripCursorKey.safeParse(decodeCursor(cursor, 2));
  if (!key.success) throw invalidCursor();
  const [startDate, id] = key.data;
  return { startDate, id };
}

/** The trip's fields and its owned destinations, as entity_versions keeps them. */
function tripSnapshot(trip: TripRecord) {
  return {
    name: trip.name,
    startDate: trip.startDate,
    endDate: trip.endDate,
    currency: trip.currency,
    timezone: trip.timezone,
    status: trip.status,
    destinations: [...trip.destinations],
  };
}

function tripRecord(row: TripRow, destinations: string[]): TripRecord {
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    currency: row.currency,
    timezone: row.timezone,
    status: row.archived_at === null ? (row.status as TripStatus) : 'archived',
    destinations,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
