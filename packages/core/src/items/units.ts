// The units of an item (rooms of a lodging, vehicles of a ground rental) and the item's
// assignment board. Units and allocations are the items module's tables, so they are
// written here, beside the item service, on the same acting-editor and lock helpers.
import {
  decodeTypeId,
  ID_PREFIX,
  ItemBoardInput,
  NoBody,
  UnitInput,
  UnitPatch,
  type MaskedValue,
  type PageQuery,
} from '@tribo/contract';
import { forModule, type DB, type ValueOf } from '@tribo/db';
import {
  ApiError,
  encodeCursor,
  type RequestContext,
  type Tx,
  type WritePath,
} from '@tribo/platform';
import type { Kysely } from 'kysely';
import {
  allActiveMemberships,
  licensedMemberships,
  type CallerMembership,
} from '../trips/service.js';
import { writeOperation } from '../write-operation.js';
import {
  actingEditor,
  boardSnapshot,
  idCursor,
  invalid,
  lockedItem,
  moneyView,
  visibleItem,
  type ActingEditor,
} from './acting.js';
import { boardRefusal, boardWarnings, type BoardWarning } from './board-rules.js';
import { canListUnit, canManageBoard, canReadBoard } from './policy.js';
import {
  bumpBoardVersion,
  countSeated,
  deleteUnitAllocations,
  findUnit,
  findUnitItemId,
  insertUnit,
  itemUnits,
  listBoard,
  listUnits,
  lockItem,
  lockUnit,
  occupiedElsewhere,
  replaceBoardRows,
  softDeleteUnit,
  updateUnit,
  type ItemRow,
  type NewAllocation,
  type UnitRow,
} from './repo.js';

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

/** One row of an item's assignment board. */
export interface AllocationRecord {
  membershipId: string;
  role: ValueOf<'tribo.allocations.role'>;
  unitId: string | null;
  rsvp: ValueOf<'tribo.allocations.rsvp'> | null;
}

