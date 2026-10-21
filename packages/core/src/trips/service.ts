import {
  decodeTypeId,
  ID_PREFIX,
  MemberAddInput,
  NoBody,
  TripCursorKey,
  TripInput,
  TripPatch,
  Uuid,
  type PageQuery,
} from '@tribo/contract';
import type { Keyring } from '@tribo/crypto';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import {
  ApiError,
  decodeCursor,
  encodeCursor,
  invalidCursor,
  type Change,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import { moneyRecorded } from '../expenses/service.js';
import {
  accountPersonId,
  createPlaceholder,
  memberPersons,
  visiblePerson,
  type PersonRecord,
} from '../library/service.js';
import { writeOperation } from '../write-operation.js';
import {
  canAddMember,
  canDeleteTrip,
  canGetTrip,
  canListMembers,
  canUpdateTrip,
  statusMoveRefusal,
  tripCreateRefusal,
  tripWriteRefusal,
} from './policy.js';
import {
  countActiveMemberships,
  findActiveMembership,
  findTrip,
  insertMembership,
  insertTrip,
  listMemberships,
  lockMembershipOf,
  listDestinations,
  listMemberTrips,
  lockTrip,
  lockTripForWrite,
  replaceDestinations,
  softDeleteTrip,
  undeleteMembership,
  updateTrip,
  type MembershipRow,
  type TripFields,
  type TripRole,
  type TripRow,
} from './repo.js';

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

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createTripsService(db: Kysely<DB>, write: WritePath): TripsService {
  return {
    async list(userId, page) {
      const after = page.cursor === undefined ? null : tripCursor(page.cursor);
      // One extra row says whether another page follows.
      const rows = await listMemberTrips(forModule(db, 'trips'), userId, {
        limit: page.limit + 1,
        after,
      });
      const shown = rows.slice(0, page.limit);
      const destinations = await listDestinations(
        forModule(db, 'trips'),
        shown.map((r) => r.id),
      );
      const items = shown.map((r) => tripRecord(r, destinations.get(r.id) ?? []));
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > page.limit && last ? encodeCursor([last.startDate, last.id]) : null,
      };
    },

    async get(userId, tripId) {
      await requireRole(db, userId, tripId, canGetTrip);
      const trips = forModule(db, 'trips');
      const row = await findTrip(trips, tripId);
      if (!row) throw new ApiError('not_found');
      const destinations = await listDestinations(trips, [tripId]);
      return tripRecord(row, destinations.get(tripId) ?? []);
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
          const fields = await patchedFields(tx, loaded.row, patch);
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

/** The caller inside a trip: their membership, its role, and whether costs show to them. */
export interface CallerMembership {
  id: string;
  role: TripRole;
  /** Every role but a viewer reads costs; a viewer only with can_view_costs. */
  canViewCosts: boolean;
}

/** Inside a trip a person is their membership: the caller's active one, or null. */
export async function callerMembership(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
): Promise<CallerMembership | null> {
  const personId = await accountPersonId(db, userId);
  if (personId === null) return null;
  const row = await findActiveMembership(forModule(db, 'trips'), tripId, personId);
  if (!row) return null;
  const role = row.trip_role as TripRole;
  return { id: row.id, role, canViewCosts: role !== 'viewer' || row.can_view_costs };
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

/**
 * The caller's membership must allow the operation. A trip the caller is not in does not
 * exist for them.
 */
async function requireRole(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
  allowed: (role: TripRole) => boolean,
): Promise<void> {
  const membership = await callerMembership(db, userId, tripId);
  if (membership === null) throw new ApiError('not_found');
  if (!allowed(membership.role)) throw new ApiError('forbidden');
}

/**
 * The trip's fields with the patch merged in, refused when the merge breaks a rule that
 * needs more than the patch: a backward status move, dates out of order, or a currency
 * change once money is recorded in the old one (R9).
 */
async function patchedFields(tx: Tx, row: TripRow, patch: TripPatch): Promise<TripFields> {
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
async function placesChecked(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (
      error instanceof Error &&
      'constraint' in error &&
      error.constraint === 'trip_destinations_place_id_fkey'
    ) {
      throw new ApiError('validation_failed', {
        errors: [{ path: '/destinations', message: 'not a place in the library' }],
      });
    }
    throw error;
  }
}

/** Writes need an account behind them; only system work runs without one. */
function actingUser(ctx: RequestContext): string {
  if (ctx.userId === null) throw new ApiError('unauthenticated');
  return ctx.userId;
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

/** A membership with the person behind it, as members.list shows it. */
export interface MemberRecord {
  id: string;
  tripId: string;
  role: TripRole;
  /** Every role but a viewer reads costs; a viewer only with can_view_costs. */
  canViewCosts: boolean;
  person: PersonRecord;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembersService {
  /** members.list: the trip's active memberships, oldest first, to any member of it. */
  list(
    userId: string,
    tripId: string,
    page: PageQuery,
  ): Promise<{ items: MemberRecord[]; nextCursor: string | null }>;
  /**
   * members.add: the owner adds a placeholder traveller, new or from their library. A person
   * with an account joins by invite instead (R4); a removed placeholder is brought back.
   */
  add(ctx: RequestContext, tripId: string, body: unknown): Promise<MemberRecord>;
}

const membersAdd = writeOperation('members.add', MemberAddInput);

/** What members.add locks: the library person's earlier row in the trip, if it has one. */
interface MemberAddLoaded {
  tripId: string;
  /** The library person asked for; null for a new placeholder. */
  personId: string | null;
  existing?: MembershipRow & { deleted_at: Date | null };
  counter?: number;
}

export function createMembersService(
  db: Kysely<DB>,
  write: WritePath,
  keys: Keyring,
): MembersService {
  return {
    add: (ctx, tripId, body) =>
      write(ctx, {
        operation: membersAdd,
        target: { tripId },
        body,
        ifMatch: undefined,
        authorize: (tx, c, target) => requireRole(tx, actingUser(c), target.tripId, canAddMember),
        load: async (tx, target, input): Promise<MemberAddLoaded> => {
          if (!('personId' in input)) return { tripId: target.tripId, personId: null };
          const personId = decodeTypeId(ID_PREFIX.person, input.personId);
          const existing = await lockMembershipOf(forModule(tx, 'trips'), target.tripId, personId);
          return existing
            ? { tripId: target.tripId, personId, existing, counter: existing.version }
            : { tripId: target.tripId, personId };
        },
        mutate: async (tx, c, loaded, input) => {
          const userId = actingUser(c);
          const trips = forModule(tx, 'trips');
          const join = (personId: string) =>
            insertMembership(trips, {
              tripId: loaded.tripId,
              personId,
              role: input.role ?? 'member',
              createdBy: userId,
            });
          if ('person' in input) {
            const { result: person, ...created } = await createPlaceholder(tx, keys, {
              createdBy: userId,
              person: input.person,
            });
            return {
              ...membershipChange('create', await join(person.id), person),
              related: [{ ...created, versionBefore: null }],
            };
          }
          const person =
            loaded.personId === null ? null : await visiblePerson(tx, userId, loaded.personId);
          if (person === null) {
            throw new ApiError('validation_failed', {
              errors: [{ path: '/personId', message: 'no such person' }],
            });
          }
          if (person.hasAccount) throw new ApiError('person_has_account');
          const { existing } = loaded;
          if (!existing) return membershipChange('create', await join(person.id), person);
          if (existing.deleted_at === null) throw new ApiError('already_member');
          const role = input.role ?? 'member';
          const row = await undeleteMembership(trips, existing.id, { role, updatedBy: userId });
          return membershipChange('restore', row, person);
        },
      }),

    async list(userId, tripId, page) {
      await requireRole(db, userId, tripId, canListMembers);
      const after = page.cursor === undefined ? null : memberCursor(page.cursor);
      // One extra row says whether another page follows.
      const rows = await listMemberships(forModule(db, 'trips'), tripId, {
        limit: page.limit + 1,
        after,
      });
      const shown = rows.slice(0, page.limit);
      const persons = await memberPersons(
        db,
        shown.map((r) => r.person_id),
      );
      const items = shown.map((r) => memberRecord(r, persons));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > page.limit && last ? encodeCursor([last.id]) : null,
      };
    },
  };
}

/** A members.list cursor's sort key; anything else is refused before it reaches SQL. */
function memberCursor(cursor: string): string {
  const [id] = decodeCursor(cursor, 1);
  const key = Uuid.safeParse(id);
  if (!key.success) throw invalidCursor();
  return key.data;
}

function memberRecord(row: MembershipRow, persons: Map<string, PersonRecord>): MemberRecord {
  const person = persons.get(row.person_id);
  if (!person) throw new Error(`membership ${row.id} has no person ${row.person_id}`);
  const role = row.trip_role as TripRole;
  return {
    id: row.id,
    tripId: row.trip_id,
    role,
    canViewCosts: role !== 'viewer' || row.can_view_costs,
    person,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The membership's stored fields, as entity_versions keeps them. */
function membershipSnapshot(row: MembershipRow) {
  return { personId: row.person_id, role: row.trip_role, canViewCosts: row.can_view_costs };
}

/** The write's change for a membership just written, with the person behind it. */
function membershipChange(
  action: 'create' | 'restore' | 'role_change',
  row: MembershipRow,
  person: PersonRecord,
): Change<MemberRecord> {
  return {
    action,
    aggregate: 'membership',
    entityId: row.id,
    tripId: row.trip_id,
    version: row.version,
    snapshot: membershipSnapshot(row),
    result: memberRecord(row, new Map([[person.id, person]])),
  };
}
