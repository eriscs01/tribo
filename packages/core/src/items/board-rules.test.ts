import { describe, expect, it } from 'vitest';
import { boardWarnings, type BoardRow, type BoardUnit } from './board-rules.js';

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
