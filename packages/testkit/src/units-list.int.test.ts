// @module-tag drop-a
// units.list (Drop A): Rooms of a lodging, vehicles of a rental; Rates masked per canViewCosts
import { createUnitsService, writePath, type UnitsService } from '@tribo/core';
import { ApiError } from '@tribo/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addMember,
  createItem,
  createTrip,
  createUnit,
  createUser,
  softDelete,
  type TripRole,
} from './factories.js';

let tdb: TestDatabase;
let units: UnitsService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  units = createUnitsService(tdb.db, writePath(tdb.db));
});
afterAll(() => tdb.destroy());

async function refusal(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).code;
}

const RATE = { amountMinor: 250_000, currency: 'PHP' };

/** A trip with one member of each role, a guest house with two priced rooms, and an outsider. */
async function world() {
  const owner = await createUser(tdb.db);
  const trip = await createTrip(tdb.db, { owner });
  const { tripId } = trip;
  const member = async (role: TripRole, canViewCosts = false) => {
    const user = await createUser(tdb.db);
    const membershipId = await addMember(tdb.db, {
      tripId,
      personId: user.personId,
      role,
      canViewCosts,
    });
    return { ...user, membershipId };
  };
  const w = {
    tripId,
    owner: { ...owner, membershipId: trip.ownerMembershipId },
    organizer: await member('organizer'),
    member: await member('member'),
    viewer: await member('viewer'),
    grantedViewer: await member('viewer', true),
    outsider: await createUser(tdb.db),
  };
  const itemId = await createItem(tdb.db, {
    tripId,
    ownerMembershipId: w.owner.membershipId,
    type: 'lodging',
    title: 'Lagwerta Guest House',
  });
  const room1 = await createUnit(tdb.db, { itemId, label: 'Room 1', rate: RATE });
  const room2 = await createUnit(tdb.db, { itemId, label: 'Room 2', capacity: 3 });
  return { ...w, itemId, room1, room2 };
}

describe('units.list', () => {
  it("lists the item's live units in the order they were added", async () => {
    const w = await world();
    const gone = await createUnit(tdb.db, { itemId: w.itemId, label: 'Closed room' });
    await softDelete(tdb.db, 'tribo.units', gone);
    const page = await units.list(w.owner.userId, w.itemId, { limit: 50 });
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      expect.objectContaining({
        id: w.room1,
        itemId: w.itemId,
        kind: 'room',
        label: 'Room 1',
        capacity: 2,
        bedType: null,
        rate: RATE,
        position: 0,
        version: 1,
      }),
      expect.objectContaining({ id: w.room2, label: 'Room 2', capacity: 3, rate: null }),
    ]);
  });

  it('lets owner, organizer, member and viewer list; masks rates for a viewer without canViewCosts', async () => {
    const w = await world();
    const rateSeenBy = async (userId: string) =>
      (await units.list(userId, w.itemId, { limit: 50 })).items.map((u) => u.rate);
    for (const user of [w.owner, w.organizer, w.member, w.grantedViewer]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      expect(await rateSeenBy(user.userId)).toEqual([RATE, null]);
    }
    expect(await rateSeenBy(w.viewer.userId)).toEqual(['masked', null]);
  });

  it("masks rates as the item's cost is masked, when the item restricts its cost", async () => {
    const w = await world();
    await tdb.db
      .updateTable('tribo.items')
      .set({ restricted_fields: ['cost'] })
      .where('id', '=', w.itemId)
      .execute();
    const rateSeenBy = async (userId: string) =>
      (await units.list(userId, w.itemId, { limit: 50 })).items.map((u) => u.rate);
    expect(await rateSeenBy(w.owner.userId)).toEqual([RATE, null]);
    expect(await rateSeenBy(w.organizer.userId)).toEqual([RATE, null]);
    // Restricted: masked even where none is stored, so its absence never shows.
    expect(await rateSeenBy(w.member.userId)).toEqual(['masked', 'masked']);
    expect(await rateSeenBy(w.grantedViewer.userId)).toEqual(['masked', 'masked']);
  });

  it('pages with a cursor', async () => {
    const w = await world();
    const first = await units.list(w.member.userId, w.itemId, { limit: 1 });
    expect(first.items.map((u) => u.id)).toEqual([w.room1]);
    expect(first.nextCursor).not.toBeNull();
    const second = await units.list(w.member.userId, w.itemId, {
      limit: 1,
      cursor: first.nextCursor ?? '',
    });
    expect(second.items.map((u) => u.id)).toEqual([w.room2]);
    expect(second.nextCursor).toBeNull();
    expect(
      await refusal(units.list(w.member.userId, w.itemId, { limit: 1, cursor: 'garbage' })),
    ).toBe('validation_failed');
  });

  it('answers not_found outside the trip, for an item the caller cannot see, and for a deleted item', async () => {
    const w = await world();
    expect(await refusal(units.list(w.outsider.userId, w.itemId, { limit: 50 }))).toBe('not_found');
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.organizer.membershipId,
      type: 'lodging',
      visibility: 'private',
    });
    await createUnit(tdb.db, { itemId: secret });
    expect(await refusal(units.list(w.member.userId, secret, { limit: 50 }))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.itemId);
    expect(await refusal(units.list(w.owner.userId, w.itemId, { limit: 50 }))).toBe('not_found');
  });
});
