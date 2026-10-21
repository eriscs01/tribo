// @module-tag drop-a
// units.create (Drop A): Add room or vehicle: label, capacity, rate; trip_archived on archived trips (R29)
import type { UnitsService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, boardWorld, contexts, history, refusal, unitsService } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addAllocation, createItem, softDelete } from './factories.js';

let tdb: TestDatabase;
let units: UnitsService;
const as = contexts('units-create');

beforeAll(async () => {
  tdb = await createTestDatabase();
  units = unitsService(tdb);
});
afterAll(() => tdb.destroy());

const ROOM = {
  kind: 'room',
  label: 'Room 3',
  capacity: 2,
  bedType: 'double',
  rate: { amountMinor: 180_000, currency: 'PHP' },
};

const unitsOf = (itemId: string) =>
  tdb.db
    .selectFrom('tribo.units')
    .select(['label', 'created_by'])
    .where('item_id', '=', itemId)
    .orderBy('id')
    .execute();

describe('units.create', () => {
  it('adds a room to a lodging and a vehicle to a ground rental', async () => {
    const w = await boardWorld(tdb);
    const room = await units.create(as(w.owner), w.lodging, ROOM);
    expect(room).toEqual({
      id: expect.any(String) as string,
      itemId: w.lodging,
      kind: 'room',
      label: 'Room 3',
      capacity: 2,
      bedType: 'double',
      rate: ROOM.rate,
      position: 0,
      version: 1,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
    });
    const bike = await units.create(as(w.owner), w.rental, {
      kind: 'vehicle',
      label: 'E-bike 2',
      capacity: 5,
      position: 1,
    });
    expect(bike).toMatchObject({ kind: 'vehicle', capacity: 5, rate: null, position: 1 });
    expect((await unitsOf(w.lodging)).at(-1)).toEqual({
      label: 'Room 3',
      created_by: w.owner.userId,
    });
  });

  it('lets the item owner, organizers and the owner add units; refuses other members and viewers', async () => {
    const w = await boardWorld(tdb);
    const ownItem = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      type: 'lodging',
    });
    await expect(
      units.create(as(w.member), ownItem, { ...ROOM, label: 'Mine' }),
    ).resolves.toMatchObject({ label: 'Mine' });
    await expect(
      units.create(as(w.organizer), w.lodging, { ...ROOM, label: 'Organized' }),
    ).resolves.toMatchObject({ label: 'Organized' });
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId: w.member.membershipId,
      role: 'assignee',
    });
    // Being assigned is not enough.
    expect(await refusal(units.create(as(w.member), w.lodging, ROOM))).toBe('forbidden');
    expect(await refusal(units.create(as(w.viewer), w.lodging, ROOM))).toBe('forbidden');
    expect((await unitsOf(w.lodging)).map((u) => u.label)).toEqual([
      'Room 1',
      'Room 2',
      'Organized',
    ]);
  });

  it('answers not_found outside the trip, for an item the caller cannot see, and for a deleted item', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(units.create(as(w.outsider), w.lodging, ROOM))).toBe('not_found');
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      type: 'lodging',
      visibility: 'private',
    });
    expect(await refusal(units.create(as(w.organizer), secret, ROOM))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.lodging);
    expect(await refusal(units.create(as(w.owner), w.lodging, ROOM))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await boardWorld(tdb);
    const bodies: [string, unknown][] = [
      [w.lodging, {}],
      [w.lodging, { ...ROOM, capacity: 0 }],
      [w.lodging, { ...ROOM, capacity: 101 }],
      [w.lodging, { ...ROOM, label: '' }],
      [w.lodging, { ...ROOM, rate: { amountMinor: -1, currency: 'PHP' } }],
      [w.lodging, { ...ROOM, rate: { masked: true } }],
      [w.lodging, { ...ROOM, kind: 'tent' }],
      [w.rental, { kind: 'vehicle', label: 'Van', capacity: 8, bedType: 'bunk' }],
      // A room belongs to a lodging, a vehicle to a ground rental.
      [w.rental, ROOM],
      [w.lodging, { kind: 'vehicle', label: 'Van', capacity: 8 }],
      // Labels are unique among the item's live units.
      [w.lodging, { ...ROOM, label: 'Room 1' }],
    ];
    for (const [itemId, body] of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(units.create(as(w.owner), itemId, body));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await unitsOf(w.lodging)).toHaveLength(2);
    expect(await unitsOf(w.rental)).toHaveLength(1);
  });

  it('reuses the label of a deleted unit', async () => {
    const w = await boardWorld(tdb);
    await softDelete(tdb.db, 'tribo.units', w.room1);
    await expect(
      units.create(as(w.owner), w.lodging, { ...ROOM, label: 'Room 1' }),
    ).resolves.toMatchObject({ label: 'Room 1' });
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await boardWorld(tdb);
    const ctx = as(w.organizer);
    const room = await units.create(ctx, w.lodging, ROOM);
    expect(await history(tdb, room.id)).toEqual({
      events: [
        {
          chain_key: `trip:${w.tripId}`,
          action: 'create',
          entity_type: 'unit',
          version_before: null,
          version_after: 1,
          request_id: ctx.requestId,
        },
      ],
      snapshots: [
        {
          entity_type: 'unit',
          version: 1,
          snapshot: {
            itemId: w.lodging,
            kind: 'room',
            label: 'Room 3',
            capacity: 2,
            bedType: 'double',
            rate: ROOM.rate,
            position: 0,
          },
        },
      ],
    });
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await boardWorld(tdb);
    await archive(tdb, w.tripId);
    expect(await refusal(units.create(as(w.owner), w.lodging, ROOM))).toBe('trip_archived');
    expect(await unitsOf(w.lodging)).toHaveLength(2);
  });

  it('takes no Idempotency-Key in 1a: the same body twice is a second create, refused for its label', async () => {
    const w = await boardWorld(tdb);
    await units.create(as(w.owner), w.lodging, ROOM);
    expect(await refusal(units.create(as(w.owner), w.lodging, ROOM))).toBe('validation_failed');
  });
});
