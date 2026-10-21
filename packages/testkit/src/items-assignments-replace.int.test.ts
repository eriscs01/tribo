// @module-tag drop-a
// items.assignments.replace (Drop A): Save whole board; capacity checked on final state; capacity_exceeded, room_double_booked, driver_taken; If-Match on boardVersion; trip_archived on archived trips (R29)
import { encodeTypeId, ID_PREFIX } from '@tribo/contract';
import type { UnitsService } from '@tribo/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archive,
  boardWorld,
  contexts,
  history,
  refusal,
  unitsService,
  type Member,
} from './board-world.js';
import { createTestDatabase, type TestDatabase } from './database.js';
import {
  addAllocation,
  addMember,
  createItem,
  createTrip,
  createUnit,
  createUser,
  softDelete,
} from './factories.js';

let tdb: TestDatabase;
let units: UnitsService;
const as = contexts('board-replace');

beforeAll(async () => {
  tdb = await createTestDatabase();
  units = unitsService(tdb);
});
afterAll(() => tdb.destroy());

const mem = (m: Member | string) =>
  encodeTypeId(ID_PREFIX.membership, typeof m === 'string' ? m : m.membershipId);
const unt = (id: string) => encodeTypeId(ID_PREFIX.unit, id);

const occupant = (m: Member, room: string) => ({
  membershipId: mem(m),
  role: 'occupant',
  unitId: unt(room),
});

const rowsOf = (itemId: string) =>
  tdb.db
    .selectFrom('tribo.allocations')
    .select(['membership_id', 'role', 'unit_id', 'rsvp', 'created_by'])
    .where('item_id', '=', itemId)
    .orderBy('membership_id')
    .orderBy('role')
    .execute();

const counters = (itemId: string) =>
  tdb.db
    .selectFrom('tribo.items')
    .select(['version', 'board_version'])
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();

const byMember = <T extends { membershipId: string; role: string }>(rows: T[]) =>
  [...rows].sort(
    (a, b) => a.membershipId.localeCompare(b.membershipId) || a.role.localeCompare(b.role),
  );

/** Room 1: member and other; room 2: organizer and viewer. Board version 1 still. */
async function fullRooms() {
  const w = await boardWorld(tdb);
  const place = (m: Member, room: string) =>
    addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.lodging,
      membershipId: m.membershipId,
      role: 'occupant',
      unitId: room,
    });
  await place(w.member, w.room1);
  await place(w.other, w.room1);
  await place(w.organizer, w.room2);
  await place(w.viewer, w.room2);
  return w;
}

