// @module-tag drop-a
// trips.update (Drop A): Edit fields, destinations, status transition; invalid_transition on bad status move; Status archived only via trips.archive; currency_locked once any expense or budget line exists (R9, write-path rule); trip_archived on archived trips (R29)
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import { createTripsService, moneyRecorded, writePath, type TripsService } from '@tribo/core';
import type { RequestContext } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addMember,
  createPlace,
  createTrip,
  createUser,
  type TripRole,
  type UserFixture,
} from './factories.js';

let tdb: TestDatabase;
let trips: TripsService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  trips = createTripsService(tdb.db, writePath(tdb.db), moneyRecorded);
});
afterAll(() => tdb.destroy());

let n = 0;
const ctx = (user: UserFixture): RequestContext => {
  n += 1;
  return { requestId: `trips-update-${String(n)}`, surface: 'web', userId: user.userId };
};
const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

/** A planning trip (version 1) and its owner. */
async function world() {
  const owner = await createUser(tdb.db);
  const { tripId, ownerMembershipId } = await createTrip(tdb.db, { owner });
  return { owner, tripId, ownerMembershipId };
}

const stored = (tripId: string) =>
  tdb.db
    .selectFrom('tribo.trips')
    .select(['name', 'currency', 'status', 'version'])
    .where('id', '=', tripId)
    .executeTakeFirstOrThrow();

const snapshots = (tripId: string) =>
  tdb.db
    .selectFrom('tribo.entity_versions')
    .selectAll()
    .where('entity_type', '=', 'trip')
    .where('entity_id', '=', tripId)
    .execute();

const events = (tripId: string) =>
  tdb.db
    .selectFrom('audit.audit_events')
    .selectAll()
    .where('entity_id', '=', tripId)
    .orderBy('seq')
    .execute();

