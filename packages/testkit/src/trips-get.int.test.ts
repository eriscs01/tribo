// @module-tag drop-a
// trips.get (Drop A): Trip detail incl. destinations; Members only; ETag = SHA-256 of the representation (rule 4)
// The ETag is the REST adapter's; apps/server/src/trips.int.test.ts proves it over HTTP.
import { createTripsService, moneyRecorded, writePath, type TripsService } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addMember,
  createPlace,
  createTrip,
  createUser,
  softDelete,
  type TripRole,
} from './factories.js';

let tdb: TestDatabase;
let trips: TripsService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  trips = createTripsService(tdb.db, writePath(tdb.db), moneyRecorded);
});
afterAll(() => tdb.destroy());

const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

describe('trips.get', () => {
  it.each<TripRole>(['owner', 'organizer', 'member', 'viewer'])(
    'lets a %s read the trip',
    async (role) => {
      const owner = await createUser(tdb.db);
      const { tripId } = await createTrip(tdb.db, { owner, name: 'Siargao surf week' });
      const reader = role === 'owner' ? owner : await createUser(tdb.db);
      if (role !== 'owner') await addMember(tdb.db, { tripId, personId: reader.personId, role });

      expect(await trips.get(reader.userId, tripId)).toMatchObject({
        id: tripId,
        name: 'Siargao surf week',
        startDate: '2026-11-11',
        endDate: '2026-11-14',
        currency: 'PHP',
        timezone: 'Asia/Manila',
        status: 'planning',
        destinations: [],
        version: 1,
      });
    },
  );

  it('answers not_found to an account outside the trip, a platform admin included', async () => {
    const owner = await createUser(tdb.db);
    const { tripId } = await createTrip(tdb.db, { owner });
    const stranger = await createUser(tdb.db);
    const admin = await createUser(tdb.db, { platformRole: 'admin' });
    for (const outsider of [stranger, admin]) {
      // eslint-disable-next-line no-await-in-loop -- two callers, one assertion each
      expect(await refusal(trips.get(outsider.userId, tripId))).toMatchObject({
        code: 'not_found',
      });
    }
  });

  it('answers not_found to a removed member and on a deleted trip', async () => {
    const owner = await createUser(tdb.db);
    const { tripId } = await createTrip(tdb.db, { owner });
    const left = await createUser(tdb.db);
    const membership = await addMember(tdb.db, {
      tripId,
      personId: left.personId,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', membership);
    expect(await refusal(trips.get(left.userId, tripId))).toMatchObject({ code: 'not_found' });

    await softDelete(tdb.db, 'tribo.trips', tripId);
    const gone = await refusal(trips.get(owner.userId, tripId));
    expect(gone).toBeInstanceOf(ApiError);
    expect(gone).toMatchObject({ code: 'not_found' });
  });

  it('answers not_found for an id that names no trip', async () => {
    const owner = await createUser(tdb.db);
    expect(
      await refusal(trips.get(owner.userId, '01900000-0000-7000-8000-000000000000')),
    ).toMatchObject({ code: 'not_found' });
  });

  it('lists destinations in travel order', async () => {
    const owner = await createUser(tdb.db);
    const { tripId } = await createTrip(tdb.db, { owner });
    const coron = await createPlace(tdb.db, { createdBy: owner.userId, name: 'Coron' });
    const elNido = await createPlace(tdb.db, { createdBy: owner.userId, name: 'El Nido' });
    await tdb.db
      .insertInto('tribo.trip_destinations')
      .values([
        { trip_id: tripId, place_id: coron, position: 1 },
        { trip_id: tripId, place_id: elNido, position: 0 },
      ])
      .execute();
    expect((await trips.get(owner.userId, tripId)).destinations).toEqual([elNido, coron]);
  });

  it('renders an archived trip with status archived', async () => {
    const owner = await createUser(tdb.db);
    const { tripId } = await createTrip(tdb.db, { owner });
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', tripId)
      .execute();
    expect((await trips.get(owner.userId, tripId)).status).toBe('archived');
  });
});
