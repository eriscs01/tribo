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
