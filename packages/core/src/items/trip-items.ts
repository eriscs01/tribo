// The items side of the reads that sum a trip up (itinerary.get, trips.dashboard,
// trips.offlineBundle): every item the caller can see, masked for them, with its board and
// units, and the board checks on those items. A fixed number of queries whatever the trip
// holds, so a polled read stays cheap.
import { forModule, type DB, type ValueOf } from '@tribo/db';
import type { Kysely } from 'kysely';
import { licensedMemberships, type CallerMembership } from '../trips/service.js';
import { boardWarnings } from './board-rules.js';
import { itemRecord, type ItemRecord } from './record.js';
import { listAllVisibleItems, listBoards, listItemsUnits } from './repo.js';
import { boardUnit, unitRecord, type BoardRecord, type UnitRecord } from './units.js';

/** One row of an item's board, as the trip-wide reads need it. */
interface TripBoardRow {
  membershipId: string;
  role: ValueOf<'tribo.allocations.role'>;
  unitId: string | null;
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
  /** The rooms and vehicles of those items, in id order, rates masked as units.list masks them. */
  units: UnitRecord[];
  warnings: VehicleWarning[];
}

/**
 * The trip's items that tribo.item_visible lets this account see, in id order, as `viewer`
 * (the account's membership in the trip) reads them, each with its board, and their units;
 * with a range, only the items whose days overlap it, and with a limit, only the first that
 * many. The board checks run on those items' boards only, so they can never speak of an
 * item the caller cannot see.
 */
export async function tripItems(
  db: Kysely<DB>,
  userId: string,
  viewer: CallerMembership,
  tripId: string,
  range: { from?: string; to?: string },
  limit?: number,
): Promise<TripItems> {
  const items = forModule(db, 'items');
  const rows = await listAllVisibleItems(items, userId, tripId, range, limit);
  const ids = rows.map((r) => r.id);
  const [boardRows, unitRows] = await Promise.all([
    listBoards(items, ids),
    listItemsUnits(items, ids),
  ]);
  const boards = new Map<string, TripBoardRow[]>();
  for (const r of boardRows) {
    const row = {
      membershipId: r.membership_id,
      role: r.role as TripBoardRow['role'],
      unitId: r.unit_id,
      rsvp: r.rsvp as TripBoardRow['rsvp'],
    };
    boards.set(r.item_id, [...(boards.get(r.item_id) ?? []), row]);
  }

  const drivers = boardRows.filter((r) => r.role === 'driver').map((r) => r.membership_id);
  const licensed = await licensedMemberships(db, tripId, drivers);
  const warnings = unitRows.flatMap((u) =>
    boardWarnings([boardUnit(u)], boards.get(u.item_id) ?? [], licensed).map((w) => ({
      code: w.code,
      itemId: u.item_id,
      unitId: w.unitId,
    })),
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    items: rows.map((row) => ({ item: itemRecord(row, viewer), board: boards.get(row.id) ?? [] })),
    units: unitRows.flatMap((u) => {
      const item = byId.get(u.item_id);
      return item ? [unitRecord(u, item, viewer)] : [];
    }),
    warnings,
  };
}

/**
 * Each item's whole board as items.assignments.get answers it, from what tripItems read:
 * its counter, its rows and the board checks on its vehicles.
 */
export function itemBoards(trip: Pick<TripItems, 'items' | 'warnings'>): BoardRecord[] {
  return trip.items.map(({ item, board }) => ({
    itemId: item.id,
    boardVersion: item.boardVersion,
    allocations: board,
    warnings: trip.warnings
      .filter((w) => w.itemId === item.id)
      .map(({ code, unitId }) => ({ code, unitId })),
  }));
}
