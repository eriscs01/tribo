// @module-tag drop-a
// units.update (Drop A): Edit unit; capacity_exceeded if below occupants; trip_archived on archived trips (R29)
import type { UnitsService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archive, boardWorld, contexts, history, refusal, unitsService } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addAllocation, createItem, createUnit, softDelete } from './factories.js';

let tdb: TestDatabase;
let units: UnitsService;
const as = contexts('units-update');

beforeAll(async () => {
  tdb = await createTestDatabase();
  units = unitsService(tdb);
});
afterAll(() => tdb.destroy());

const unitRow = (unitId: string) =>
  tdb.db
    .selectFrom('tribo.units')
    .select(['label', 'capacity', 'bed_type', 'rate_minor', 'version', 'updated_by'])
    .where('id', '=', unitId)
    .executeTakeFirstOrThrow();

describe('units.update', () => {
  it('merge-patches the unit and bumps its version', async () => {
    const w = await boardWorld(tdb);
    const updated = await units.update(
      as(w.owner),
      w.room1,
      {
        label: 'Sea view',
        capacity: 3,
        bedType: 'queen',
        rate: { amountMinor: 220_000, currency: 'PHP' },
      },
      1,
    );
    expect(updated).toMatchObject({
      id: w.room1,
      label: 'Sea view',
      capacity: 3,
      bedType: 'queen',
      rate: { amountMinor: 220_000, currency: 'PHP' },
      version: 2,
    });
    await units.update(as(w.owner), w.room1, { bedType: null, rate: null }, 2);
    expect(await unitRow(w.room1)).toEqual({
      label: 'Sea view',
      capacity: 3,
      bed_type: null,
      rate_minor: null,
      version: 3,
      updated_by: w.owner.userId,
    });
  });

  it('lets the item owner, organizers and the owner edit; refuses other members and viewers', async () => {
    const w = await boardWorld(tdb);
    const ownItem = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      type: 'lodging',
    });
    const ownRoom = await createUnit(tdb.db, { itemId: ownItem });
    await expect(units.update(as(w.member), ownRoom, { capacity: 1 }, 1)).resolves.toMatchObject({
      version: 2,
    });
    await expect(units.update(as(w.organizer), w.room1, { capacity: 1 }, 1)).resolves.toMatchObject(
      { version: 2 },
    );
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId: w.member.membershipId,
      role: 'assignee',
    });
    expect(await refusal(units.update(as(w.member), w.room1, { capacity: 4 }, 2))).toBe(
      'forbidden',
    );
    expect(await refusal(units.update(as(w.viewer), w.room1, { capacity: 4 }, 2))).toBe(
      'forbidden',
    );
    expect((await unitRow(w.room1)).capacity).toBe(1);
  });

  it('answers not_found outside the trip, for a hidden item, a deleted unit and a deleted item', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(units.update(as(w.outsider), w.room1, { capacity: 1 }, 1))).toBe(
      'not_found',
    );
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      type: 'lodging',
      visibility: 'private',
    });
    const secretRoom = await createUnit(tdb.db, { itemId: secret });
    expect(await refusal(units.update(as(w.organizer), secretRoom, { capacity: 1 }, 1))).toBe(
      'not_found',
    );
    await softDelete(tdb.db, 'tribo.units', w.room2);
    expect(await refusal(units.update(as(w.owner), w.room2, { capacity: 1 }, 1))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.lodging);
    expect(await refusal(units.update(as(w.owner), w.room1, { capacity: 1 }, 1))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await boardWorld(tdb);
    const cases: [string, unknown][] = [
      [w.room1, { kind: 'vehicle' }],
      [w.room1, { capacity: 0 }],
      [w.room1, { label: '' }],
      [w.room1, { label: 'Room 2' }],
      [w.room1, null],
      // A vehicle has no bed type.
      [w.bike, { bedType: 'bunk' }],
    ];
    for (const [unitId, body] of cases) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(units.update(as(w.owner), unitId, body, 1));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect((await unitRow(w.room1)).version).toBe(1);
    expect((await unitRow(w.bike)).version).toBe(1);
  });

  it('refuses writing back a masked rate with masked_field_write', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(units.update(as(w.owner), w.room1, { rate: { masked: true } }, 1))).toBe(
      'masked_field_write',
    );
  });

  it('takes If-Match = version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(units.update(as(w.owner), w.room1, { capacity: 1 }, undefined))).toBe(
      'if_match_required',
    );
    await units.update(as(w.owner), w.room1, { capacity: 1 }, 1);
    expect(await refusal(units.update(as(w.owner), w.room1, { capacity: 2 }, 1))).toBe(
      'version_conflict',
    );
    expect((await unitRow(w.room1)).capacity).toBe(1);
  });

  it('records its audit event and entity_versions snapshot in the one transaction', async () => {
    const w = await boardWorld(tdb);
    const ctx = as(w.owner);
    await units.update(ctx, w.room1, { label: 'Garden room' }, 1);
    const { events, snapshots } = await history(tdb, w.room1);
    expect(events).toEqual([
      {
        chain_key: `trip:${w.tripId}`,
        action: 'update',
        entity_type: 'unit',
        version_before: 1,
        version_after: 2,
        request_id: ctx.requestId,
      },
    ]);
    expect(snapshots).toEqual([
      {
        entity_type: 'unit',
        version: 2,
        snapshot: {
          itemId: w.lodging,
          kind: 'room',
          label: 'Garden room',
          capacity: 2,
          bedType: null,
          rate: null,
          position: 0,
        },
      },
    ]);
  });

  it('answers capacity_exceeded below the current occupants, and lets it shrink to them', async () => {
    const w = await boardWorld(tdb);
    for (const m of [w.member, w.other]) {
      // eslint-disable-next-line no-await-in-loop -- rows go in one by one
      await addAllocation(tdb.db, {
        tripId: w.tripId,
        itemId: w.rental,
        membershipId: m.membershipId,
        role: m === w.member ? 'driver' : 'passenger',
        unitId: w.bike,
      });
    }
    // Attendees and assignees take no seat.
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.rental,
      membershipId: w.organizer.membershipId,
      role: 'attendee',
      rsvp: 'yes',
    });
    expect(await refusal(units.update(as(w.owner), w.bike, { capacity: 1 }, 1))).toBe(
      'capacity_exceeded',
    );
    expect((await unitRow(w.bike)).capacity).toBe(5);
    await expect(units.update(as(w.owner), w.bike, { capacity: 2 }, 1)).resolves.toMatchObject({
      capacity: 2,
    });
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await boardWorld(tdb);
    await archive(tdb, w.tripId);
    expect(await refusal(units.update(as(w.owner), w.room1, { capacity: 1 }, 1))).toBe(
      'trip_archived',
    );
    expect((await unitRow(w.room1)).version).toBe(1);
  });
});
