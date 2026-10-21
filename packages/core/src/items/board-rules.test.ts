import { describe, expect, it } from 'vitest';
import { boardRefusal, boardWarnings, type BoardRow, type BoardUnit } from './board-rules.js';

const room: BoardUnit = { id: 'room', kind: 'room', capacity: 2 };
const bike: BoardUnit = { id: 'bike', kind: 'vehicle', capacity: 5 };
const van: BoardUnit = { id: 'van', kind: 'vehicle', capacity: 8 };

const row = (membershipId: string, role: BoardRow['role'], unitId: string | null): BoardRow => ({
  membershipId,
  role,
  unitId,
});

describe('boardWarnings', () => {
  it('warns about a vehicle in use with no driver', () => {
    expect(boardWarnings([bike, van], [row('a', 'passenger', 'bike')], new Set())).toEqual([
      { code: 'no_licensed_driver', unitId: 'bike' },
    ]);
  });

  it('warns about a driver without a licence, not about one with', () => {
    const rows = [row('a', 'driver', 'bike'), row('b', 'driver', 'van')];
    expect(boardWarnings([bike, van], rows, new Set(['b']))).toEqual([
      { code: 'no_licensed_driver', unitId: 'bike' },
    ]);
  });

  it('says nothing about unused vehicles, rooms, or passengers without a vehicle', () => {
    const rows = [
      row('a', 'occupant', 'room'),
      row('b', 'passenger', null),
      row('c', 'attendee', null),
    ];
    expect(boardWarnings([room, bike], rows, new Set())).toEqual([]);
  });
});

describe('boardRefusal', () => {
  const room2: BoardUnit = { id: 'room2', kind: 'room', capacity: 2 };
  const units = [room, room2, bike];

  it('accepts a board that keeps every rule, swaps between full rooms included', () => {
    const rows = [
      row('a', 'occupant', 'room'),
      row('b', 'occupant', 'room'),
      row('c', 'occupant', 'room2'),
      row('a', 'attendee', null),
    ];
    expect(boardRefusal([room, room2], rows)).toBeNull();
    expect(
      boardRefusal(
        [bike],
        [row('a', 'driver', 'bike'), row('b', 'passenger', 'bike'), row('c', 'passenger', null)],
      ),
    ).toBeNull();
  });

  it('refuses a unit that is not one of the item’s, or of the wrong kind, at its path', () => {
    expect(boardRefusal(units, [row('a', 'occupant', 'gone')])).toEqual({
      code: 'validation_failed',
      path: '/allocations/0/unitId',
      message: 'not a unit of this item',
    });
    expect(boardRefusal(units, [row('a', 'attendee', null), row('a', 'driver', 'room')])).toEqual({
      code: 'validation_failed',
      path: '/allocations/1/unitId',
      message: 'a driver takes a vehicle',
    });
    expect(boardRefusal(units, [row('a', 'occupant', 'bike')])).toMatchObject({
      path: '/allocations/0/unitId',
      message: 'an occupant takes a room',
    });
    expect(boardRefusal(units, [row('a', 'passenger', 'room')])).toMatchObject({
      path: '/allocations/0/unitId',
    });
  });

  it('refuses a role held twice, and two seats for one member, at its path', () => {
    expect(boardRefusal(units, [row('a', 'assignee', null), row('a', 'assignee', null)])).toEqual({
      code: 'validation_failed',
      path: '/allocations/1',
      message: 'this member already has this role',
    });
    expect(
      boardRefusal(units, [row('a', 'driver', 'bike'), row('a', 'passenger', 'bike')]),
    ).toMatchObject({ path: '/allocations/1', message: 'this member already has a seat here' });
    expect(
      boardRefusal(units, [row('a', 'occupant', 'room'), row('a', 'occupant', 'room')]),
    ).toMatchObject({
      path: '/allocations/1',
      message: 'this member already has this role',
    });
  });

  it('refuses a member in two rooms with room_double_booked', () => {
    expect(
      boardRefusal(units, [row('a', 'occupant', 'room'), row('a', 'occupant', 'room2')]),
    ).toEqual({ code: 'room_double_booked' });
  });

  it('refuses a second driver with driver_taken', () => {
    expect(boardRefusal(units, [row('a', 'driver', 'bike'), row('b', 'driver', 'bike')])).toEqual({
      code: 'driver_taken',
    });
  });

  it('refuses more seats than the capacity with capacity_exceeded, driver included', () => {
    const rows = ['a', 'b', 'c'].map((m) => row(m, 'occupant', 'room'));
    expect(boardRefusal(units, rows)).toEqual({ code: 'capacity_exceeded' });
    const riders = ['b', 'c', 'd', 'e', 'f'].map((m) => row(m, 'passenger', 'bike'));
    expect(boardRefusal(units, [row('a', 'driver', 'bike'), ...riders])).toEqual({
      code: 'capacity_exceeded',
    });
  });
});
