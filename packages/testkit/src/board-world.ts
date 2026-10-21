// The trip the units and board stories test against: one member of each role, an
// outsider, a guest house of two-bed rooms and an e-bike rental, all owned by the trip
// owner. Each call builds a fresh trip, so tests never share rows.
import { createUnitsService, writePath, type UnitsService } from '@tribo/core';
import { ApiError, type RequestContext } from '@tribo/platform';
import { expect } from 'vitest';
import type { TestDatabase } from './database.js';
import {
  addMember,
  createItem,
  createTrip,
  createUnit,
  createUser,
  type TripRole,
  type UserFixture,
} from './factories.js';

export type Member = UserFixture & { membershipId: string };

export function unitsService(tdb: TestDatabase): UnitsService {
  return createUnitsService(tdb.db, writePath(tdb.db));
}

/** A request context per call, each with its own request id. */
export function contexts(prefix: string) {
  let n = 0;
  return (user: UserFixture): RequestContext => {
    n += 1;
    return { requestId: `${prefix}-${String(n)}`, surface: 'web', userId: user.userId };
  };
}

/** The ApiError code a call refused with; fails the test if it resolved. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).code;
}

export async function boardWorld(tdb: TestDatabase) {
  const owner = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner });
  const { tripId } = trip;
  const member = async (role: TripRole): Promise<Member> => {
    const user = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, { tripId, personId: user.personId, role });
    return { ...user, membershipId };
  };
  const w = {
    tripId,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member'),
    other: await member('member'),
    viewer: await member('viewer'),
    outsider: await createUser(tdb.db),
  };
  const lodging = await createItem(tdb.db, {
    tripId,
    ownerMembershipId: w.owner.membershipId,
    type: 'lodging',
    title: 'Lagwerta Guest House',
    days: { start: '2026-11-11', end: '2026-11-14' },
  });
  const rental = await createItem(tdb.db, {
    tripId,
    ownerMembershipId: w.owner.membershipId,
    type: 'ground',
    title: 'E-bike rental',
    days: { start: '2026-11-12', end: '2026-11-13' },
  });
  const room1 = await createUnit(tdb.db, { itemId: lodging, label: 'Room 1', capacity: 2 });
  const room2 = await createUnit(tdb.db, { itemId: lodging, label: 'Room 2', capacity: 2 });
  const bike = await createUnit(tdb.db, {
    itemId: rental,
    kind: 'vehicle',
    label: 'E-bike 1',
    capacity: 5,
  });
  return { ...w, lodging, rental, room1, room2, bike };
}

/** Archives the trip, as trips.update to completed does. */
export async function archive(tdb: TestDatabase, tripId: string): Promise<void> {
  await tdb.db
    .updateTable('tribo.trips')
    .set({ status: 'completed', archived_at: new Date() })
    .where('id', '=', tripId)
    .execute();
}

/** The audit events and snapshots one entity has, oldest first. */
export async function history(tdb: TestDatabase, entityId: string) {
  const events = await tdb.db
    .selectFrom('audit.audit_events')
    .select(['chain_key', 'action', 'entity_type', 'version_before', 'version_after', 'request_id'])
    .where('entity_id', '=', entityId)
    .orderBy('id')
    .execute();
  const snapshots = await tdb.db
    .selectFrom('tribo.entity_versions')
    .select(['entity_type', 'version', 'snapshot'])
    .where('entity_id', '=', entityId)
    .orderBy('entity_type')
    .orderBy('version')
    .execute();
  return { events, snapshots };
}
