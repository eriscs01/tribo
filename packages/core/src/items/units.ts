// The units of an item (rooms of a lodging, vehicles of a ground rental) and the item's
// assignment board. Units and allocations are the items module's tables, so they are
// written here, beside the item service, on the same acting-editor and lock helpers.
import { type PageQuery } from '@tribo/contract';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import { ApiError, encodeCursor, type WritePath } from '@tribo/platform';
import type { Kysely } from 'kysely';
import type { CallerMembership } from '../trips/service.js';
import { idCursor, moneyView, visibleItem } from './acting.js';
import { canListUnit } from './policy.js';
import { listUnits, type ItemRow, type UnitRow } from './repo.js';

export interface UnitRecord {
  id: string;
  itemId: string;
  kind: ValueOf<'tribo.units.kind'>;
  label: string;
  capacity: number;
  bedType: string | null;
  /** Nightly or per-day; 'masked' where the item's cost is (moneyView). */
  rate: { amountMinor: number; currency: string } | 'masked' | null;
  position: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UnitsService {
  /** units.list: the item's live units; not_found unless tribo.item_visible lets the caller see it. */
  list(
    userId: string,
    itemId: string,
    query: PageQuery,
  ): Promise<{ items: UnitRecord[]; nextCursor: string | null }>;
}

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createUnitsService(db: Kysely<DB>, _write: WritePath): UnitsService {
  return {
    async list(userId, itemId, query) {
      const { row: item, viewer } = await visibleItem(db, userId, itemId);
      if (!canListUnit(viewer.role)) throw new ApiError('forbidden');
      // One extra row says whether another page follows.
      const rows = await listUnits(forModule(db, 'items'), itemId, {
        limit: query.limit + 1,
        after: query.cursor === undefined ? null : idCursor(query.cursor),
      });
      const units = rows.slice(0, query.limit).map((row) => unitRecord(row, item, viewer));
      const last = units.at(-1);
      return {
        items: units,
        nextCursor: rows.length > query.limit && last ? encodeCursor([last.id]) : null,
      };
    },
  };
}

/** The unit as this caller reads it: the one serializer every unit read goes through. */
function unitRecord(
  row: UnitRow,
  item: ItemRow,
  viewer: Pick<CallerMembership, 'id' | 'role' | 'canViewCosts'>,
): UnitRecord {
  const stored =
    row.rate_minor === null || row.rate_currency === null
      ? null
      : { amountMinor: Number(row.rate_minor), currency: row.rate_currency };
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind as UnitRecord['kind'],
    label: row.label,
    capacity: row.capacity,
    bedType: row.bed_type,
    rate: moneyView(item, viewer, stored),
    position: row.position,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