describe('items.assignments.replace', () => {
  it('replaces the whole board, bumps boardVersion only, and answers the board', async () => {
    const w = await fullRooms();
    const board = await units.replaceBoard(
      as(w.owner),
      w.lodging,
      {
        allocations: [
          occupant(w.member, w.room1),
          { membershipId: mem(w.member), role: 'attendee', rsvp: 'yes' },
          { membershipId: mem(w.other), role: 'attendee' },
          { membershipId: mem(w.organizer), role: 'assignee', unitId: null },
        ],
      },
      1,
    );
    expect(board).toEqual({
      itemId: w.lodging,
      boardVersion: 2,
      allocations: byMember([
        { membershipId: w.member.membershipId, role: 'attendee', unitId: null, rsvp: 'yes' },
        { membershipId: w.member.membershipId, role: 'occupant', unitId: w.room1, rsvp: null },
        { membershipId: w.other.membershipId, role: 'attendee', unitId: null, rsvp: 'pending' },
        { membershipId: w.organizer.membershipId, role: 'assignee', unitId: null, rsvp: null },
      ]),
      warnings: [],
    });
    const rows = await rowsOf(w.lodging);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.created_by === w.owner.userId)).toBe(true);
    expect(await counters(w.lodging)).toEqual({ version: 1, board_version: 2 });
    // The board read agrees with what the save answered.
    expect(await units.board(w.member.userId, w.lodging)).toEqual(board);
  });

  it('checks capacity on the final state, so two members swap between full rooms in one save', async () => {
    const w = await fullRooms();
    const swapped = [
      occupant(w.organizer, w.room1),
      occupant(w.other, w.room1),
      occupant(w.member, w.room2),
      occupant(w.viewer, w.room2),
    ];
    await expect(
      units.replaceBoard(as(w.owner), w.lodging, { allocations: swapped }, 1),
    ).resolves.toMatchObject({ boardVersion: 2 });
    const rooms = await rowsOf(w.lodging);
    expect(rooms.find((r) => r.membership_id === w.member.membershipId)?.unit_id).toBe(w.room2);
  });

  it('lets the item owner, organizers and the owner save; refuses assigned members and viewers', async () => {
    const w = await boardWorld(tdb);
    const ownItem = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.member.membershipId,
      type: 'meal',
    });
    const attend = (m: Member) => ({ allocations: [{ membershipId: mem(m), role: 'attendee' }] });
    await expect(
      units.replaceBoard(as(w.member), ownItem, attend(w.member), 1),
    ).resolves.toMatchObject({ boardVersion: 2 });
    await expect(
      units.replaceBoard(as(w.organizer), w.lodging, attend(w.other), 1),
    ).resolves.toMatchObject({ boardVersion: 2 });
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: w.rental,
      membershipId: w.other.membershipId,
      role: 'assignee',
    });
    // Being assigned is not enough: the whole board stays with its managers.
    expect(await refusal(units.replaceBoard(as(w.other), w.rental, attend(w.other), 1))).toBe(
      'forbidden',
    );
    expect(await refusal(units.replaceBoard(as(w.viewer), w.rental, attend(w.viewer), 1))).toBe(
      'forbidden',
    );
    expect(await counters(w.rental)).toEqual({ version: 1, board_version: 1 });
  });

  it('answers not_found outside the trip, for a hidden item and for a deleted item', async () => {
    const w = await boardWorld(tdb);
    const empty = { allocations: [] };
    expect(await refusal(units.replaceBoard(as(w.outsider), w.lodging, empty, 1))).toBe(
      'not_found',
    );
    const secret = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.other.membershipId,
      visibility: 'private',
    });
    expect(await refusal(units.replaceBoard(as(w.organizer), secret, empty, 1))).toBe('not_found');
    await softDelete(tdb.db, 'tribo.items', w.lodging);
    expect(await refusal(units.replaceBoard(as(w.owner), w.lodging, empty, 1))).toBe('not_found');
  });

  it('refuses an invalid body with validation_failed, writing nothing', async () => {
    const w = await fullRooms();
    const strangerTrip = await createTrip(tdb.db, { owner: await createUser(tdb.db) });
    const otherRoom = await createUnit(tdb.db, {
      itemId: await createItem(tdb.db, {
        tripId: w.tripId,
        ownerMembershipId: w.owner.membershipId,
        type: 'lodging',
      }),
    });
    const goneRoom = await createUnit(tdb.db, { itemId: w.lodging, label: 'Closed' });
    await softDelete(tdb.db, 'tribo.units', goneRoom);
    const removed = await createUser(tdb.db);
    const removedMembership = await addMember(tdb.db, {
      tripId: w.tripId,
      personId: removed.personId,
      role: 'member',
    });
    await softDelete(tdb.db, 'tribo.memberships', removedMembership);
    const bodies: unknown[] = [
      {},
      null,
      { allocations: [{ membershipId: mem(w.member), role: 'occupant' }] },
      { allocations: [{ membershipId: mem(w.member), role: 'assignee', rsvp: 'yes' }] },
      { allocations: [{ membershipId: mem(w.member), role: 'attendee', unitId: unt(w.room1) }] },
      { allocations: [{ membershipId: 'mem_nope', role: 'attendee' }] },
      // A unit of another item, a deleted unit, and a vehicle where a room belongs.
      { allocations: [occupant(w.member, otherRoom)] },
      { allocations: [occupant(w.member, goneRoom)] },
      { allocations: [{ membershipId: mem(w.member), role: 'driver', unitId: unt(w.room1) }] },
      // Memberships of another trip, and removed ones, are refused.
      { allocations: [{ membershipId: mem(strangerTrip.ownerMembershipId), role: 'attendee' }] },
      { allocations: [{ membershipId: mem(removedMembership), role: 'attendee' }] },
      {
        allocations: [
          { membershipId: mem(w.member), role: 'attendee' },
          { membershipId: mem(w.member), role: 'attendee' },
        ],
      },
    ];
    for (const body of bodies) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked on its own
      const code = await refusal(units.replaceBoard(as(w.owner), w.lodging, body, 1));
      expect(code, JSON.stringify(body)).toBe('validation_failed');
    }
    expect(await rowsOf(w.lodging)).toHaveLength(4);
    expect(await counters(w.lodging)).toEqual({ version: 1, board_version: 1 });
  });

  it('names the row a membership refusal is about', async () => {
    const w = await boardWorld(tdb);
    const strangerTrip = await createTrip(tdb.db, { owner: await createUser(tdb.db) });
    const error: unknown = await units
      .replaceBoard(
        as(w.owner),
        w.lodging,
        {
          allocations: [
            { membershipId: mem(w.member), role: 'attendee' },
            { membershipId: mem(strangerTrip.ownerMembershipId), role: 'attendee' },
          ],
        },
        1,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'validation_failed',
      extra: {
        errors: [{ path: '/allocations/1/membershipId', message: 'not a member of this trip' }],
      },
    });
  });

  it('takes If-Match = board_version: refuses none with if_match_required, a stale one with version_conflict', async () => {
    const w = await fullRooms();
    const body = { allocations: [occupant(w.member, w.room1)] };
    expect(await refusal(units.replaceBoard(as(w.owner), w.lodging, body, undefined))).toBe(
      'if_match_required',
    );
    expect(await refusal(units.replaceBoard(as(w.owner), w.lodging, body, 2))).toBe(
      'version_conflict',
    );
    expect(await rowsOf(w.lodging)).toHaveLength(4);
  });

  it('serialises concurrent saves on the item lock: the second sees a moved boardVersion', async () => {
    const w = await fullRooms();
    const results = await Promise.allSettled([
      units.replaceBoard(as(w.owner), w.lodging, { allocations: [occupant(w.member, w.room1)] }, 1),
      units.replaceBoard(
        as(w.organizer),
        w.lodging,
        { allocations: [occupant(w.other, w.room2)] },
        1,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')?.reason).toMatchObject({
      code: 'version_conflict',
    });
    expect(await rowsOf(w.lodging)).toHaveLength(1);
    expect(await counters(w.lodging)).toEqual({ version: 1, board_version: 2 });
  });

  it('records one item_board audit event and snapshot in the one transaction', async () => {
    const w = await fullRooms();
    const ctx = as(w.organizer);
    await units.replaceBoard(
      ctx,
      w.lodging,
      {
        allocations: [
          occupant(w.member, w.room2),
          { membershipId: mem(w.other), role: 'attendee' },
        ],
      },
      1,
    );
    expect(await history(tdb, w.lodging)).toEqual({
      events: [
        {
          chain_key: `trip:${w.tripId}`,
          action: 'update',
          entity_type: 'item_board',
          version_before: 1,
          version_after: 2,
          request_id: ctx.requestId,
        },
      ],
      snapshots: [
        {
          entity_type: 'item_board',
          version: 2,
          snapshot: {
            allocations: byMember([
              {
                membershipId: w.member.membershipId,
                unitId: w.room2,
                role: 'occupant',
                rsvp: null,
              },
              {
                membershipId: w.other.membershipId,
                unitId: null,
                role: 'attendee',
                rsvp: 'pending',
              },
            ]),
          },
        },
      ],
    });
  });

  it('answers capacity_exceeded over a room’s beds or a vehicle’s seats, writing nothing', async () => {
    const w = await fullRooms();
    const three = [
      occupant(w.member, w.room1),
      occupant(w.other, w.room1),
      occupant(w.viewer, w.room1),
    ];
    expect(
      await refusal(units.replaceBoard(as(w.owner), w.lodging, { allocations: three }, 1)),
    ).toBe('capacity_exceeded');
    await tdb.db.updateTable('tribo.units').set({ capacity: 2 }).where('id', '=', w.bike).execute();
    const riders = [
      { membershipId: mem(w.member), role: 'driver', unitId: unt(w.bike) },
      { membershipId: mem(w.other), role: 'passenger', unitId: unt(w.bike) },
      { membershipId: mem(w.viewer), role: 'passenger', unitId: unt(w.bike) },
    ];
    expect(
      await refusal(units.replaceBoard(as(w.owner), w.rental, { allocations: riders }, 1)),
    ).toBe('capacity_exceeded');
    expect(await rowsOf(w.lodging)).toHaveLength(4);
    expect(await rowsOf(w.rental)).toEqual([]);
  });

  it('answers driver_taken for a second driver of one vehicle', async () => {
    const w = await boardWorld(tdb);
    const drivers = [
      { membershipId: mem(w.member), role: 'driver', unitId: unt(w.bike) },
      { membershipId: mem(w.other), role: 'driver', unitId: unt(w.bike) },
    ];
    expect(
      await refusal(units.replaceBoard(as(w.owner), w.rental, { allocations: drivers }, 1)),
    ).toBe('driver_taken');
  });

  it('answers room_double_booked for a member in two rooms of the item', async () => {
    const w = await boardWorld(tdb);
    const twice = [occupant(w.member, w.room1), occupant(w.member, w.room2)];
    expect(
      await refusal(units.replaceBoard(as(w.owner), w.lodging, { allocations: twice }, 1)),
    ).toBe('room_double_booked');
  });

  it('answers room_double_booked for a member in a room of another lodging the same night', async () => {
    const w = await boardWorld(tdb);
    // The guest house runs 11–14 Nov; this one 13–15 Nov, so the night of the 13th is shared.
    const later = await createItem(tdb.db, {
      tripId: w.tripId,
      ownerMembershipId: w.owner.membershipId,
      type: 'lodging',
      days: { start: '2026-11-13', end: '2026-11-15' },
    });
    const laterRoom = await createUnit(tdb.db, { itemId: later });
    await addAllocation(tdb.db, {
      tripId: w.tripId,
      itemId: later,
      membershipId: w.member.membershipId,
      role: 'occupant',
      unitId: laterRoom,
    });
    expect(
      await refusal(
        units.replaceBoard(
          as(w.owner),
          w.lodging,
          { allocations: [occupant(w.member, w.room1)] },
          1,
        ),
      ),
    ).toBe('room_double_booked');
  });

  it('lets a member check out the day another stay checks in, and ignores stays the caller cannot see', async () => {
    const w = await boardWorld(tdb);
    const stay = async (days: { start: string; end: string }, visibility: 'shared' | 'private') => {
      const itemId = await createItem(tdb.db, {
        tripId: w.tripId,
        ownerMembershipId: w.member.membershipId,
        type: 'lodging',
        days,
        visibility,
      });
      const unitId = await createUnit(tdb.db, { itemId });
      await addAllocation(tdb.db, {
        tripId: w.tripId,
        itemId,
        membershipId: w.member.membershipId,
        role: 'occupant',
        unitId,
      });
    };
    // Checks in the 14th, the guest house's check-out day: no shared night.
    await stay({ start: '2026-11-14', end: '2026-11-16' }, 'shared');
    // The member's own private booking the same nights: the owner cannot see it (decision 0009).
    await stay({ start: '2026-11-11', end: '2026-11-12' }, 'private');
    await expect(
      units.replaceBoard(as(w.owner), w.lodging, { allocations: [occupant(w.member, w.room1)] }, 1),
    ).resolves.toMatchObject({ boardVersion: 2 });
  });

  it('saves a board with an advisory problem and reports it in warnings', async () => {
    const w = await boardWorld(tdb);
    const board = await units.replaceBoard(
      as(w.owner),
      w.rental,
      { allocations: [{ membershipId: mem(w.member), role: 'passenger', unitId: unt(w.bike) }] },
      1,
    );
    expect(board.warnings).toEqual([{ code: 'no_licensed_driver', unitId: w.bike }]);
    expect(await rowsOf(w.rental)).toHaveLength(1);
  });

  it('answers trip_archived on an archived trip, writing nothing', async () => {
    const w = await fullRooms();
    await archive(tdb, w.tripId);
    expect(await refusal(units.replaceBoard(as(w.owner), w.lodging, { allocations: [] }, 1))).toBe(
      'trip_archived',
    );
    expect(await rowsOf(w.lodging)).toHaveLength(4);
  });
});