/** The whole board as items.assignments.get and .replace answer it. */
export interface BoardRecord {
  itemId: string;
  boardVersion: number;
  allocations: AllocationRecord[];
  warnings: BoardWarning[];
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
  /** units.update: merge-patches the unit under If-Match = its version. */
  update(
    ctx: RequestContext,
    unitId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<UnitRecord>;
  /**
   * units.delete: soft-deletes the unit under If-Match and deletes its allocations, which
   * changes the item's board: that write bumps boardVersion and records its own snapshot.
   */
  delete(
    ctx: RequestContext,
    unitId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<void>;
  /** items.assignments.get: the whole board; not_found unless tribo.item_visible lets the caller see it. */
  board(userId: string, itemId: string): Promise<BoardRecord>;
  /**
   * items.assignments.replace: saves the whole board under If-Match = boardVersion, checking
   * the final state; advisory problems come back in warnings, never as refusals.
   */
  replaceBoard(
    ctx: RequestContext,
    itemId: string,
    body: unknown,
    ifMatch: number | undefined,
  ): Promise<BoardRecord>;
}

/** The one kind of unit each item type takes; other types have none. */
const UNIT_KIND: Partial<Record<ValueOf<'tribo.items.type'>, ValueOf<'tribo.units.kind'>>> = {
  lodging: 'room',
  ground: 'vehicle',
};

const unitsCreate = writeOperation('units.create', UnitInput);
const unitsUpdate = writeOperation('units.update', UnitPatch);
const unitsDelete = writeOperation('units.delete', NoBody);
const boardReplace = writeOperation('items.assignments.replace', ItemBoardInput);

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

    async board(userId, itemId) {
      const { row: item, viewer } = await visibleItem(db, userId, itemId);
      if (!canReadBoard(viewer.role)) throw new ApiError('forbidden');
      const items = forModule(db, 'items');
      return boardRecord(db, item, await itemUnits(items, item.id, { lock: false }), {
        boardVersion: item.board_version,
        rows: await listBoard(items, item.id),
      });
    },

    replaceBoard(ctx, itemId, body, ifMatch) {
      return write(ctx, {
        operation: boardReplace,
        target: { itemId },
        body,
        ifMatch,
        authorize: async (tx, c, target) => {
          const acting = await actingEditor(tx, c, target.itemId);
          if (!canManageBoard(acting.editor)) throw new ApiError('forbidden');
          return acting;
        },
        // The item, then its units, locked until commit: the counter is the board's, and
        // no concurrent save or unit edit moves what the final-state check relies on.
        load: async (tx, target) => {
          const { tripId, row } = await lockedItem(tx, target);
          const units = await itemUnits(forModule(tx, 'items'), row.id, { lock: true });
          return { tripId, counter: row.board_version, row, units };
        },
        mutate: async (tx, _c, { row: item, units }, input, acting) => {
          const { userId } = acting;
          const rows = input.allocations.map((a): NewAllocation => ({
            membershipId: decodeTypeId(ID_PREFIX.membership, a.membershipId),
            role: a.role,
            unitId: a.unitId == null ? null : decodeTypeId(ID_PREFIX.unit, a.unitId),
            rsvp: a.role === 'attendee' ? (a.rsvp ?? 'pending') : null,
          }));
          await checkMemberships(tx, item.trip_id, rows);
          const refusal = boardRefusal(units.map(boardUnit), rows);
          if (refusal?.code === 'validation_failed') throw invalid(refusal.path, refusal.message);
          if (refusal) throw new ApiError(refusal.code);
          const items = forModule(tx, 'items');
          const occupants = rows.filter((r) => r.role === 'occupant').map((r) => r.membershipId);
          if (
            await occupiedElsewhere(items, { userId, itemId: item.id, membershipIds: occupants })
          ) {
            throw new ApiError('room_double_booked');
          }
          await replaceBoardRows(items, {
            tripId: item.trip_id,
            itemId: item.id,
            rows,
            createdBy: userId,
          });
          const boardVersion = await bumpBoardVersion(items, item.id);
          const stored = await listBoard(items, item.id);
          return {
            action: 'update',
            aggregate: 'item_board',
            entityId: item.id,
            tripId: item.trip_id,
            version: boardVersion,
            snapshot: boardSnapshot(stored),
            result: await boardRecord(tx, item, units, { boardVersion, rows: stored }),
          };
        },
      });
    },

    create(ctx, itemId, body) {
      return write(ctx, {
        operation: unitsCreate,
        target: { itemId },
        body,
        ifMatch: undefined,
        authorize: async (tx, c, target) => {
          const acting = await actingEditor(tx, c, target.itemId);
          if (!canManageBoard(acting.editor)) throw new ApiError('forbidden');
          return acting;
        },
        // The item stays live until the unit is in; a new unit has no counter yet.
        load: async (tx, target) => {
          const { tripId, row } = await lockedItem(tx, target);
          return { tripId, row };
        },
        mutate: async (tx, _c, { row: item }, input, acting) => {
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

    update(ctx, unitId, body, ifMatch) {
      return write(ctx, {
        operation: unitsUpdate,
        target: { unitId },
        body,
        ifMatch,
        authorize: (tx, c, target) => actingOnUnit(tx, c, target.unitId),
        load: lockedUnit,
        mutate: async (tx, _c, { item, unit }, patch, acting) => {
          const { userId, membership } = acting;
          if (unit.kind === 'vehicle' && patch.bedType != null) {
            throw invalid('/bedType', 'a vehicle has no bed type');
          }
          const items = forModule(tx, 'items');
          // Allocations take the item lock lockedUnit holds, so the count stays true to commit.
          if (
            patch.capacity !== undefined &&
            patch.capacity < (await countSeated(items, unit.id))
          ) {
            throw new ApiError('capacity_exceeded');
          }
          const { rate } = patch;
          await uniqueLabel(() =>
            updateUnit(
              items,
              unit.id,
              {
                ...(patch.label === undefined ? {} : { label: patch.label }),
                ...(patch.capacity === undefined ? {} : { capacity: patch.capacity }),
                ...(patch.bedType === undefined ? {} : { bedType: patch.bedType }),
                ...(rate === undefined ? {} : { rate: unmaskedRate(rate) }),
                ...(patch.position === undefined ? {} : { position: patch.position }),
              },
              userId,
            ),
          );
          const row = await findUnit(items, unit.id);
          if (!row) throw new Error(`unit ${unit.id} vanished inside its own write`);
          return {
            action: 'update',
            aggregate: 'unit',
            entityId: unit.id,
            tripId: item.trip_id,
            version: row.version,
            snapshot: unitSnapshot(row),
            result: unitRecord(row, item, membership),
          };
        },
      });
    },

    delete(ctx, unitId, body, ifMatch) {
      return write(ctx, {
        operation: unitsDelete,
        target: { unitId },
        body,
        ifMatch,
        authorize: (tx, c, target) => actingOnUnit(tx, c, target.unitId),
        load: lockedUnit,
        mutate: async (tx, _c, { item, unit }, _input, acting) => {
          const items = forModule(tx, 'items');
          const version = await softDeleteUnit(items, unit.id, acting.userId);
          await deleteUnitAllocations(items, unit.id);
          const boardVersion = await bumpBoardVersion(items, item.id);
          return {
            action: 'delete',
            aggregate: 'unit',
            entityId: unit.id,
            tripId: item.trip_id,
            version,
            // The unit as it was: restore copies this snapshot forward.
            snapshot: unitSnapshot(unit),
            result: undefined,
            related: [
              {
                action: 'update',
                aggregate: 'item_board',
                entityId: item.id,
                tripId: item.trip_id,
                versionBefore: item.board_version,
                version: boardVersion,
                snapshot: boardSnapshot(await listBoard(items, item.id)),
              },
            ],
          };
        },
      });
    },
  };
}

/**
 * Who is acting on a unit: the editor of its item, who must manage the item's units. A unit
 * that is deleted, or whose item the caller cannot see, does not exist for them.
 */
async function actingOnUnit(tx: Tx, ctx: RequestContext, unitId: string): Promise<ActingEditor> {
  const itemId = await findUnitItemId(forModule(tx, 'items'), unitId);
  if (itemId === undefined) throw new ApiError('not_found');
  const acting = await actingEditor(tx, ctx, itemId);
  if (!canManageBoard(acting.editor)) throw new ApiError('forbidden');
  return acting;
}

/**
 * The write path's load for one unit: its item, then the unit, both locked until commit.
 * Board saves lock in the same order, so the two never deadlock.
 */
async function lockedUnit(tx: Tx, target: { unitId: string }) {
  const items = forModule(tx, 'items');
  const itemId = await findUnitItemId(items, target.unitId);
  const item = itemId === undefined ? undefined : await lockItem(items, itemId);
  const unit = item ? await lockUnit(items, target.unitId) : undefined;
  if (!item || !unit) throw new ApiError('not_found');
  return { tripId: item.trip_id, counter: unit.version, item, unit };
}

/** A rate as written, refusing the masked rendering a read showed in its place. */
function unmaskedRate<T extends object>(rate: T | MaskedValue | null): T | null {
  if (rate !== null && 'masked' in rate) throw new ApiError('masked_field_write');
  return rate;
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

/**
 * Every row names an active membership of the item's trip: one of another trip, or one
 * removed, is refused at the first row that names it.
 */
async function checkMemberships(
  tx: Tx,
  tripId: string,
  rows: readonly NewAllocation[],
): Promise<void> {
  const ids = rows.map((r) => r.membershipId);
  if (await allActiveMemberships(tx, tripId, ids)) return;
  for (const [i, id] of ids.entries()) {
    // eslint-disable-next-line no-await-in-loop -- only after the set failed, to name the row
    if (!(await allActiveMemberships(tx, tripId, [id]))) {
      throw invalid(`/allocations/${String(i)}/membershipId`, 'not a member of this trip');
    }
  }
}

function boardUnit(u: UnitRow) {
  return { id: u.id, kind: u.kind as UnitRecord['kind'], capacity: u.capacity };
}

/** The board at one version, with the advisory checks on it. */
async function boardRecord(
  db: Kysely<DB>,
  item: ItemRow,
  units: readonly UnitRow[],
  board: { boardVersion: number; rows: Awaited<ReturnType<typeof listBoard>> },
): Promise<BoardRecord> {
  const allocations = board.rows.map((r) => ({
    membershipId: r.membership_id,
    role: r.role as AllocationRecord['role'],
    unitId: r.unit_id,
    rsvp: r.rsvp as AllocationRecord['rsvp'],
  }));
  const drivers = allocations.filter((a) => a.role === 'driver').map((a) => a.membershipId);
  return {
    itemId: item.id,
    boardVersion: board.boardVersion,
    allocations,
    warnings: boardWarnings(
      units.map(boardUnit),
      allocations,
      await licensedMemberships(db, item.trip_id, drivers),
    ),
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
