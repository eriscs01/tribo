// @module-tag drop-a
// items.assignments.get (Drop A): Whole board: RSVPs, occupants, drivers, passengers, assignees; Follows item_visible; ETag = boardVersion
import type { UnitsService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardWorld, refusal, unitsService, type Member } from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import { addAllocation, createItem, createUnit, softDelete } from './factories.js';

let tdb: TestDatabase;
let units: UnitsService;

beforeAll(async () => {
  tdb = await createTestDatabase();
  units = unitsService(tdb);
});
afterAll(() => tdb.destroy());

const licensed = (m: Member) =>
  tdb.db
    .updateTable('tribo.persons')
    .set({ driving_licence: true })
    .where('id', '=', m.personId)
    .execute();

describe('items.assignments.get', () => {
  it('reads the whole board: RSVPs, occupants and assignees, with its boardVersion', async () => {
    const w = await boardWorld(tdb);
    const add = (
      m: Member,
      role: 'attendee' | 'occupant' | 'assignee',
      extra: { unitId?: string; rsvp?: 'yes' | 'pending' } = {},
    ) =>
      addAllocation(tdb.db, {
        tripId: w.tripId,
        itemId: w.lodging,
        membershipId: m.membershipId,
        role,
        ...extra,
      });
    await add(w.member, 'occupant', { unitId: w.room1 });
    await add(w.member, 'attendee', { rsvp: 'yes' });
    await add(w.other, 'occupant', { unitId: w.room2 });
    await add(w.other, 'attendee', { rsvp: 'pending' });
    await add(w.organizer, 'assignee');
    await tdb.db
      .updateTable('tribo.items')
      .set({ board_version: 4 })
      .where('id', '=', w.lodging)
      .execute();

    const board = await units.board(w.viewer.userId, w.lodging);
    const allocations = [
      { membershipId: w.member.membershipId, role: 'attendee', unitId: null, rsvp: 'yes' },
      { membershipId: w.member.membershipId, role: 'occupant', unitId: w.room1, rsvp: null },
      { membershipId: w.other.membershipId, role: 'attendee', unitId: null, rsvp: 'pending' },
      { membershipId: w.other.membershipId, role: 'occupant', unitId: w.room2, rsvp: null },
      { membershipId: w.organizer.membershipId, role: 'assignee', unitId: null, rsvp: null },
    ].sort((a, b) => a.membershipId.localeCompare(b.membershipId) || a.role.localeCompare(b.role));
    expect(board).toEqual({ itemId: w.lodging, boardVersion: 4, allocations, warnings: [] });
  });

  it('lets owner, organizer, member and viewer read it', async () => {
    const w = await boardWorld(tdb);
    for (const user of [w.owner, w.organizer, w.member, w.viewer]) {
      // eslint-disable-next-line no-await-in-loop -- each role is checked on its own
      await expect(units.board(user.userId, w.rental)).resolves.toMatchObject({
        itemId: w.rental,
        boardVersion: 1,
      });
    }
  });

  it('answers not_found outside the trip, for a hidden item, a deleted item and a deleted trip', async () => {
    const w = await boardWorld(tdb);
    expect(await refusal(units.board(w.outsider.userId, w.lodging))).toBe('not_found');
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
    });
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: secret,
      membershipId: w.other.membershipId,
      role: 'assignee',
    });
    expect(await refusal(units.board(w.member.userId, secret))).toBe('not_found');
    expect(await refusal(units.board(w.owner.userId, secret))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.lodging);
    expect(await refusal(units.board(w.owner.userId, w.lodging))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.trips', w.tripId);
    expect(await refusal(units.board(w.owner.userId, w.rental))).toBe('not_found');
  });

  it('warns no_licensed_driver for a vehicle in use with no driver, or a driver without a licence', async () => {
    const w = await boardWorld(tdb);
    const bike2 = await createUnit(tdb.db, { itemId: w.rental, kind: 'vehicle', capacity: 5 });
    const bike3 = await createUnit(tdb.db, { itemId: w.rental, kind: 'vehicle', capacity: 5 });
    await createUnit(tdb.db, { itemId: w.rental, kind: 'vehicle', capacity: 5 });
    const seat = (m: Member, role: 'driver' | 'passenger', unitId: string) =>
      addAllocation(tdb.db, {
        tripId: w.tripId,
        itemId: w.rental,
        membershipId: m.membershipId,
        role,
        unitId,
      });
    // bike: passengers only. bike2: an unlicensed driver. bike3: a licensed driver. bike4: unused.
    await seat(w.member, 'passenger', w.bike);
    await seat(w.other, 'driver', bike2);
    await licensed(w.organizer);
    await seat(w.organizer, 'driver', bike3);
    await seat(w.viewer, 'passenger', bike3);
    const board = await units.board(w.member.userId, w.rental);
    expect(board.warnings).toEqual(
      [
        { code: 'no_licensed_driver', unitId: w.bike },
        { code: 'no_licensed_driver', unitId: bike2 },
      ].sort((a, b) => a.unitId.localeCompare(b.unitId)),
    );
  });
});
