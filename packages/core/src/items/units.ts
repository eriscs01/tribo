// The units of an item (rooms of a lodging, vehicles of a ground rental) and the item's
// assignment board. Units and allocations are the items module's tables, so they are
// written here, beside the item service, on the same acting-editor and lock helpers.
import { UnitInput, type PageQuery } from '@tribo/contract';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import { ApiError, encodeCursor, type RequestContext, type WritePath } from '@tribo/platform';
import type { Kysely } from 'kysely';
import type { CallerMembership } from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import {
  actingEditor,
  idCursor,
  invalid,
  lockedItem,
  moneyView,
  visibleItem,
  type ActingEditor,
} from './acting.js';
import { canListUnit, canManageBoard } from './policy.js';
import { findUnit, insertUnit, listUnits, type ItemRow, type UnitRow } from './repo.js';

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
  /** units.create: a room on a lodging or a vehicle on a ground rental. */
  create(ctx: RequestContext, itemId: string, body: unknown): Promise<UnitRecord>;
}

/** The one kind of unit each item type takes; other types have none. */
const UNIT_KIND: Partial<Record<ValueOf<'tribo.items.type'>, ValueOf<'tribo.units.kind'>>> = {
  lodging: 'room',
  ground: 'vehicle',
};

const unitsCreate = writeOperation('units.create', UnitInput);

/** `write` is core's write path (writePath in write-path.ts), passed in to keep imports acyclic. */
export function createUnitsService(db: Kysely<DB>, write: WritePath): UnitsService {
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

    create(ctx, itemId, body) {
      let acting: ActingEditor | undefined;
      return write(ctx, {
        operation: unitsCreate,
        target: { itemId },
        body,
        ifMatch: undefined,
        authorize: async (tx, c, target) => {
          acting = await actingEditor(tx, c, target.itemId);
          if (!canManageBoard(acting.editor)) throw new ApiError('forbidden');
        },
        // The item stays live until the unit is in; a new unit has no counter yet.
        load: async (tx, target) => {
          const { tripId, row } = await lockedItem(tx, target);
          return { tripId, row };
        },
        mutate: async (tx, _c, { row: item }, input) => {
          if (!acting) throw new Error('units.create mutated before authorize');
          const { userId, membership } = acting;
          if (UNIT_KIND[item.type as ValueOf<'tribo.items.type'>] !== input.kind) {
            throw invalid('/kind', `a ${item.type} item has no ${input.kind}s`);
          }
          const items = forModule(tx, 'items');
          const unitId = await uniqueLabel(() =>
            insertUnit(items, {
              itemId: item.id,
              kind: input.kind,
              label: input.label,
              capacity: input.capacity,
              bedType: input.bedType ?? null,
              rate: input.rate ?? null,
              position: input.position ?? 0,
              createdBy: userId,
            }),
          );
          const row = await findUnit(items, unitId);
          if (!row) throw new Error(`unit ${unitId} vanished inside its own write`);
          return {
            action: 'create',
            aggregate: 'unit',
            entityId: unitId,
            tripId: item.trip_id,
            version: row.version,
            snapshot: unitSnapshot(row),
            result: unitRecord(row, item, membership),
          };
        },
      });
    },
  };
}

/** A label another live unit of the item holds is the caller's to change, not a conflict. */
async function uniqueLabel<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (
      error instanceof Error &&
      'constraint' in error &&
      error.constraint === 'units_item_label_key'
    ) {
      throw invalid('/label', 'another unit of this item has this label');
    }
    throw error;
  }
}

/** Every stored field of the unit (Audit and versioning). */
function unitSnapshot(row: UnitRow) {
  return {
    itemId: row.item_id,
    kind: row.kind,
    label: row.label,
    capacity: row.capacity,
    bedType: row.bed_type,
    rate:
      row.rate_minor === null
        ? null
        : { amountMinor: Number(row.rate_minor), currency: row.rate_currency },
    position: row.position,
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
