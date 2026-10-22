// The items side of the reads that sum a trip up (itinerary.get, trips.dashboard): every
// item the caller can see, masked for them, with its board, and the board checks on those
// items. A fixed number of queries whatever the trip holds, so a polled read stays cheap.
import { forModule, type DB, type ValueOf } from '@tribo/db';
import type { Kysely } from 'kysely';
import { licensedMemberships, type CallerMembership } from '../trips/service.js';
import { boardWarnings } from './board-rules.js';
import { itemRecord, type ItemRecord } from './record.js';
import { listAllVisibleItems, listBoards, listVehicles } from './repo.js';

/** One row of an item's board, as the trip-wide reads need it. */
interface TripBoardRow {
  membershipId: string;
  role: ValueOf<'tribo.allocations.role'>;
  rsvp: ValueOf<'tribo.allocations.rsvp'> | null;
}

export interface TripItem {
  item: ItemRecord;
  board: TripBoardRow[];
}

/** no_licensed_driver on one vehicle of one of the items. */
interface VehicleWarning {
  code: 'no_licensed_driver';
  itemId: string;
  unitId: string;
}

interface TripItems {
  items: TripItem[];
  warnings: VehicleWarning[];
}

/**
 * The trip's items that tribo.item_visible lets this account see, in id order, as `viewer`
 * (the account's membership in the trip) reads them, each with its board; with a range,
 * only the items whose days overlap it. The board checks run on those items' boards only,
 * so they can never speak of an item the caller cannot see.
 */
export async function tripItems(
  db: Kysely<DB>,
  userId: string,
  viewer: CallerMembership,
  tripId: string,
  range: { from?: string; to?: string },
): Promise<TripItems> {
  const items = forModule(db, 'items');
  const rows = await listAllVisibleItems(items, userId, tripId, range);
  const ids = rows.map((r) => r.id);
  const [boardRows, vehicles] = await Promise.all([
    listBoards(items, ids),
    listVehicles(
      items,
      rows.filter((r) => r.type === 'ground').map((r) => r.id),
    ),
  ]);
  const boards = new Map<string, (TripBoardRow & { unitId: string | null })[]>();
  for (const r of boardRows) {
    const row = {
      membershipId: r.membership_id,
      role: r.role as TripBoardRow['role'],
      rsvp: r.rsvp as TripBoardRow['rsvp'],
      unitId: r.unit_id,
    };
    boards.set(r.item_id, [...(boards.get(r.item_id) ?? []), row]);
  }

  const drivers = boardRows.filter((r) => r.role === 'driver').map((r) => r.membership_id);
  const licensed = await licensedMemberships(db, tripId, drivers);
  const warnings = vehicles.flatMap((u) =>
    boardWarnings(
      [{ id: u.id, kind: 'vehicle', capacity: u.capacity }],
      boards.get(u.item_id) ?? [],
      licensed,
    ).map((w) => ({ code: w.code, itemId: u.item_id, unitId: w.unitId })),
  );

  return {
    items: rows.map((row) => ({
      item: itemRecord(row, viewer),
      board: (boards.get(row.id) ?? []).map(({ membershipId, role, rsvp }) => ({
        membershipId,
        role,
        rsvp,
      })),
    })),
    warnings,
  };
}
