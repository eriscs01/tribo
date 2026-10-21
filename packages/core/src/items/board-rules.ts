// The assignment board's rules over its final state, as pure functions of the units and
// rows: the advisory checks a read or a save reports. No database, no caller.
import type { ValueOf } from '@tribo/db';

export interface BoardUnit {
  id: string;
  kind: ValueOf<'tribo.units.kind'>;
  capacity: number;
}

export interface BoardRow {
  membershipId: string;
  role: ValueOf<'tribo.allocations.role'>;
  unitId: string | null;
}

export interface BoardWarning {
  code: 'no_licensed_driver';
  unitId: string;
}

/**
 * no_licensed_driver for each vehicle in use (anyone seated in it) that has no driver, or
 * whose driver's person holds no licence; `licensed` names the memberships that do.
 */
export function boardWarnings(
  units: readonly BoardUnit[],
  rows: readonly BoardRow[],
  licensed: ReadonlySet<string>,
): BoardWarning[] {
  return units
    .filter((unit) => unit.kind === 'vehicle')
    .filter((vehicle) => {
      const seated = rows.filter((r) => r.unitId === vehicle.id);
      if (seated.length === 0) return false;
      const driver = seated.find((r) => r.role === 'driver');
      return driver === undefined || !licensed.has(driver.membershipId);
    })
    .map((vehicle) => ({ code: 'no_licensed_driver', unitId: vehicle.id }));
}

/** Why a board cannot be saved: a bad row at its path, or a broken hard invariant. */
export type BoardRefusal =
  | { code: 'validation_failed'; path: string; message: string }
  | { code: 'room_double_booked' | 'driver_taken' | 'capacity_exceeded' };

/** The roles that take a bed or a seat in a unit. */
const SEATED: ReadonlySet<BoardRow['role']> = new Set(['occupant', 'driver', 'passenger']);

/** The kinds of unit each role may name; null allowed only where listed. */
const UNIT_FOR: Partial<Record<BoardRow['role'], { kind: BoardUnit['kind']; message: string }>> = {
  occupant: { kind: 'room', message: 'an occupant takes a room' },
  driver: { kind: 'vehicle', message: 'a driver takes a vehicle' },
  passenger: { kind: 'vehicle', message: 'a passenger takes a vehicle' },
};

/**
 * The first rule the board's final state breaks, or null. Rows first (a unit of this item
 * and of the right kind, each role once, one seat per member), then the hard invariants: one
 * room per member, one driver per vehicle, and no unit over its capacity. Checking the final
 * state is what lets two members swap between full rooms.
 */
export function boardRefusal(
  units: readonly BoardUnit[],
  rows: readonly BoardRow[],
): BoardRefusal | null {
  const byId = new Map(units.map((u) => [u.id, u]));
  const roles = new Set<string>();
  const seats = new Map<string, BoardRow['role']>();
  let doubleBooked = false;
  for (const [i, row] of rows.entries()) {
    const invalid = (path: string, message: string): BoardRefusal => ({
      code: 'validation_failed',
      path: `/allocations/${String(i)}${path}`,
      message,
    });
    if (row.unitId !== null) {
      const unit = byId.get(row.unitId);
      if (!unit) return invalid('/unitId', 'not a unit of this item');
      const wanted = UNIT_FOR[row.role];
      if (wanted && unit.kind !== wanted.kind) return invalid('/unitId', wanted.message);
    }
    const role = `${row.membershipId}:${row.role}:${row.role === 'occupant' ? String(row.unitId) : ''}`;
    if (roles.has(role)) return invalid('', 'this member already has this role');
    roles.add(role);
    if (SEATED.has(row.role)) {
      const held = seats.get(row.membershipId);
      if (held === 'occupant' && row.role === 'occupant') doubleBooked = true;
      else if (held !== undefined) return invalid('', 'this member already has a seat here');
      seats.set(row.membershipId, row.role);
    }
  }
  if (doubleBooked) return { code: 'room_double_booked' };
  const seated = (unitId: string, role?: BoardRow['role']) =>
    rows.filter((r) => r.unitId === unitId && SEATED.has(r.role) && (!role || r.role === role))
      .length;
  if (units.some((u) => seated(u.id, 'driver') > 1)) return { code: 'driver_taken' };
  if (units.some((u) => seated(u.id) > u.capacity)) return { code: 'capacity_exceeded' };
  return null;
}