describe('trips.update', () => {
  it.each<TripRole>(['owner', 'organizer'])('lets the %s edit the trip', async (role) => {
    const { owner, tripId } = await world();
    const editor = role === 'owner' ? owner : await createUser(tdb.db);
    if (role !== 'owner') await addMember(tdb.db, { tripId, personId: editor.personId, role });

    const trip = await trips.update(ctx(editor), tripId, { name: 'Palawan, take two' }, 1);
    expect(trip).toMatchObject({ id: tripId, name: 'Palawan, take two', version: 2 });
    expect(await stored(tripId)).toMatchObject({ name: 'Palawan, take two', version: 2 });
  });

  it.each<TripRole>(['member', 'viewer'])('refuses a %s with forbidden', async (role) => {
    const { tripId } = await world();
    const other = await createUser(tdb.db);
    await addMember(tdb.db, { tripId, personId: other.personId, role });
    expect(await refusal(trips.update(ctx(other), tripId, { name: 'Mine now' }, 1))).toMatchObject({
      code: 'forbidden',
    });
    expect(await stored(tripId)).toMatchObject({ version: 1 });
  });

  it('answers not_found to an account outside the trip, a platform admin included', async () => {
    const { tripId } = await world();
    for (const outsider of [
      await createUser(tdb.db),
      await createUser(tdb.db, { platformRole: 'admin' }),
    ]) {
      // eslint-disable-next-line no-await-in-loop -- two callers, one assertion each
      expect(await refusal(trips.update(ctx(outsider), tripId, { name: 'x' }, 1))).toMatchObject({
        code: 'not_found',
      });
    }
  });

  it.each([
    ['an unknown field', { colour: 'teal' }, '/'],
    ['an empty name', { name: ' ' }, '/name'],
    ['a malformed date', { startDate: '11/11/2026' }, '/startDate'],
    ['a place listed twice', { destinations: ['x', 'x'] }, '/destinations'],
  ])('refuses %s with validation_failed, writing nothing', async (_name, body, path) => {
    const { owner, tripId } = await world();
    const e = await refusal(trips.update(ctx(owner), tripId, body, 1));
    expect(e).toMatchObject({ code: 'validation_failed' });
    expect((e as { extra: { errors: { path: string }[] } }).extra.errors[0]?.path).toContain(path);
    expect(await stored(tripId)).toMatchObject({ version: 1 });
    expect(await snapshots(tripId)).toEqual([]);
  });

  it('refuses dates that end before they start, merged with the stored ones', async () => {
    const { owner, tripId } = await world();
    // The stored trip runs 2026-11-11 to 2026-11-14.
    expect(
      await refusal(trips.update(ctx(owner), tripId, { startDate: '2026-11-20' }, 1)),
    ).toMatchObject({ code: 'validation_failed', extra: { errors: [{ path: '/endDate' }] } });
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const { owner, tripId } = await world();
    expect(await refusal(trips.update(ctx(owner), tripId, { name: 'x' }, undefined))).toMatchObject(
      { code: 'if_match_required' },
    );
    await trips.update(ctx(owner), tripId, { name: 'First edit' }, 1);
    expect(await refusal(trips.update(ctx(owner), tripId, { name: 'Lost' }, 1))).toMatchObject({
      code: 'version_conflict',
    });
    expect(await stored(tripId)).toMatchObject({ name: 'First edit', version: 2 });
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const { owner, tripId } = await world();
    const c = ctx(owner);
    const place = await createPlace(tdb.db, { createdBy: owner.userId });
    await trips.update(
      c,
      tripId,
      { status: 'active', destinations: [encodeTypeId(ID_PREFIX.place, place)] },
      1,
    );

    expect(await snapshots(tripId)).toEqual([
      expect.objectContaining({
        version: 2,
        trip_id: tripId,
        snapshot: {
          name: expect.any(String) as unknown,
          startDate: '2026-11-11',
          endDate: '2026-11-14',
          currency: 'PHP',
          timezone: 'Asia/Manila',
          status: 'active',
          destinations: [place],
        },
      }),
    ]);
    expect(await events(tripId)).toEqual([
      expect.objectContaining({
        action: 'update',
        entity_type: 'trip',
        trip_id: tripId,
        version_before: 1,
        version_after: 2,
        actor_user_id: owner.userId,
        request_id: c.requestId,
      }),
    ]);
  });

  it('replaces destinations whole, in the order sent, and refuses an unknown place', async () => {
    const { owner, tripId } = await world();
    const [a, b, c] = await Promise.all(
      ['Coron', 'El Nido', 'Puerto Princesa'].map((name) =>
        createPlace(tdb.db, { createdBy: owner.userId, name }),
      ),
    );
    const plc = (id: string | undefined) => encodeTypeId(ID_PREFIX.place, id ?? '');
    await trips.update(ctx(owner), tripId, { destinations: [plc(a), plc(b)] }, 1);
    const trip = await trips.update(ctx(owner), tripId, { destinations: [plc(c), plc(a)] }, 2);
    expect(trip.destinations).toEqual([c, a]);

    const unknown = encodeTypeId(ID_PREFIX.place, '01900000-0000-7000-8000-000000000000');
    expect(
      await refusal(trips.update(ctx(owner), tripId, { destinations: [unknown] }, 3)),
    ).toMatchObject({ code: 'validation_failed', extra: { errors: [{ path: '/destinations' }] } });
    expect((await trips.get(owner.userId, tripId)).destinations).toEqual([c, a]);
  });

  it('answers invalid_transition on a backward move or a move to archived', async () => {
    const { owner, tripId } = await world();
    await trips.update(ctx(owner), tripId, { status: 'completed' }, 1);
    for (const status of ['active', 'archived']) {
      // eslint-disable-next-line no-await-in-loop -- one refusal per target status
      expect(await refusal(trips.update(ctx(owner), tripId, { status }, 2))).toMatchObject({
        code: 'invalid_transition',
      });
    }
    expect(await stored(tripId)).toMatchObject({ status: 'completed', version: 2 });
  });

  it('answers currency_locked once a budget line exists', async () => {
    const { owner, tripId } = await world();
    await trips.update(ctx(owner), tripId, { currency: 'USD' }, 1);
    await tdb.db
      .insertInto('tribo.budget_lines')
      .values({ trip_id: tripId, category: 'lodging', label: 'Hostel', planned_minor: 500000 })
      .execute();
    expect(await refusal(trips.update(ctx(owner), tripId, { currency: 'PHP' }, 2))).toMatchObject({
      code: 'currency_locked',
    });
    // Sending the currency it already has changes nothing, so it is no change.
    expect(
      await trips.update(ctx(owner), tripId, { currency: 'USD', name: 'Ok' }, 2),
    ).toMatchObject({ currency: 'USD', version: 3 });
  });

  it('answers currency_locked once any expense exists, a voided one included', async () => {
    const { owner, tripId, ownerMembershipId } = await world();
    await tdb.db
      .insertInto('tribo.expenses')
      .values({
        trip_id: tripId,
        category: 'food',
        description: 'Kinilaw by the pier',
        spent_on: '2026-11-12',
        payer_membership_id: ownerMembershipId,
        amount_minor: 45000,
        currency: 'PHP',
        trip_amount_minor: 45000,
        split_method: 'equal',
        deleted_at: new Date(),
      })
      .execute();
    expect(await refusal(trips.update(ctx(owner), tripId, { currency: 'USD' }, 1))).toMatchObject({
      code: 'currency_locked',
    });
    expect(await stored(tripId)).toMatchObject({ currency: 'PHP', version: 1 });
  });

  it('answers trip_archived on an archived trip', async () => {
    const { owner, tripId } = await world();
    await tdb.db
      .updateTable('tribo.trips')
      .set({ status: 'completed', archived_at: new Date() })
      .where('id', '=', tripId)
      .execute();
    expect(await refusal(trips.update(ctx(owner), tripId, { name: 'x' }, 1))).toMatchObject({
      code: 'trip_archived',
    });
  });
});
